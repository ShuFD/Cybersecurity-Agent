#!/usr/bin/env bash
# Run as root on the Oracle host after the staged Python tests pass.
set -euo pipefail

stage=${1:?usage: deploy-oracle.sh /absolute/staging/directory}
[[ $EUID -eq 0 && $stage == /* ]] || { echo 'root and absolute staging path required' >&2; exit 2; }
for file in server.py sync_from_ctf_field.py secheur_verify_proxy.py; do
    [[ -f "$stage/$file" ]] || { echo "missing staged $file" >&2; exit 2; }
done

exec 9>/run/secheur-flag-oracle-deploy.lock
flock -n 9 || { echo 'Oracle deployment already running' >&2; exit 2; }

oracle_dir=/opt/secheur-flag-oracle
proxy_dir=/usr/local/lib/secheur-verify
db=/var/lib/secheur-flag-oracle/oracle.sqlite3
python=$oracle_dir/venv/bin/python
backup=/root/secheur-flag-oracle-backup-$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$backup"
cp -a "$oracle_dir/server.py" "$oracle_dir/sync_from_ctf_field.py" "$proxy_dir/secheur_verify_proxy.py" /etc/secheur-flag-oracle.env "$backup/"
"$python" - "$db" "$backup/oracle.sqlite3" <<'PY'
import sqlite3
import sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
assert target.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
target.close()
source.close()
PY
chmod 0600 "$backup/oracle.sqlite3"
echo "backup=$backup"

wait_for_health() {
    for _ in {1..60}; do
        if systemctl is-active --quiet secheur-flag-oracle.service secheur-verify-proxy.service \
            && curl -fsS --max-time 2 http://127.0.0.1:18181/healthz >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

rollback() {
    set +e
    echo 'Oracle deployment failed; restoring source, database, and services' >&2
    systemctl stop secheur-verify-proxy.service secheur-flag-oracle.service
    install -o root -g root -m 0644 "$backup/server.py" "$oracle_dir/server.py"
    install -o root -g root -m 0644 "$backup/sync_from_ctf_field.py" "$oracle_dir/sync_from_ctf_field.py"
    install -o seu -g seu -m 0664 "$backup/secheur_verify_proxy.py" "$proxy_dir/secheur_verify_proxy.py"
    "$python" - "$backup/oracle.sqlite3" "$db" <<'PY'
import sqlite3
import sys
source = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close()
source.close()
PY
    systemctl start secheur-flag-oracle.service secheur-verify-proxy.service
    if wait_for_health; then
        echo 'Oracle rollback health check passed' >&2
    else
        echo 'Oracle rollback health check failed; operator intervention required' >&2
    fi
    exit 1
}
trap rollback ERR

install -o root -g root -m 0644 "$stage/server.py" "$oracle_dir/server.py"
install -o root -g root -m 0644 "$stage/sync_from_ctf_field.py" "$oracle_dir/sync_from_ctf_field.py"
install -o seu -g seu -m 0664 "$stage/secheur_verify_proxy.py" "$proxy_dir/secheur_verify_proxy.py"
systemctl restart secheur-flag-oracle.service secheur-verify-proxy.service
wait_for_health

# The env file is root-only; neither its content nor any answer is logged.
set -a
source /etc/secheur-flag-oracle.env
set +a
"$python" "$oracle_dir/sync_from_ctf_field.py" \
    --api http://127.0.0.1:14230/api \
    --include-id 'nyu/development/2013/CSAW-Quals/misc/Networking 2' \
    --include-id 'nyu/development/2013/CSAW-Quals/web/Guess Harder' \
    --include-id 'nyu/test/2018/CSAW-Quals/pwn/get_it?' \
    --include-id 'nyu/test/2022/CSAW-Finals/crypto/The Lengths we Extend Ourselves' \
    --include-id 'cybench/benchmark/hackthebox/cyber-apocalypse-2024/web/[Very Easy] Flag Command'

"$python" - "$db" <<'PY'
import sqlite3
import sys
connection = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
expected = {
    "nyu/development/2013/CSAW-Quals/misc/Networking 2": 1,
    "nyu/development/2013/CSAW-Quals/web/Guess Harder": 1,
    "nyu/test/2018/CSAW-Quals/pwn/get_it?": 1,
    "nyu/test/2022/CSAW-Finals/crypto/The Lengths we Extend Ourselves": 1,
    "cybench/benchmark/hackthebox/cyber-apocalypse-2024/web/[Very Easy] Flag Command": 4,
}
assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
for challenge_id, count in expected.items():
    actual = connection.execute(
        "SELECT COUNT(*) FROM accepted_flags WHERE challenge_id = ?", (challenge_id,)
    ).fetchone()[0]
    print(f"{challenge_id}: accepted_digests={actual}")
    assert actual == count, (challenge_id, actual, count)
connection.close()
PY

systemctl is-active --quiet secheur-flag-oracle.service secheur-verify-proxy.service
curl -fsS --max-time 5 http://127.0.0.1:18181/healthz
trap - ERR
echo 'Oracle deployment and registration completed'
