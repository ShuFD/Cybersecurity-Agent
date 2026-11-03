import json
import tempfile
import unittest
from pathlib import Path

from server import ChallengeSpec, EnvironmentManager, GatewayServer, load_challenges


class FakeDocker:
    def __init__(self):
        self.created = []
        self.removed = []
        self.running = {}

    def create_and_start(self, spec):
        container_id = f"container-{len(self.created) + 1}"
        inspected = {
            "State": {"Running": True},
            "NetworkSettings": {"Ports": {f"{spec.container_port}/tcp": [{"HostPort": str(32000 + len(self.created))}]}},
        }
        self.created.append((container_id, spec))
        self.running[container_id] = inspected
        return container_id, inspected

    def inspect(self, container_id):
        return self.running[container_id]

    def stop_remove(self, container_id):
        self.removed.append(container_id)
        self.running.pop(container_id, None)


class GatewayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clock_value = [1_000]
        self.docker = FakeDocker()
        spec = ChallengeSpec.from_json(
            "10756",
            {"image": "secheur-10756:local", "command": ["/challenge/run"], "containerPort": 31337},
        )
        self.manager = EnvironmentManager(
            {"10756": spec},
            self.docker,
            str(Path(self.temp.name) / "state.json"),
            max_slots=1,
            ttl_seconds=5,
            clock=lambda: self.clock_value[0],
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_single_flight_capacity_and_release(self):
        first = self.manager.start("10756")
        self.assertEqual(first["status"], "ready")
        self.assertEqual(self.manager.start("10756")["endpoints"][0]["port"], 32000)
        with self.assertRaisesRegex(Exception, "no local environment"):
            self.manager.start("missing")
        self.manager.release("10756")
        self.assertEqual(self.docker.removed, ["container-1"])

    def test_ttl_expiry_and_heartbeat(self):
        self.manager.start("10756")
        self.clock_value[0] = 4_000
        self.manager.heartbeat("10756")
        self.clock_value[0] = 8_000
        self.assertEqual(self.manager.get("10756")["status"], "ready")
        self.clock_value[0] = 10_000
        with self.assertRaisesRegex(Exception, "no active environment"):
            self.manager.get("10756")
        self.assertEqual(self.docker.removed, ["container-1"])

    def test_http_health_and_unknown_environment(self):
        server = GatewayServer(("127.0.0.1", 0), self.manager)
        thread = __import__("threading").Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            import urllib.error
            import urllib.request

            url = f"http://127.0.0.1:{server.server_port}/healthz"
            with urllib.request.urlopen(url) as response:
                self.assertEqual(json.loads(response.read()), {"ok": True, "active": 0, "max_slots": 1})
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/v1/environments",
                data=json.dumps({"exerciseId": "unknown"}).encode(),
                method="POST",
                headers={"content-type": "application/json"},
            )
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(request)
            self.assertEqual(error.exception.code, 550)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


class ConfigTest(unittest.TestCase):
    def test_loads_mapping_and_rejects_latest(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "challenges.json"
            path.write_text(json.dumps({"10756": {"image": "pwn:1.0", "containerPort": 31337}}))
            self.assertEqual(load_challenges(str(path))["10756"].image, "pwn:1.0")
            path.write_text(json.dumps({"10756": {"image": "pwn:latest"}}))
            with self.assertRaises(Exception):
                load_challenges(str(path))


if __name__ == "__main__":
    unittest.main()
