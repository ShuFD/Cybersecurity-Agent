"""Idempotent evaluation queue: DIRECT completion -> Progressive -> Cairn.
Only benchmark infrastructure and a frozen, independent release are operated.
"""
import collections
import importlib.util
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

PYTHON = '/opt/secheur-agent-python/bin/python'
NODE = '/opt/node-v24.14.0-linux-x64/bin/node'
DIRECT = Path('/home/shared/eval-runner/direct-harness-full50-20261011-length-recovery')
RELEASE = Path('/home/shared/agent-rebuild/app-releases/agent-plan-recovery-candidate-20261011')
QUEUE = Path('/home/shared/eval-runner/plan-permission-fixed-full50-20261011')
ACCEPTANCE = Path('/home/seu/plan-harness-acceptance-20261011.json')
MODES = ('progressive', 'cairn')
PORTS = {'progressive': 14176, 'cairn': 14177}

permission_spec = importlib.util.spec_from_file_location('plan_workspace_permissions', '/home/seu/plan-fixed-workspace-permissions-20261011.py')
permission_module = importlib.util.module_from_spec(permission_spec)
permission_spec.loader.exec_module(permission_module)

def root_for(mode):
    return QUEUE / mode

def state_for(mode):
    return Path('/home/shared/pi-eval/plan-permission-fixed-full50-20261011') / mode / 'config'

def unit_for(mode, component):
    return f'secheur-plan-permission-fixed-full50-{mode}-{component}-20261011'

def unit_state(unit):
    return subprocess.run(['systemctl', 'is-active', unit], capture_output=True, text=True).stdout.strip()

def metadata(root):
    rows = [json.loads(path.read_text()) for path in (root / 'artifacts').glob('*/result.json')]
    targets = [row['targetId'] for row in rows]
    exit_file = root / 'RUN-EXIT-CODE'
    return {'completed': len(rows), 'uniqueTargets': len(set(targets)),
            'passed': sum(row.get('terminalReason') == 'verified_true' for row in rows),
            'reasons': dict(collections.Counter(row.get('terminalReason') for row in rows)),
            'exitCode': int(exit_file.read_text()) if exit_file.exists() else None,
            'targetIds': sorted(targets)}

def complete(root, targets, controller):
    value = metadata(root)
    return (value['exitCode'] == 0 and value['targetIds'] == sorted(targets)
            and value['completed'] == 50 and unit_state(controller) not in ('active', 'activating', 'deactivating'))

def production_env():
    pid = subprocess.run(['systemctl', 'show', 'secheur-agent-rebuild.service', '-p', 'MainPID', '--value'],
                         capture_output=True, text=True, check=True).stdout.strip()
    if pid == '0':
        raise RuntimeError('Production environment source unavailable')
    return dict(item.decode().split('=', 1) for item in Path('/proc/' + pid + '/environ').read_bytes().split(b'\0') if b'=' in item)

def validate_release():
    record = json.loads(ACCEPTANCE.read_text())
    assert record['validation']['testsPassed'] and record['validation']['build'] == 'passed'
    assert record['validation']['compiledSmoke'] == 'passed'
    assert record['validation']['protectedReleaseUnchanged']
    assert record['candidateRelease'] == str(RELEASE)
    for item in record['changedFiles']:
        assert hashlib.sha256((RELEASE / item['path']).read_bytes()).hexdigest() == item['sha256'], item['path']

def bridge(mode):
    state = state_for(mode)
    env = production_env()
    env.update({'BRIDGE_HOST': '127.0.0.1', 'BRIDGE_PORT': str(PORTS[mode]),
                'SECHEUR_CONFIG_DIR': str(state), 'SECHEUR_AGENT_DIR': str(state / 'pi'),
                'SECHEUR_LOAD_PERSISTED_SESSIONS': '0', 'SECHEUR_LEGACY_ROOT': str(RELEASE / 'legacy'),
                'SECHEUR_EXECUTION_MODE': 'PLAN_MULTI', 'SECHEUR_EXECUTION_CAPACITY': '2',
                'SECHEUR_PLANNING_MODE': 'active'})
    os.chdir('/home/shared/secheur-agent')
    os.setgroups([os.stat(state).st_gid])
    os.setgid(os.stat(state).st_gid)
    os.setuid(os.stat(state).st_uid)
    os.execve(NODE, [NODE, str(RELEASE / 'packages/secheur-agent/dist/bridge-cli.js')], env)

def controller(mode):
    root = root_for(mode)
    targets = json.loads((DIRECT / 'targets.json').read_text())
    args = [PYTHON, '-u', '/home/shared/eval-runner/bridge_eval_controller.py', '--config', str(root / 'config.json'),
            '--execute', '--confirm', 'RUN_3_LANE_EVAL', '--allow-done-rerun', '--max-targets', '50']
    for target in targets:
        args.extend(['--target-id', target])
    with (root / 'controller.log').open('w') as log:
        result = subprocess.run(args, cwd='/home/shared/eval-runner', stdout=log, stderr=subprocess.STDOUT)
    (root / 'RUN-EXIT-CODE').write_text(str(result.returncode))
    summary = metadata(root)
    summary.update({'finishedAt': datetime.datetime.now().isoformat(), 'engine': mode, 'expected': 50})
    (root / 'full50-summary.json').write_text(json.dumps(summary, indent=2))
    return result.returncode

