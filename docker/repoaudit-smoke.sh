#!/bin/sh
set -eu

test -f /opt/secheur/node_modules/@repoaudit/typescript-adapter/dist/src/index.js
"${REPOAUDIT_PYTHON}" --version 2>&1 | grep -Eq '^Python 3\.13\.'
test -s "${REPOAUDIT_ROOT}/lib/build/my-languages.so"
REPOAUDIT_REQUIRE_API_KEY=0 repoaudit-doctor >/tmp/repoaudit-doctor.json
grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' /tmp/repoaudit-doctor.json
