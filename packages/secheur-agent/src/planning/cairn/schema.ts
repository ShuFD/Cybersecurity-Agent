/** Adapted from sxd-git1/cairnpilot b015733fa117aa35f2406b8b31fd1bbf84d3ec6e.
 * Apache-2.0; see vendor/cairnpilot/LICENSE and NOTICE.md. */
import type { ChallengeGoalState, GraphEvent, GraphFact, GraphHint, GraphIntent } from "./types.ts";

export const GRAPH_SCHEMA_VERSION = 6;

export const GRAPH_SCHEMA_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS intents (
    id TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    scope TEXT NOT NULL,
    capability_tags_json TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL,
    outcome TEXT,
    owner_solver_id TEXT,
    lease_until TEXT,
    attempt_count INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (challenge_id, id),
    UNIQUE (challenge_id, fingerprint),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS facts (
    id TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    statement TEXT NOT NULL,
    source_solver_id TEXT,
    produced_by_intent_id TEXT,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'invalidated')),
    invalidated_by_fact_id TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (challenge_id, id),
    UNIQUE (challenge_id, fingerprint),
    CHECK (
        (status = 'active' AND invalidated_by_fact_id IS NULL)
        OR (status = 'invalidated' AND invalidated_by_fact_id IS NOT NULL)
    ),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, produced_by_intent_id) REFERENCES intents(challenge_id, id),
    FOREIGN KEY (challenge_id, invalidated_by_fact_id) REFERENCES facts(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS fact_evidence (
    challenge_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    evidence_ref TEXT NOT NULL,
    PRIMARY KEY (challenge_id, fact_id, evidence_ref),
    FOREIGN KEY (challenge_id, fact_id) REFERENCES facts(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_memory_sources (
    challenge_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, fact_id, memory_id),
    FOREIGN KEY (challenge_id, fact_id) REFERENCES facts(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
    id TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (challenge_id, id),
    UNIQUE (challenge_id, fingerprint),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hint_memory_sources (
    challenge_id TEXT NOT NULL,
    hint_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, hint_id, memory_id),
    FOREIGN KEY (challenge_id, hint_id) REFERENCES hints(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intent_idea_sources (
    challenge_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    idea_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, intent_id, idea_id),
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intent_sources (
    challenge_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, intent_id, fact_id),
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, fact_id) REFERENCES facts(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS intent_hint_sources (
    challenge_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    hint_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, intent_id, hint_id),
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, hint_id) REFERENCES hints(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS intent_results (
    challenge_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, intent_id, fact_id),
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, fact_id) REFERENCES facts(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS shadow_current_entities (
    challenge_id TEXT NOT NULL,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('fact', 'hint', 'intent')),
    entity_id TEXT NOT NULL,
    snapshot_fingerprint TEXT NOT NULL,
    PRIMARY KEY (challenge_id, entity_type, entity_id),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shadow_snapshots (
    challenge_id TEXT PRIMARY KEY,
    snapshot_fingerprint TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS challenge_goal_states (
    challenge_id TEXT PRIMARY KEY,
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    flag_count INTEGER,
    solved_flag_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS graph_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    challenge_id TEXT NOT NULL,
    type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS facts_core_fields_immutable
BEFORE UPDATE OF id, challenge_id, kind, statement, source_solver_id, produced_by_intent_id, fingerprint, observed_at, created_at
ON facts
BEGIN
    SELECT RAISE(ABORT, 'fact core fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS facts_status_transition
BEFORE UPDATE OF status, invalidated_by_fact_id ON facts
BEGIN
    SELECT CASE
        WHEN OLD.status != 'active' OR NEW.status != 'invalidated'
        THEN RAISE(ABORT, 'fact status only allows active to invalidated')
    END;
    SELECT CASE
        WHEN NEW.invalidated_by_fact_id IS NULL
        THEN RAISE(ABORT, 'invalidated fact requires invalidatedByFactId')
    END;
    SELECT CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM facts replacement
            WHERE replacement.challenge_id = NEW.challenge_id
              AND replacement.id = NEW.invalidated_by_fact_id
              AND replacement.status = 'active'
              AND replacement.id != NEW.id
        )
        THEN RAISE(ABORT, 'replacement fact must be active in the same challenge')
    END;
END;

CREATE TRIGGER IF NOT EXISTS facts_invalidated_insert
BEFORE INSERT ON facts
WHEN NEW.status = 'invalidated'
BEGIN
    SELECT CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM facts replacement
            WHERE replacement.challenge_id = NEW.challenge_id
              AND replacement.id = NEW.invalidated_by_fact_id
              AND replacement.status = 'active'
              AND replacement.id != NEW.id
        )
        THEN RAISE(ABORT, 'replacement fact must be active in the same challenge')
    END;
END;

CREATE TRIGGER IF NOT EXISTS fact_evidence_immutable_update
BEFORE UPDATE ON fact_evidence
BEGIN
    SELECT RAISE(ABORT, 'fact evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS fact_evidence_immutable_delete
BEFORE DELETE ON fact_evidence
BEGIN
    SELECT RAISE(ABORT, 'fact evidence is append-only');
END;

CREATE TRIGGER IF NOT EXISTS shadow_current_entity_owner
BEFORE INSERT ON shadow_current_entities
BEGIN
    SELECT CASE
        WHEN NEW.entity_type = 'fact' AND NOT EXISTS (
            SELECT 1 FROM facts WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current fact is not owned by challenge')
        WHEN NEW.entity_type = 'hint' AND NOT EXISTS (
            SELECT 1 FROM hints WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current hint is not owned by challenge')
        WHEN NEW.entity_type = 'intent' AND NOT EXISTS (
            SELECT 1 FROM intents WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current intent is not owned by challenge')
    END;
END;

CREATE TRIGGER IF NOT EXISTS shadow_current_entity_owner_update
BEFORE UPDATE ON shadow_current_entities
BEGIN
    SELECT CASE
        WHEN NEW.entity_type = 'fact' AND NOT EXISTS (
            SELECT 1 FROM facts WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current fact is not owned by challenge')
        WHEN NEW.entity_type = 'hint' AND NOT EXISTS (
            SELECT 1 FROM hints WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current hint is not owned by challenge')
        WHEN NEW.entity_type = 'intent' AND NOT EXISTS (
            SELECT 1 FROM intents WHERE id = NEW.entity_id AND challenge_id = NEW.challenge_id
        ) THEN RAISE(ABORT, 'current intent is not owned by challenge')
    END;
END;

CREATE TRIGGER IF NOT EXISTS graph_events_immutable_update
BEFORE UPDATE ON graph_events
BEGIN
    SELECT RAISE(ABORT, 'graph events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS graph_events_immutable_delete
BEFORE DELETE ON graph_events
BEGIN
    SELECT RAISE(ABORT, 'graph events are append-only');
END;
`;

export const GRAPH_SCHEMA_V2_SQL = `
CREATE TABLE IF NOT EXISTS fact_candidates (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    statement TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    evidence_refs_json TEXT NOT NULL,
    source_event_ids_json TEXT NOT NULL,
    source_actor_id TEXT NOT NULL,
    source_role TEXT NOT NULL CHECK (source_role IN ('host', 'solver', 'observer')),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'merged')),
    result_fact_id TEXT,
    merged_into_candidate_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (challenge_id, id),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, result_fact_id) REFERENCES facts(challenge_id, id),
    FOREIGN KEY (challenge_id, merged_into_candidate_id) REFERENCES fact_candidates(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS intent_candidates (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    scope TEXT NOT NULL,
    confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    from_fact_ids_json TEXT NOT NULL,
    source_hint_ids_json TEXT NOT NULL,
    capability_tags_json TEXT NOT NULL,
    source_event_ids_json TEXT NOT NULL,
    source_actor_id TEXT NOT NULL,
    source_role TEXT NOT NULL CHECK (source_role IN ('host', 'solver', 'observer')),
    status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected', 'merged')),
    result_intent_id TEXT,
    merged_into_candidate_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (challenge_id, id),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, result_intent_id) REFERENCES intents(challenge_id, id),
    FOREIGN KEY (challenge_id, merged_into_candidate_id) REFERENCES intent_candidates(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    solver_id TEXT NOT NULL,
    intent_id TEXT,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (challenge_id, path),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    challenge_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (challenge_id, operation, idempotency_key),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fact_candidates_challenge_status
ON fact_candidates(challenge_id, status, created_at);

CREATE INDEX IF NOT EXISTS intent_candidates_challenge_status
ON intent_candidates(challenge_id, status, created_at);

CREATE INDEX IF NOT EXISTS artifacts_challenge
ON artifacts(challenge_id, created_at);
`;

export const GRAPH_SCHEMA_V3_SQL = `
CREATE TABLE IF NOT EXISTS graph_solvers (
    solver_id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    UNIQUE (challenge_id, solver_id)
);

CREATE TABLE IF NOT EXISTS intent_claims (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    solver_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    lease_until TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'concluded', 'cancelled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (challenge_id, intent_id, generation),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id),
    FOREIGN KEY (challenge_id, solver_id) REFERENCES graph_solvers(challenge_id, solver_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS intent_claims_one_active_intent
ON intent_claims(challenge_id, intent_id) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS intent_claims_one_active_solver
ON intent_claims(solver_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS intent_claims_expiry
ON intent_claims(status, lease_until);

CREATE TRIGGER IF NOT EXISTS intent_claim_generation_monotonic
BEFORE INSERT ON intent_claims
BEGIN
    SELECT CASE WHEN NEW.generation != COALESCE((
        SELECT MAX(generation) + 1 FROM intent_claims
        WHERE challenge_id = NEW.challenge_id AND intent_id = NEW.intent_id
    ), 1) THEN RAISE(ABORT, 'claim generation must increase monotonically') END;
END;

CREATE TRIGGER IF NOT EXISTS intent_claim_identity_immutable
BEFORE UPDATE OF id, challenge_id, intent_id, solver_id, token_hash, generation, created_at
ON intent_claims
BEGIN
    SELECT RAISE(ABORT, 'claim identity fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS intent_claim_closed_is_terminal
BEFORE UPDATE OF status ON intent_claims
WHEN OLD.status != 'active'
BEGIN
    SELECT RAISE(ABORT, 'closed claim status is terminal');
END;

CREATE TRIGGER IF NOT EXISTS intent_claim_active_matches_intent
BEFORE INSERT ON intent_claims
WHEN NEW.status = 'active'
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM intents
        WHERE challenge_id = NEW.challenge_id
          AND id = NEW.intent_id
          AND status = 'claimed'
          AND owner_solver_id = NEW.solver_id
          AND lease_until = NEW.lease_until
    ) THEN RAISE(ABORT, 'active claim must match claimed intent owner and lease') END;
END;
`;

export const GRAPH_SCHEMA_V4_SQL = `
CREATE TABLE IF NOT EXISTS reason_triggers (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('fact_confirmed', 'fact_invalidated', 'hint_added', 'intent_concluded', 'no_active_intents', 'initial_reason')),
    source_event_sequence INTEGER NOT NULL CHECK (source_event_sequence >= 0),
    source_entity_id TEXT NOT NULL,
    payload_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    not_before TEXT NOT NULL,
    lease_generation INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE (challenge_id, reason, source_event_sequence, source_entity_id, payload_fingerprint),
    UNIQUE (challenge_id, id),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE,
    FOREIGN KEY (source_event_sequence) REFERENCES graph_events(sequence)
);

CREATE TABLE IF NOT EXISTS reason_leases (
    challenge_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    token_hash TEXT NOT NULL,
    lease_until TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (challenge_id, generation),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS reason_leases_one_active_challenge
ON reason_leases(challenge_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS reason_triggers_pending_order
ON reason_triggers(challenge_id, status, not_before, source_event_sequence, id);

CREATE INDEX IF NOT EXISTS reason_leases_expiry
ON reason_leases(status, lease_until);

CREATE TRIGGER IF NOT EXISTS reason_lease_generation_monotonic
BEFORE INSERT ON reason_leases
BEGIN
    SELECT CASE WHEN NEW.generation != COALESCE((
        SELECT MAX(generation) + 1 FROM reason_leases WHERE challenge_id = NEW.challenge_id
    ), 1) THEN RAISE(ABORT, 'reason lease generation must increase monotonically') END;
END;

CREATE TRIGGER IF NOT EXISTS reason_lease_identity_immutable
BEFORE UPDATE OF challenge_id, owner_id, generation, token_hash, created_at
ON reason_leases
BEGIN
    SELECT RAISE(ABORT, 'reason lease identity fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS reason_lease_closed_is_terminal
BEFORE UPDATE OF status ON reason_leases
WHEN OLD.status != 'active'
BEGIN
    SELECT RAISE(ABORT, 'closed reason lease status is terminal');
END;

CREATE TRIGGER IF NOT EXISTS reason_trigger_event_owner
BEFORE INSERT ON reason_triggers
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM graph_events
        WHERE sequence = NEW.source_event_sequence AND challenge_id = NEW.challenge_id
    ) THEN RAISE(ABORT, 'reason trigger source event belongs to another challenge') END;
END;
`;

export const GRAPH_SCHEMA_V5_SQL = `
CREATE TABLE IF NOT EXISTS reason_proposals (
    id TEXT PRIMARY KEY,
    challenge_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed', 'rejected', 'applied')),
    reason_lease_generation INTEGER NOT NULL CHECK (reason_lease_generation > 0),
    base_event_sequence INTEGER NOT NULL CHECK (base_event_sequence >= 0),
    context_fingerprint TEXT NOT NULL,
    rationale_summary TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (challenge_id, id),
    FOREIGN KEY (challenge_id) REFERENCES challenges(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_triggers (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, trigger_id),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposals(challenge_id, id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, trigger_id) REFERENCES reason_triggers(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS reason_proposal_intents (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    rationale TEXT NOT NULL,
    priority INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (challenge_id, proposal_id, ordinal),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposals(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_success_criteria (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_ordinal INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    criterion TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_ordinal, ordinal),
    FOREIGN KEY (challenge_id, proposal_id, intent_ordinal)
      REFERENCES reason_proposal_intents(challenge_id, proposal_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_capability_tags (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_ordinal INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_ordinal, tag),
    FOREIGN KEY (challenge_id, proposal_id, intent_ordinal)
      REFERENCES reason_proposal_intents(challenge_id, proposal_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_fact_refs (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_ordinal INTEGER NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_ordinal, fact_id),
    FOREIGN KEY (challenge_id, proposal_id, intent_ordinal)
      REFERENCES reason_proposal_intents(challenge_id, proposal_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_hint_refs (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_ordinal INTEGER NOT NULL,
    hint_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_ordinal, hint_id),
    FOREIGN KEY (challenge_id, proposal_id, intent_ordinal)
      REFERENCES reason_proposal_intents(challenge_id, proposal_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_intent_supersedes (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_ordinal INTEGER NOT NULL,
    intent_id TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_ordinal, intent_id),
    FOREIGN KEY (challenge_id, proposal_id, intent_ordinal)
      REFERENCES reason_proposal_intents(challenge_id, proposal_id, ordinal) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_supersede_recommendations (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    rationale TEXT NOT NULL,
    replacement_client_id TEXT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (challenge_id, proposal_id, ordinal),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposals(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_validation_errors (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    error TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, ordinal),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposals(challenge_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS reason_proposals_challenge_created
ON reason_proposals(challenge_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS reason_proposals_core_immutable
BEFORE UPDATE OF id, challenge_id, reason_lease_generation, base_event_sequence,
context_fingerprint, rationale_summary, model, provider, prompt_version, created_at
ON reason_proposals
BEGIN
    SELECT RAISE(ABORT, 'reason proposal core fields are immutable');
END;

CREATE TRIGGER IF NOT EXISTS reason_proposals_applied_reserved
BEFORE INSERT ON reason_proposals
WHEN NEW.status = 'applied'
BEGIN
    SELECT RAISE(ABORT, 'applied reason proposals are reserved for stage 4C');
END;

CREATE TRIGGER IF NOT EXISTS reason_proposals_applied_update_reserved
BEFORE UPDATE OF status ON reason_proposals
WHEN NEW.status = 'applied'
BEGIN
    SELECT RAISE(ABORT, 'applied reason proposals are reserved for stage 4C');
END;

CREATE TRIGGER IF NOT EXISTS reason_proposal_triggers_immutable_update
BEFORE UPDATE ON reason_proposal_triggers BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_triggers_immutable_delete
BEFORE DELETE ON reason_proposal_triggers BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intents_immutable_update
BEFORE UPDATE ON reason_proposal_intents BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intents_immutable_delete
BEFORE DELETE ON reason_proposal_intents BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_success_criteria_immutable_update
BEFORE UPDATE ON reason_proposal_success_criteria BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_success_criteria_immutable_delete
BEFORE DELETE ON reason_proposal_success_criteria BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_capability_tags_immutable_update
BEFORE UPDATE ON reason_proposal_capability_tags BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_capability_tags_immutable_delete
BEFORE DELETE ON reason_proposal_capability_tags BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_fact_refs_immutable_update
BEFORE UPDATE ON reason_proposal_fact_refs BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_fact_refs_immutable_delete
BEFORE DELETE ON reason_proposal_fact_refs BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_hint_refs_immutable_update
BEFORE UPDATE ON reason_proposal_hint_refs BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_hint_refs_immutable_delete
BEFORE DELETE ON reason_proposal_hint_refs BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intent_supersedes_immutable_update
BEFORE UPDATE ON reason_proposal_intent_supersedes BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intent_supersedes_immutable_delete
BEFORE DELETE ON reason_proposal_intent_supersedes BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_recommendations_immutable_update
BEFORE UPDATE ON reason_proposal_supersede_recommendations BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_recommendations_immutable_delete
BEFORE DELETE ON reason_proposal_supersede_recommendations BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_errors_immutable_update
BEFORE UPDATE ON reason_proposal_validation_errors BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_errors_immutable_delete
BEFORE DELETE ON reason_proposal_validation_errors BEGIN SELECT RAISE(ABORT, 'reason proposal content is immutable'); END;
`;

export const GRAPH_SCHEMA_V6_SQL = `
DROP TRIGGER IF EXISTS reason_proposals_applied_reserved;
DROP TRIGGER IF EXISTS reason_proposals_applied_update_reserved;

CREATE TRIGGER IF NOT EXISTS reason_proposals_applied_insert_forbidden
BEFORE INSERT ON reason_proposals
WHEN NEW.status = 'applied'
BEGIN
    SELECT RAISE(ABORT, 'reason proposal must be inserted as proposed or rejected');
END;

CREATE TABLE IF NOT EXISTS reason_proposal_applications (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('applied', 'no_op', 'rejected_stale')),
    applied_at TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    base_event_sequence INTEGER NOT NULL CHECK (base_event_sequence >= 0),
    applied_event_sequence INTEGER NOT NULL CHECK (applied_event_sequence >= 0),
    PRIMARY KEY (challenge_id, proposal_id),
    UNIQUE (challenge_id, idempotency_key),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposals(challenge_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reason_proposal_intent_results (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    intent_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('created', 'skipped_duplicate')),
    reason TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, client_id),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposal_applications(challenge_id, proposal_id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS reason_proposal_supersede_results (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    intent_id TEXT NOT NULL,
    replacement_intent_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('superseded', 'skipped')),
    reason TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, intent_id),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposal_applications(challenge_id, proposal_id) ON DELETE CASCADE,
    FOREIGN KEY (challenge_id, intent_id) REFERENCES intents(challenge_id, id),
    FOREIGN KEY (challenge_id, replacement_intent_id) REFERENCES intents(challenge_id, id)
);

CREATE TABLE IF NOT EXISTS reason_proposal_stale_reasons (
    challenge_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    reason TEXT NOT NULL,
    PRIMARY KEY (challenge_id, proposal_id, ordinal),
    FOREIGN KEY (challenge_id, proposal_id) REFERENCES reason_proposal_applications(challenge_id, proposal_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS reason_proposal_applications_proposed_only
BEFORE INSERT ON reason_proposal_applications
WHEN NOT EXISTS (
    SELECT 1 FROM reason_proposals
    WHERE challenge_id = NEW.challenge_id
      AND id = NEW.proposal_id
      AND status = 'proposed'
)
BEGIN
    SELECT RAISE(ABORT, 'reason proposal application requires a proposed proposal');
END;

CREATE TRIGGER IF NOT EXISTS reason_proposals_status_apply_only
BEFORE UPDATE OF status ON reason_proposals
WHEN NEW.status != OLD.status
BEGIN
    SELECT CASE
        WHEN NOT (OLD.status = 'proposed' AND NEW.status = 'applied')
        THEN RAISE(ABORT, 'reason proposal status can only change proposed to applied')
    END;
    SELECT CASE
        WHEN NOT EXISTS (
            SELECT 1 FROM reason_proposal_applications
            WHERE challenge_id = NEW.challenge_id
              AND proposal_id = NEW.id
              AND status IN ('applied', 'no_op')
        )
        THEN RAISE(ABORT, 'applied reason proposal requires an apply record')
    END;
END;

CREATE TRIGGER IF NOT EXISTS reason_proposal_applications_immutable_update
BEFORE UPDATE ON reason_proposal_applications BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_applications_immutable_delete
BEFORE DELETE ON reason_proposal_applications BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intent_results_immutable_update
BEFORE UPDATE ON reason_proposal_intent_results BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_intent_results_immutable_delete
BEFORE DELETE ON reason_proposal_intent_results BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_supersede_results_immutable_update
BEFORE UPDATE ON reason_proposal_supersede_results BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_supersede_results_immutable_delete
BEFORE DELETE ON reason_proposal_supersede_results BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_stale_reasons_immutable_update
BEFORE UPDATE ON reason_proposal_stale_reasons BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
CREATE TRIGGER IF NOT EXISTS reason_proposal_stale_reasons_immutable_delete
BEFORE DELETE ON reason_proposal_stale_reasons BEGIN SELECT RAISE(ABORT, 'reason proposal application is immutable'); END;
`;

export const GRAPH_SCHEMA_SQL = `${GRAPH_SCHEMA_V1_SQL}\n${GRAPH_SCHEMA_V2_SQL}\n${GRAPH_SCHEMA_V3_SQL}\n${GRAPH_SCHEMA_V4_SQL}\n${GRAPH_SCHEMA_V5_SQL}\n${GRAPH_SCHEMA_V6_SQL}`;

export interface FactRow {
	id: string;
	challenge_id: string;
	kind: GraphFact["kind"];
	statement: string;
	source_solver_id: string | null;
	produced_by_intent_id: string | null;
	fingerprint: string;
	status: GraphFact["status"];
	invalidated_by_fact_id: string | null;
	observed_at: string;
	created_at: string;
}

export interface HintRow {
	id: string;
	challenge_id: string;
	content: string;
	creator: string;
	fingerprint: string;
	created_at: string;
}

export interface IntentRow {
	id: string;
	challenge_id: string;
	objective: string;
	scope: string;
	capability_tags_json: string;
	priority: number;
	status: GraphIntent["status"];
	outcome: GraphIntent["outcome"] | null;
	owner_solver_id: string | null;
	lease_until: string | null;
	attempt_count: number;
	version: number;
	created_by: string;
	fingerprint: string;
	created_at: string;
	updated_at: string;
}

export interface EventRow {
	sequence: number;
	challenge_id: string;
	type: string;
	entity_id: string;
	actor_id: string;
	idempotency_key: string;
	payload_json: string;
	created_at: string;
}

export interface GoalStateRow {
	challenge_id: string;
	completed: number;
	flag_count: number | null;
	solved_flag_count: number;
	updated_at: string;
}

function parseStringArray(value: string): string[] {
	return JSON.parse(value) as string[];
}

export function graphFactFromRow(row: FactRow, evidenceRefs: string[], sourceMemoryIds: string[]): GraphFact {
	return {
		id: row.id,
		challengeId: row.challenge_id,
		kind: row.kind,
		statement: row.statement,
		evidenceRefs,
		sourceSolverId: row.source_solver_id ?? undefined,
		sourceMemoryIds,
		producedByIntentId: row.produced_by_intent_id ?? undefined,
		fingerprint: row.fingerprint,
		status: row.status,
		invalidatedByFactId: row.invalidated_by_fact_id ?? undefined,
		observedAt: row.observed_at,
		createdAt: row.created_at,
	};
}

export function graphHintFromRow(row: HintRow, sourceMemoryIds: string[]): GraphHint {
	return {
		id: row.id,
		challengeId: row.challenge_id,
		content: row.content,
		creator: row.creator,
		sourceMemoryIds,
		fingerprint: row.fingerprint,
		createdAt: row.created_at,
	};
}

export function graphIntentFromRow(
	row: IntentRow,
	fromFactIds: string[],
	sourceHintIds: string[],
	resultFactIds: string[],
	sourceIdeaIds: string[],
): GraphIntent {
	return {
		id: row.id,
		challengeId: row.challenge_id,
		fromFactIds,
		sourceHintIds,
		objective: row.objective,
		scope: row.scope,
		capabilityTags: parseStringArray(row.capability_tags_json),
		priority: row.priority,
		status: row.status,
		outcome: row.outcome ?? undefined,
		ownerSolverId: row.owner_solver_id ?? undefined,
		leaseUntil: row.lease_until ?? undefined,
		resultFactIds,
		attemptCount: row.attempt_count,
		version: row.version,
		createdBy: row.created_by,
		sourceIdeaIds,
		fingerprint: row.fingerprint,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function graphEventFromRow(row: EventRow): GraphEvent {
	return {
		sequence: row.sequence,
		challengeId: row.challenge_id,
		type: row.type,
		entityId: row.entity_id,
		actorId: row.actor_id,
		idempotencyKey: row.idempotency_key,
		payload: JSON.parse(row.payload_json) as unknown,
		createdAt: row.created_at,
	};
}

export function goalStateFromRow(row: GoalStateRow): ChallengeGoalState {
	return {
		challengeId: row.challenge_id,
		completed: row.completed === 1,
		flagCount: row.flag_count ?? undefined,
		solvedFlagCount: row.solved_flag_count,
		updatedAt: row.updated_at,
	};
}
