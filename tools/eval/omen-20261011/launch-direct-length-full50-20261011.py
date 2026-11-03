import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

candidate = Path('/home/shared/agent-rebuild/app-releases/agent-direct-length-recovery-candidate-20261011')
baseline = Path('/home/shared/eval-runner/benchmark-direct-async-fixed-full50-20261010-114724')
root = Path('/home/shared/eval-runner/direct-harness-full50-20261011-length-recovery')
state = Path('/home/shared/pi-eval/direct-harness-full50-20261011-length-recovery/config')
bridge_unit = 'secheur-direct-harness-full50-bridge-20261011-length-recovery'
controller_unit = 'secheur-direct-harness-full50-controller-20261011-length-recovery'
targets = sorted({json.loads(p.read_text())['targetId'] for p in (baseline / 'artifacts').glob('*/result.json')})
assert len(targets) == 50, 'Baseline must provide exactly 50 unique targets'

def production_env():
    pid = subprocess.run(['systemctl', 'show', 'secheur-agent-rebuild.service', '-p', 'MainPID', '--value'],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert pid != '0'
    return dict(item.decode().split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in item)

if '--bridge' in sys.argv:
    env = production_env()
    env.update({'BRIDGE_HOST': '127.0.0.1', 'BRIDGE_PORT': '14175', 'SECHEUR_CONFIG_DIR': str(state),
                'SECHEUR_AGENT_DIR': str(state / 'pi'), 'SECHEUR_LOAD_PERSISTED_SESSIONS': '0',
                'SECHEUR_LEGACY_ROOT': str(candidate / 'legacy')})
    os.chdir('/home/shared/secheur-agent')
    os.setgroups([os.stat(state).st_gid])
    os.setgid(os.stat(state).st_gid)
    os.setuid(os.stat(state).st_uid)
    executable = '/opt/node-v24.14.0-linux-x64/bin/node'
    os.execve(executable, [executable, str(candidate / 'packages/secheur-agent/dist/bridge-cli.js')], env)

if '--controller' in sys.argv:
    args = ['/opt/secheur-agent-python/bin/python', '-u', '/home/shared/eval-runner/bridge_eval_controller.py',
            '--config', str(root / 'config.json'), '--execute', '--confirm', 'RUN_3_LANE_EVAL',
            '--allow-done-rerun', '--max-targets', '50']
    for target in targets: args.extend(['--target-id', target])
    with (root / 'controller.log').open('w') as log:
        result = subprocess.run(args, cwd='/home/shared/eval-runner', stdout=log, stderr=subprocess.STDOUT)
    (root / 'RUN-EXIT-CODE').write_text(str(result.returncode))
    rows = []
    for path in (root / 'artifacts').glob('*/result.json'):
        value = json.loads(path.read_text())
        rows.append({k: value.get(k) for k in ('targetId', 'terminalReason', 'verificationState', 'profile',
                    'sessionId', 'turns', 'toolCalls', 'failureCode', 'failureSource', 'failureStage', 'startedAt', 'endedAt')})
    summary = {'finishedAt': datetime.datetime.now().isoformat(), 'controllerExitCode': result.returncode,
               'expectedTargets': 50, 'completedTargets': len(rows), 'results': rows}
    (root / 'full50-summary.json').write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary), flush=True)
    raise SystemExit(result.returncode)

assert not root.exists() and not state.exists(), 'Existing smoke run must be inspected before reuse'
record = json.loads(Path('/home/seu/direct-length-acceptance-20261011.json').read_text())
assert record['validation']['tests_passed'] and record['validation']['build'] == 'passed'
for item in record['changed_files']:
    assert hashlib.sha256((candidate / item['path']).read_bytes()).hexdigest() == item['sha256']
env = production_env()
source = Path(env['SECHEUR_CONFIG_DIR'])
state.mkdir(parents=True, mode=0o700)
for path in source.iterdir():
    if path.is_file() and path.suffix in ('.json', '.env'):
        shutil.copy2(path, state / path.name)
pi_source = Path(env.get('SECHEUR_AGENT_DIR', str(source / 'pi')))
if pi_source.exists():
    shutil.copytree(pi_source, state / 'pi', ignore=shutil.ignore_patterns('sessions', 'cache', 'logs', 'history'))
subprocess.run(['chown', '-hR', 'pi-eval:shared', str(state.parent)], check=True)
root.mkdir(mode=0o755)
subprocess.run(['chown', 'seu:shared', str(root)], check=True)
cfg = json.loads((baseline / 'config.json').read_text())
cfg.update({'bridgeBase': 'http://127.0.0.1:14175', 'lanes': [[1], [2], [3], [4], [6]], 'controllerConcurrency': 5,
            'maxTurns': 220, 'wallTimeoutSeconds': 3000, 'pollSeconds': 10,
            'release': str(candidate), 'workRoot': str(root / 'work'), 'stateRoot': str(root / 'state'),
            'artifactRoot': str(root / 'artifacts')})
(root / 'targets.json').write_text(json.dumps(targets, indent=2))
(root / 'config.json').write_text(json.dumps(cfg, indent=2))
subprocess.run(['chown', 'seu:shared', str(root / 'config.json')], check=True)
script = str(Path(__file__).resolve())
subprocess.run(['systemd-run', '--unit=' + bridge_unit, '--collect', '-p', 'KillMode=control-group',
                '/opt/secheur-agent-python/bin/python', script, '--bridge'], check=True)
for attempt in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:14175/sessions', timeout=3) as response:
            json.loads(response.read())
        break
    except Exception:
        if attempt == 19: raise
        time.sleep(1)
subprocess.run(['systemd-run', '--unit=' + controller_unit, '--collect', '--uid=seu', '--gid=shared',
                '-p', 'WorkingDirectory=/home/shared/eval-runner',
                '/opt/secheur-agent-python/bin/python', script, '--controller'], check=True)
print(json.dumps({'root': str(root), 'targets': targets, 'candidate': str(candidate), 'bridgePort': 14175,
                  'controllerUnit': controller_unit, 'bridgeUnit': bridge_unit, 'profiles': [1, 2, 3, 4, 6],
                  'wallTimeoutSeconds': 3000, 'maxTurns': 220, 'status': 'started'}))


(root / 'launch-record.json').write_text(json.dumps({'startedAt': datetime.datetime.now().isoformat(), 'root':str(root),'candidate':str(candidate),'targets':targets,'profiles':[1,2,3,4,6],'controllerConcurrency':5,'wallTimeoutSeconds':3000,'maxTurns':220,'bridgeUnit':bridge_unit,'controllerUnit':controller_unit,'status':'started'},indent=2))
