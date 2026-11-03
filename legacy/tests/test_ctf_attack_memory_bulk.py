import json
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

from ctf_attack_memory.bulk import (
    BulkConfig,
    BulkCTFtimeBuilder,
    classify_report_validity,
    effective_source_url,
    parse_event_year,
    parse_writeup_index_page,
    select_task_markdown,
)
from ctf_attack_memory.index import HybridAttackMemoryIndex


@dataclass
class FakeResponse:
    url: str
    text: str
    status_code: int = 200
    encoding: str = "utf-8"

    @property
    def content(self):
        return self.text.encode(self.encoding)

    @property
    def headers(self):
        return {"Content-Type": "text/html; charset=utf-8"}


class FakeSession:
    def __init__(self, pages):
        self.pages = pages
        self.headers = {}
        self.requested = []

    def get(self, url, timeout=None, allow_redirects=True):
        self.requested.append(url)
        text = self.pages.get(url)
        if text is None:
            return FakeResponse(url=url, text="missing", status_code=404)
        return FakeResponse(url=url, text=text)


class CTFtimeBulkTests(unittest.TestCase):
    def test_parse_writeup_index_page_preserves_event_task_tags(self):
        html = """
        <table id="writeups_table"><tbody>
        <tr>
          <td><a href="/event/111">Demo CTF 2025</a></td>
          <td><a href="/task/222">baby rsa</a></td>
          <td><span class="label label-info">crypto</span><span class="label label-info">writeup</span></td>
          <td><a href="/team/1">Team</a></td>
          <td><a href="/writeup/333">Read</a></td>
        </tr>
        </tbody></table>
        """

        entries = parse_writeup_index_page(html, "https://ctftime.org/writeups")

        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.event, "Demo CTF 2025")
        self.assertEqual(entry.task, "baby rsa")
        self.assertEqual(entry.tags, ["crypto", "writeup"])
        self.assertEqual(entry.writeup_id, "333")
        self.assertEqual(entry.writeup_url, "https://ctftime.org/writeup/333")

    def test_parse_event_year_from_event_page_date(self):
        html = (
            "<p>Fri, 19 June 2026, 12:00 UTC &mdash; Mon, 22 June 2026, 00:00 UTC</p>"
        )

        self.assertEqual(parse_event_year(html), 2026)

    def test_effective_source_url_falls_back_when_external_fetch_failed(self):
        item = {
            "external_url": "http://solve.py/",
            "external_status": 0,
            "ctftime_url": "https://ctftime.org/writeup/333",
        }
        entry = parse_writeup_index_page(
            """
            <table><tr>
              <td><a href=\"/event/111\">Demo CTF</a></td>
              <td><a href=\"/task/222\">baby rsa</a></td>
              <td></td><td>Team</td><td><a href=\"/writeup/333\">Read</a></td>
            </tr></table>
            """,
            "https://ctftime.org/writeups",
        )[0]

        self.assertEqual(
            effective_source_url(item, entry), "https://ctftime.org/writeup/333"
        )

    def test_report_validity_rejects_failed_external_link_shell(self):
        item = {
            "external_url": "https://team.example/missing-writeup",
            "external_status": 0,
            "ctftime_url": "https://ctftime.org/writeup/333",
            "markdown": "# baby rsa\n\n[Original writeup](https://team.example/missing-writeup)",
        }

        validity = classify_report_validity(item)

        self.assertFalse(validity.keep)
        self.assertEqual(validity.reason, "external_fetch_placeholder")

    def test_select_task_markdown_extracts_matching_heading_section(self):
        markdown = """# Demo CTF

## web task
not crypto

## baby rsa
RSA with e = 3. Use integer cube root.

```python
m = iroot(c, 3)[0]
```

## misc task
noise
"""

        selected = select_task_markdown(markdown, "baby rsa")

        self.assertIn("## baby rsa", selected)
        self.assertIn("iroot", selected)
        self.assertNotIn("web task", selected)
        self.assertNotIn("misc task", selected)

    def test_bulk_builder_crawls_stores_and_builds_crypto_index(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            pages = {
                "https://ctftime.org/writeups": """
                    <table id="writeups_table"><tbody>
                    <tr>
                      <td><a href="/event/111">Demo CTF 2025</a></td>
                      <td><a href="/task/222">baby rsa</a></td>
                      <td><span class="label label-info">crypto</span><span class="label label-info">writeup</span></td>
                      <td>Team</td>
                      <td><a href="/writeup/333">Read</a></td>
                    </tr>
                    </tbody></table>
                """,
                "https://ctftime.org/event/111": "<p>Fri, 1 May 2025, 00:00 UTC &mdash; Sat, 2 May 2025, 00:00 UTC</p>",
                "https://ctftime.org/writeup/333": """
                    <div class="well" id="id_description">
                      <a href="https://team.example/baby-rsa-writeup">Original writeup</a>
                    </div>
                """,
                "https://team.example/baby-rsa-writeup": """
                    <article>
                    <h1>Demo CTF 2025</h1>
                    <h2>baby rsa</h2>
                    <p>RSA challenge with e = 3 and small message.</p>
                    <p>The plaintext is recovered with an integer cube root attack.</p>
                    <pre><code>m = iroot(c, 3)[0]</code></pre>
                    </article>
                """,
            }
            config = BulkConfig(
                corpus_dir=root / "corpus",
                index_dir=root / "index",
                max_pages=1,
                since_year=2016,
                delay_seconds=0,
            )

            report = BulkCTFtimeBuilder(config, session=FakeSession(pages)).run()
            docs_path = root / "corpus" / "metadata" / "documents.jsonl"
            records_path = root / "index" / "records.jsonl"

            self.assertEqual(report.entries_seen, 1)
            self.assertEqual(report.entries_kept_by_year, 1)
            self.assertEqual(report.valid_reports, 1)
            self.assertEqual(report.invalid_reports, 0)
            self.assertTrue(docs_path.is_file())
            self.assertTrue(records_path.is_file())
            docs = [
                json.loads(line)
                for line in docs_path.read_text(encoding="utf-8").splitlines()
            ]
            self.assertEqual(docs[0]["entry"]["task"], "baby rsa")
            index = HybridAttackMemoryIndex.load(root / "index")
            hits = index.search("RSA e=3 cube root", top_k=1)
            self.assertEqual(hits[0].record.challenge, "baby rsa")


if __name__ == "__main__":
    unittest.main()