def prepare(mode):
    root, state = root_for(mode), state_for(mode)
    if (root / 'config.json').exists():
        return
    assert not state.exists(), 'Partial preparation needs inspection'
    env = production_env()
    source = Path(env['SECHEUR_CONFIG_DIR'])
    state.mkdir(parents=True, mode=0o700)
    for path in source.iterdir():
        if path.is_file() and path.suffix in ('.json', '.env'):
            shutil.copy2(path, state / path.name)
    pi_source = Path(env.get('SECHEUR_AGENT_DIR', str(source / 'pi')))
    if pi_source.exists():
        shutil.copytree(pi_source, state / 'pi', ignore=shutil.ignore_patterns('sessions', 'cache', 'logs', 'history'))
    desktop_path = state / 'desktop-config.json'
    desktop = json.loads(desktop_path.read_text()) if desktop_path.exists() else {}
    desktop.setdefault('planning', {}).update({'engine': mode, 'mode': 'active', 'globalExecutorCapacity': 7})
    desktop['executionMode'] = 'plan_multi'
    desktop['executionCapacity'] = 2
    desktop_path.write_text(json.dumps(desktop, indent=2))
    subprocess.run(['chown', '-hR', 'pi-eval:shared', str(state.parent)], check=True)
    root.mkdir(parents=True)
    subprocess.run(['chown', 'seu:shared', str(root)], check=True)
    cfg = json.loads((DIRECT / 'config.json').read_text())
    cfg.update({'bridgeBase': f'http://127.0.0.1:{PORTS[mode]}', 'executionMode': 'PLAN_MULTI', 'executionCapacity': 2,
                'controllerConcurrency': 5, 'release': str(RELEASE), 'planningEngine': mode,
                'workRoot': str(root / 'work'), 'stateRoot': str(root / 'state'), 'artifactRoot': str(root / 'artifacts')})
    (root / 'targets.json').write_text((DIRECT / 'targets.json').read_text())
    (root / 'config.json').write_text(json.dumps(cfg, indent=2))
    subprocess.run(['chown', 'seu:shared', str(root / 'config.json'), str(root / 'targets.json')], check=True)

def launch(mode):
    root = root_for(mode)
    bridge_unit, controller_unit = unit_for(mode, 'bridge'), unit_for(mode, 'controller')
    permission_module.verify_work_root(permission_module.prepare_work_root(root / 'work'))
    assert unit_state(controller_unit) not in ('active', 'activating', 'deactivating')
    assert not (root / 'launch-record.json').exists(), 'Never rerun an already launched batch automatically'
    script = str(Path(__file__).resolve())
    if unit_state(bridge_unit) != 'active':
        subprocess.run(['systemd-run', '--unit=' + bridge_unit, '--collect', '-p', 'KillMode=control-group',
                        PYTHON, script, '--bridge', mode], check=True)
    for attempt in range(20):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORTS[mode]}/sessions', timeout=3) as response:
                json.loads(response.read())
            break
        except Exception:
            if attempt == 19:
                raise
            time.sleep(1)
    record = {'startedAt': datetime.datetime.now().isoformat(), 'engine': mode, 'expectedTargets': 50,
              'release': str(RELEASE), 'port': PORTS[mode], 'executionMode': 'PLAN_MULTI', 'executionCapacity': 2,
              'controllerConcurrency': 5, 'controllerUnit': controller_unit, 'bridgeUnit': bridge_unit}
    (root / 'launch-record.json').write_text(json.dumps(record, indent=2))
    subprocess.run(['chown', 'seu:shared', str(root / 'launch-record.json')], check=True)
    subprocess.run(['systemd-run', '--unit=' + controller_unit, '--collect', '--uid=seu', '--gid=shared',
                    '-p', 'WorkingDirectory=/home/shared/eval-runner', '-p', 'UMask=0007', PYTHON, script, '--controller', mode], check=True)

def advance():
    validate_release()
    targets = json.loads((DIRECT / 'targets.json').read_text())
    assert len(targets) == len(set(targets)) == 50
    for mode in MODES:
        prepare(mode)
    if not complete(DIRECT, targets, 'secheur-direct-harness-full50-controller-20261011-length-recovery'):
        value = metadata(DIRECT)
        value.pop('targetIds')
        state = unit_state('secheur-direct-harness-full50-controller-20261011-length-recovery')
        return {'status': 'waiting_for_direct' if state in ('active', 'activating', 'deactivating') else 'needs_attention', 'direct': value}
    for mode in MODES:
        root = root_for(mode)
        if complete(root, targets, unit_for(mode, 'controller')):
            continue
        if (root / 'launch-record.json').exists():
            value = metadata(root)
            value.pop('targetIds')
            return {'status': 'running' if unit_state(unit_for(mode, 'controller')) == 'active' else 'needs_attention', 'engine': mode, 'progress': value}
        launch(mode)
        return {'status': 'started', 'engine': mode, 'root': str(root)}
    return {'status': 'complete', 'results': {mode: metadata(root_for(mode)) for mode in MODES}}

if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--bridge':
        bridge(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == '--controller':
        raise SystemExit(controller(sys.argv[2]))
    elif sys.argv[1:] == ['--advance']:
        QUEUE.mkdir(parents=True, exist_ok=True)
        with (QUEUE / 'queue.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            report = advance()
            report['checkedAt'] = datetime.datetime.now().isoformat()
            (QUEUE / 'queue-status.json').write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
    else:
        raise SystemExit('Usage: --advance | --bridge MODE | --controller MODE')
