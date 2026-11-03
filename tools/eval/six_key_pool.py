"""Bind evaluation lanes to distinct existing credentials; never alter model calls."""
import copy
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

from credential_admission import CredentialAdmission


class SixKeyPool:
    def __init__(self, entries, expected_model, admission_path=None):
        if len(entries) != 6:
            raise ValueError('Exactly six credential slots are required')
        self.admission = CredentialAdmission(admission_path) if admission_path is not None else None
        identities = set()
        self._entries = []
        for entry in entries:
            token = entry.get('token')
            if not isinstance(token, str) or not token.strip() or token.startswith('!') or token == 'eval-gateway-only':
                raise ValueError('A real literal credential is required for each slot')
            fingerprint = hashlib.sha256(token.encode()).hexdigest()
            if fingerprint in identities:
                raise ValueError('Credential slots must use six different keys')
            identities.add(fingerprint)
            if entry.get('model') != expected_model:
                raise ValueError('All six slots must use the frozen evaluation model')
            endpoint = urlsplit(entry.get('baseUrl', ''))
            if endpoint.scheme != 'https' or endpoint.hostname != 'api.minimaxi.com' or endpoint.path.rstrip('/') != '/v1' or endpoint.port not in (None, 443) or endpoint.query or endpoint.fragment or endpoint.username:
                raise ValueError('Credential endpoint differs from the trusted evaluation endpoint')
            self._entries.append({**entry, 'fingerprint': fingerprint})

    @classmethod
    def from_configuration(cls, configuration, expected_model):
        directory = Path(configuration['credentialDirectory'])
        providers = json.loads((directory / 'models.json').read_text())['providers']
        auth = json.loads((directory / 'auth.json').read_text())
        names = configuration['providers']
        if len(names) != len(set(names)):
            raise ValueError('Credential source names must be unique')
        entries = []
        for name in names:
            provider = providers[name]
            credential = auth[name]
            if credential.get('type') != 'api_key' or provider.get('api') != 'openai-completions' or provider.get('headers'):
                raise ValueError('Unsupported credential configuration')
            if provider.get('apiKey'):
                raise ValueError('Ambiguous provider credential override')
            if not any(m.get('id') == expected_model for m in provider.get('models', [])):
                raise ValueError('The frozen model is absent from a credential source')
            entries.append({'token': credential['key'], 'baseUrl': provider['baseUrl'], 'model': expected_model})
        return cls(entries, expected_model, configuration.get("admissionState"))

    def settings_for_slot(self, settings, slot):
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot < 6:
            raise ValueError('Invalid credential slot')
        output = copy.deepcopy(settings)
        output.pop('sixKeyPool', None)
        routes = [r for r in output['controlRoutes'] if r.get('kind') == 'model']
        if len(routes) != 1:
            raise ValueError('Exactly one model route is required')
        route = routes[0]
        entry = self._entries[slot]
        if route.get('host') != 'api.minimaxi.com' or route.get('protocol') != 'https' or route.get('port') != 443 or route.get('modelId') != entry['model']:
            raise ValueError('Gateway route differs from the credential model endpoint')
        route['token'] = entry['token']
        return output

    def metadata_for_slot(self, slot):
        return {'slot': slot + 1, 'credentialId': self._entries[slot]['fingerprint'][:10], 'model': self._entries[slot]['model']}

    def metadata(self):
        return [self.metadata_for_slot(slot) for slot in range(6)]

    def check_admission(self, slot):
        fingerprint = self._entries[slot]['fingerprint']
        return self.admission.check_admission(fingerprint) if self.admission else {'allowed': True, 'reason': 'admission_state_not_configured'}

    def finish(self, slot, run_id, result):
        if self.admission is None:
            raise ValueError('Durable credential admission state is required')
        return self.admission.finish(self._entries[slot]['fingerprint'], run_id, result.get('modelFailureDiagnostics', {}))

    def recover_after_successful_probe(self, slot, *, status, probe_ref):
        if self.admission is None:
            raise ValueError('Durable credential admission state is required')
        return self.admission.recover_after_successful_probe(self._entries[slot]['fingerprint'], status=status, probe_ref=probe_ref)
