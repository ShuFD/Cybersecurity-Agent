"""Prepare the authorized Artex batch without touching upstream work or starting workers."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path('/home/shared/eval-runner/artex-minimax20-20261023')
RELEASE = Path('/home/shared/agent-rebuild/app-releases/agent-plan-artex-20261023')
UPSTREAM = Path('/home/shared/eval-runner/plan-final-round-minimax20-20261023')
MODES = ['progressive', 'cairn', 'hypothesis']
os.umask(0o077)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2))
    path.chmod(0o600)


def main():
    assert not ROOT.exists(), 'Batch already exists; inspect it instead of preparing twice'
    verification = json.loads((RELEASE / 'candidate-verification.json').read_text())
    manifest = json.loads((RELEASE / 'runtime-manifest.json').read_text())
    assert verification['image'].startswith('sha256:')
    assert manifest
    for name, expected in manifest.items():
        path = RELEASE / 'app' / name
        assert path.resolve().is_relative_to((RELEASE / 'app').resolve())
        assert digest(path) == expected, 'Release manifest mismatch'
    targets = json.loads((UPSTREAM / 'targets.json').read_text())
    assert len(targets) == len(set(targets)) == 20
    frozen_upstream = json.loads((UPSTREAM / 'frozen.json').read_text())['files']
    dependency_files = {}
    templates = []
    for mode in MODES:
        for filename in ['config.json', 'sandbox.json']:
            path = UPSTREAM / mode / filename
            expected = frozen_upstream[str(path)]
            assert digest(path) == expected, 'Upstream configuration differs from frozen input'
            dependency_files[str(path)] = expected
        config = json.loads((UPSTREAM / mode / 'config.json').read_text())
        sandbox = json.loads((UPSTREAM / mode / 'sandbox.json').read_text())
        assert config['lanes'] == [[1], [2], [3], [4], [5]]
        assert (config['controllerConcurrency'], config['maxTurns'], config['wallTimeoutSeconds'], config['executionCapacity']) == (5, 220, 3000, 2)
        assert config['executionMode'] == 'PLAN_MULTI' and config['memoryReferenceEnabled'] is False
        assert sandbox['model']['model'] == 'MiniMax-M3'
        assert sandbox['sixKeyPool']['laneSlots'] == [0, 1, 2, 4, 5]
        assert set(sandbox['scopes']) == set(targets)
        templates.append((config, sandbox))
    for _, sandbox in templates[1:]:
        for field in ['scopes', 'model', 'workerConfig']:
            assert sandbox[field] == templates[0][1][field], 'Upstream mode inputs differ'
    dependency_files[str(UPSTREAM / 'targets.json')] = digest(UPSTREAM / 'targets.json')
    dependency_files[str(UPSTREAM / 'run-batch.py')] = digest(UPSTREAM / 'run-batch.py')
    assert dependency_files[str(UPSTREAM / 'targets.json')] == frozen_upstream[str(UPSTREAM / 'targets.json')]

    # No global controller lock is acquired during preparation: upstream is active.
    ROOT.mkdir(mode=0o700)
    candidate = ROOT / 'candidate'
    subprocess.run(['cp', '-a', '--reflink=auto', str(RELEASE / 'app'), str(candidate)], check=True)
    directory = ROOT / 'artex'
    directory.mkdir(mode=0o700)
    config, sandbox = templates[2]
    config['release'] = str(candidate)
    for field, folder in [('workRoot', 'work'), ('stateRoot', 'state'), ('artifactRoot', 'artifacts')]:
        config[field] = str(directory / folder)
    sandbox.update(mode='artex', image=verification['image'], privateRoot=str(directory / 'private'))
    sandbox['sixKeyPool']['admissionState'] = str(directory / 'state/credential-admission.sqlite')
    for target, adapter in sandbox.get('privateFieldAdapters', {}).items():
        adapter['root'] = str(directory / 'private-field' / hashlib.sha256(target.encode()).hexdigest()[:20])
    for filename, value in [('config.json', config), ('sandbox.json', sandbox), ('targets.json', targets)]:
        write(directory / filename, value)
    write(ROOT / 'targets.json', targets)
    shutil.copyfile(Path(__file__).with_name('run-queued-batch.py'), ROOT / 'run-queued-batch.py')
    (ROOT / 'run-queued-batch.py').chmod(0o600)
    frozen = {}
    for subtree in ['packages/secheur-agent/src', 'packages/secheur-agent/dist', 'tools/eval']:
        for path in (candidate / subtree).rglob('*'):
            if path.is_file() and path.suffix in {'.ts', '.js', '.mjs', '.py', '.json'}:
                frozen[str(path)] = digest(path)
    for name, expected in manifest.items():
        path = candidate / name
        assert digest(path) == expected
        frozen[str(path)] = expected
    for path in [ROOT / 'targets.json', ROOT / 'run-queued-batch.py', *directory.glob('*.json')]:
        frozen[str(path)] = digest(path)
    write(ROOT / 'frozen.json', {'image': verification['image'], 'files': frozen,
          'upstreamFiles': dependency_files, 'upstream': str(UPSTREAM)})
    write(ROOT / 'work-status.json', {'status': 'prepared', 'started': False,
          'modes': ['artex'], 'questionsPerMode': 20, 'totalPlannedQuestions': 20,
          'model': 'MiniMax-M3', 'maxTurns': 220, 'wallTimeoutSeconds': 3000,
          'executionCapacity': 2, 'questionConcurrency': 5, 'credentialSlots': [0, 1, 2, 4, 5],
          'image': verification['image'], 'upstream': str(UPSTREAM), 'automaticReruns': False,
          'oldResultsImported': False, 'productionChanged': False, 'monitorCreated': False})
    print(json.dumps({'status': 'prepared', 'batch': str(ROOT), 'questions': 20,
                      'model': 'MiniMax-M3', 'upstream': str(UPSTREAM)}))


if __name__ == '__main__':
    main()
