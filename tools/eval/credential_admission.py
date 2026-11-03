"""Durable admission for new evaluations; never cancels an in-flight owner."""
import asyncio
import hashlib
import json
import sqlite3
import time
from pathlib import Path


class CredentialAdmission:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS credential_blocks (
                    fingerprint TEXT PRIMARY KEY, run_id TEXT NOT NULL,
                    reason TEXT NOT NULL, evidence_json TEXT NOT NULL,
                    blocked_at REAL NOT NULL, recovered_at REAL,
                    recovery_ref TEXT
                );
                CREATE TABLE IF NOT EXISTS completed_admissions (
                    run_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
                    quota_confirmed INTEGER NOT NULL, finished_at REAL NOT NULL
                );
            """)
        self.path.chmod(0o600)

    def _connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        db.row_factory = sqlite3.Row
        return db

    @staticmethod
    def fingerprint(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def check_admission(self, fingerprint):
        with self._connect() as db:
            row = db.execute(
                "SELECT run_id, reason, blocked_at FROM credential_blocks "
                "WHERE fingerprint=? AND recovered_at IS NULL", (fingerprint,)
            ).fetchone()
        if row is None:
            return {"allowed": True, "reason": "available"}
        return {"allowed": False, "reason": row["reason"],
                "sourceRunId": row["run_id"], "blockedAt": row["blocked_at"]}

    def finish(self, fingerprint, run_id, diagnostics):
        """Idempotently block only an explicitly confirmed hard quota result."""
        if not isinstance(run_id, str) or not run_id:
            raise ValueError("A completed run identity is required")
        if not isinstance(diagnostics, dict):
            diagnostics = {}
        refs = diagnostics.get("quotaEvidenceRefs")
        confirmed = diagnostics.get("providerQuotaExhausted") is True and isinstance(refs, list) and bool(refs)
        # Save only metadata references, never arbitrary error messages or secrets.
        evidence = [{k: ref[k] for k in ("eventIndex", "eventId", "role", "origin") if k in ref}
                    for ref in refs if isinstance(ref, dict)] if confirmed else []
        confirmed = confirmed and bool(evidence)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            prior = db.execute("SELECT fingerprint FROM completed_admissions WHERE run_id=?", (run_id,)).fetchone()
            if prior is not None:
                if prior["fingerprint"] != fingerprint:
                    raise ValueError("A completed run cannot change credential ownership")
                return self.check_admission(fingerprint)
            now = time.time()
            db.execute("INSERT INTO completed_admissions VALUES(?,?,?,?)", (run_id, fingerprint, int(confirmed), now))
            if confirmed:
                db.execute("""INSERT INTO credential_blocks VALUES(?,?,?,?,?,NULL,NULL)
                    ON CONFLICT(fingerprint) DO UPDATE SET
                    run_id=excluded.run_id, reason=excluded.reason,
                    evidence_json=excluded.evidence_json, blocked_at=excluded.blocked_at,
                    recovered_at=NULL, recovery_ref=NULL""",
                    (fingerprint, run_id, "provider_quota_exhausted", json.dumps(evidence), now))
        return self.check_admission(fingerprint)

    def recover_after_successful_probe(self, fingerprint, *, status, probe_ref):
        """Explicit recovery only; elapsed time is not proof of renewed quota."""
        if status != 200 or not isinstance(probe_ref, str) or not probe_ref.strip():
            raise ValueError("Recovery requires a successful credential-specific probe reference")
        with self._connect() as db:
            db.execute("UPDATE credential_blocks SET recovered_at=?, recovery_ref=? "
                       "WHERE fingerprint=? AND recovered_at IS NULL", (time.time(), probe_ref, fingerprint))
        return self.check_admission(fingerprint)


class AdmittedQueue:
    """Check a lane before removing work from the shared pending queue."""
    def __init__(self, queue, admitted):
        self.queue = queue
        self.admitted = admitted

    def empty(self):
        return not self.admitted() or self.queue.empty()

    def get_nowait(self):
        if not self.admitted():
            raise asyncio.QueueEmpty
        return self.queue.get_nowait()

    def task_done(self):
        self.queue.task_done()
