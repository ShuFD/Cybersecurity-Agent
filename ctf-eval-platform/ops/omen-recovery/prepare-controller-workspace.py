"""Host-only permissions for the recovered Controller and separate Agent user."""
import grp
import json
import os
import sys
from pathlib import Path

config_path = Path(sys.argv[1]).resolve()
config = json.loads(config_path.read_text())
root = Path('/home/shared/eval-runner').resolve()
shared = grp.getgrnam('shared').gr_gid
work = Path(config['workRoot']).resolve()
if root not in work.parents:
    raise ValueError('recovery workRoot must be inside eval-runner')
work.mkdir(parents=True, exist_ok=True)
os.chown(work, -1, shared)
work.chmod(0o2770)
for name in ('stateRoot', 'artifactRoot'):
    private = Path(config[name]).resolve()
    if root not in private.parents or private == work or private in work.parents or work in private.parents:
        raise ValueError('invalid private storage root')
    private.mkdir(parents=True, exist_ok=True)
    private.chmod(0o700)
# Batch roots are created by the same Controller user and must be traversable
# by pi-eval, but the private record/trace directories above remain inaccessible.
for parent in work.parents:
    if parent == root:
        break
    if parent.stat().st_uid == os.getuid() and not parent.stat().st_mode & 0o001:
        os.chown(parent, -1, shared)
        parent.chmod(parent.stat().st_mode | 0o010)
