import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('queue', '/home/seu/advance-plan-permission-fixed-full50-20261011.py')
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)

class QueueBoundaryTest(unittest.TestCase):
    def test_completion_gate_and_sequential_idempotence(self):
        with tempfile.TemporaryDirectory(prefix='plan-queue-fixture-') as temporary:
            queue.DIRECT = Path(temporary) / 'direct'
            queue.QUEUE = Path(temporary) / 'plans'
            queue.DIRECT.mkdir()
            targets = [f'fixture-{i:02d}' for i in range(50)]
            (queue.DIRECT / 'targets.json').write_text(json.dumps(targets))
            states = {'secheur-direct-harness-full50-controller-20261011-length-recovery': 'active'}
            queue.unit_state = lambda unit: states.get(unit, 'inactive')
            queue.validate_release = lambda: None
            queue.prepare = lambda mode: queue.root_for(mode).mkdir(parents=True, exist_ok=True)
            launches = []
            def launch(mode):
                launches.append(mode)
                (queue.root_for(mode) / 'launch-record.json').write_text('{}')
                states[queue.unit_for(mode, 'controller')] = 'active'
            queue.launch = launch
            def finish(root, count=50, exit_code=0):
                for target in targets[:count]:
                    directory = root / 'artifacts' / target
                    directory.mkdir(parents=True, exist_ok=True)
                    (directory / 'result.json').write_text(json.dumps({'targetId': target, 'terminalReason': 'verified_true'}))
                (root / 'RUN-EXIT-CODE').write_text(str(exit_code))
            self.assertEqual(queue.advance()['status'], 'waiting_for_direct')
            finish(queue.DIRECT)
            self.assertEqual(queue.advance()['status'], 'waiting_for_direct')
            self.assertEqual(launches, [])  # 50 result files alone are insufficient.
            states['secheur-direct-harness-full50-controller-20261011-length-recovery'] = 'inactive'
            self.assertEqual(queue.advance()['engine'], 'progressive')
            self.assertEqual(queue.advance()['status'], 'running')
            self.assertEqual(launches, ['progressive'])
            finish(queue.root_for('progressive'), count=49)
            states[queue.unit_for('progressive', 'controller')] = 'inactive'
            self.assertEqual(queue.advance()['status'], 'needs_attention')
            self.assertEqual(launches, ['progressive'])
            finish(queue.root_for('progressive'))
            self.assertEqual(queue.advance()['engine'], 'cairn')
            self.assertEqual(queue.advance()['status'], 'running')
            self.assertEqual(launches, ['progressive', 'cairn'])
            finish(queue.root_for('cairn'))
            states[queue.unit_for('cairn', 'controller')] = 'inactive'
            self.assertEqual(queue.advance()['status'], 'complete')
            self.assertEqual(queue.advance()['status'], 'complete')
            self.assertEqual(launches, ['progressive', 'cairn'])

if __name__ == '__main__':
    unittest.main()
