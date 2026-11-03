import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, '/home/shared/eval-runner')
spec = importlib.util.spec_from_file_location('field_record_fixture', os.environ.get('FIELD_RECORD_TEST_MODULE', '/home/shared/eval-runner/ctf-field-backend.py'))
field = importlib.util.module_from_spec(spec)
spec.loader.exec_module(field)
spec = importlib.util.spec_from_file_location('controller_record_fixture', Path(__file__).resolve().parents[2] / 'eval-runner' / 'bridge_eval_controller.py')
controller = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = controller
spec.loader.exec_module(controller)

class RecordContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='field-record-contract-')
        root = Path(self.temp.name)
        values = {name: root / name for name in ('RECORDS_PATH','RECORDS_DB_PATH','RECORDS_VERSION_DIR','RECORDS_SNAPSHOT_DIR','RECORDS_LEGACY_DIR')}
        values.update(RECORDS_INITIALIZED=False, FEISHU_SYNC_ENABLED=False, FEISHU_UNTESTED_TABLE_ID='')
        self.settings = patch.multiple(field, **values)
        self.settings.start()
        self.server = field.ThreadingHTTPServer(('127.0.0.1', 0), field.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.settings.stop()
        self.temp.cleanup()

    def post(self, payload):
        request = urllib.request.Request('http://127.0.0.1:' + str(self.server.server_port) + '/api/record',
                                        data=json.dumps(payload).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request) as response:
            return json.load(response)

    def payload(self, status='failed'):
        return {'target_id':'fixture/task','run_id':'fixture-run','session_id':'fixture-session','status':status,
                'terminal_reason':'verified_true' if status=='done' else 'infra_failed',
                'verification_state':'accepted' if status=='done' else 'not_attempted','process_note':'fixture transcript'}

    def test_failed_receipt_matches_real_controller_and_sqlite(self):
        payload = self.payload()
        response = self.post(payload)
        controller.validate_record_response(response, target_id=payload['target_id'], run_id=payload['run_id'],
            session_id=payload['session_id'], status=payload['status'], terminal_reason=payload['terminal_reason'],
            verification_state=payload['verification_state'], process_note=payload['process_note'])
        for key in ('session_id','terminal_reason','verification_state'):
            self.assertEqual(field.load_record(payload['target_id'])[key], payload[key])

    def test_done_receipt_matches_real_controller(self):
        payload = self.payload('done')
        response = self.post(payload)
        controller.validate_record_response(response, target_id=payload['target_id'], run_id=payload['run_id'],
            session_id=payload['session_id'], status=payload['status'], terminal_reason=payload['terminal_reason'],
            verification_state=payload['verification_state'], process_note=payload['process_note'])

    def test_old_payload_does_not_erase_identity(self):
        self.post(self.payload())
        self.post({'target_id':'fixture/task','process_summary':'old UI update'})
        self.assertEqual(field.load_record('fixture/task')['session_id'], 'fixture-session')

    def test_wrong_receipt_still_rejected(self):
        payload = self.payload()
        response = self.post(payload)
        response['record']['session_id'] = 'other-session'
        with self.assertRaisesRegex(RuntimeError, 'session_id'):
            controller.validate_record_response(response, target_id=payload['target_id'], run_id=payload['run_id'],
                session_id=payload['session_id'], status=payload['status'], terminal_reason=payload['terminal_reason'],
                verification_state=payload['verification_state'], process_note=payload['process_note'])

    def test_sensitive_extra_fields_not_copied(self):
        payload = {**self.payload(), 'gold':'fixture-private-value'}
        self.assertNotIn('gold', self.post(payload)['record'])

if __name__ == '__main__':
    unittest.main()
