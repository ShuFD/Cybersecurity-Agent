import unittest

from secheur_core import SecHeurAgentHandler


class DummyParent:
    task_dir = None
    verbose = False

    def __init__(self):
        self.base_tools_schema = [
            {"type": "function", "function": {"name": "code_run", "description": "run code", "parameters": {}}},
            {"type": "function", "function": {"name": "web_scan", "description": "scan browser html", "parameters": {}}},
            {"type": "function", "function": {"name": "web_execute_js", "description": "execute browser javascript", "parameters": {}}},
        ]
        self.activated_tools = set()
        self.knowledgeBaseEnabled = False


class ToolSearchIntegrationTests(unittest.TestCase):
    def _run_generator(self, gen):
        chunks = []
        while True:
            try:
                chunks.append(next(gen))
            except StopIteration as done:
                return "".join(chunks), done.value

    def test_tool_search_activates_matching_tools_on_parent(self):
        parent = DummyParent()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        gen = handler.do_tool_search({"query": "browser"}, response=None)
        output, outcome = self._run_generator(gen)

        self.assertIn("web_scan", output)
        self.assertIn("web_execute_js", output)
        self.assertIn("web_scan", parent.activated_tools)
        self.assertIn("web_execute_js", parent.activated_tools)
        self.assertEqual(outcome.data["status"], "success")

    def test_tool_search_reports_no_match(self):
        parent = DummyParent()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        gen = handler.do_tool_search({"query": "nonexistent"}, response=None)
        output, outcome = self._run_generator(gen)

        self.assertIn("No deferred tools matched", output)
        self.assertEqual(outcome.data["status"], "not_found")

    def test_tool_search_hides_attack_memory_until_explicitly_enabled(self):
        parent = DummyParent()
        handler = SecHeurAgentHandler(parent, [], cwd="./temp")

        output, outcome = self._run_generator(
            handler.do_tool_search({"query": "heap"}, response=None)
        )
        self.assertNotIn("attack_memory_search", output)
        self.assertNotIn("attack_memory_search", parent.activated_tools)
        self.assertEqual(outcome.data["status"], "not_found")


if __name__ == "__main__":
    unittest.main()
