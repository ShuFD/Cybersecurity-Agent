from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_github_actions_ci_runs_project_quality_gate():
    workflow = ROOT / ".github" / "workflows" / "ci.yml"

    assert workflow.exists()
    text = workflow.read_text(encoding="utf-8")

    assert "actions/checkout" in text
    assert "actions/setup-python" in text
    assert "astral-sh/setup-uv" in text
    assert "git diff --check" in text
    assert "uv run python -m pytest" in text
