import unittest
from dataclasses import dataclass

from ctf_attack_memory.crawler import (
    WriteupCrawler,
    extract_ctftime_links,
    github_raw_url,
)


@dataclass
class FakeResponse:
    url: str
    text: str
    status_code: int = 200
    content_type: str = "text/html; charset=utf-8"
    encoding: str = "utf-8"

    @property
    def headers(self):
        return {"Content-Type": self.content_type}

    @property
    def content(self):
        return self.text.encode(self.encoding)


class FakeSession:
    def __init__(self, pages):
        self.pages = pages
        self.headers = {}
        self.requested = []

    def get(self, url, timeout=None, allow_redirects=True):
        self.requested.append(url)
        if url not in self.pages:
            return FakeResponse(url=url, text="not found", status_code=404)
        payload = self.pages[url]
        if isinstance(payload, FakeResponse):
            return payload
        return FakeResponse(url=url, text=payload)


class CTFtimeCrawlerTests(unittest.TestCase):
    def test_extract_ctftime_links_resolves_relative_writeup_and_event_links(self):
        html = """
        <html><body>
          <a href="/event/1234">Imaginary CTF 2026</a>
          <a href="/writeup/5678">RSA Challenge Writeup</a>
          <a href="https://team.example/blog/crypto-rsa-writeup">external solution</a>
          <a href="https://twitter.com/noise">share</a>
        </body></html>
        """

        links = extract_ctftime_links(html, base_url="https://ctftime.org/writeups")

        by_type = {(link.link_type, link.url) for link in links}
        self.assertIn(("event", "https://ctftime.org/event/1234"), by_type)
        self.assertIn(("ctftime_writeup", "https://ctftime.org/writeup/5678"), by_type)
        self.assertIn(
            ("external_writeup", "https://team.example/blog/crypto-rsa-writeup"),
            by_type,
        )
        self.assertNotIn(("external_writeup", "https://twitter.com/noise"), by_type)

    def test_discover_follows_ctftime_writeup_page_to_external_wp_and_fetches_it(self):
        pages = {
            "https://ctftime.org/writeups": """
                <main>
                  <a href="/writeup/5678">baby RSA writeup</a>
                </main>
            """,
            "https://ctftime.org/writeup/5678": """
                <article>
                  <h1>baby RSA</h1>
                  <a href="https://team.example/writeups/baby-rsa-crypto-writeup">Original writeup</a>
                </article>
            """,
            "https://team.example/writeups/baby-rsa-crypto-writeup": """
                <article>
                  <h1>baby RSA</h1>
                  <p>The task used RSA with e = 3 and a small message.</p>
                  <p>We recover the plaintext with an integer cube root attack.</p>
                  <pre><code>from Crypto.Util.number import long_to_bytes\nm = iroot(c, 3)[0]</code></pre>
                </article>
            """,
        }
        crawler = WriteupCrawler(session=FakeSession(pages), delay_seconds=0)

        links = crawler.discover_from_ctftime(
            ["https://ctftime.org/writeups"], max_pages=3
        )
        docs = crawler.fetch_documents(links, max_documents=5)

        urls = {link.url for link in links}
        self.assertIn("https://ctftime.org/writeup/5678", urls)
        self.assertIn("https://team.example/writeups/baby-rsa-crypto-writeup", urls)
        fetched_urls = {doc.url for doc in docs}
        self.assertIn(
            "https://team.example/writeups/baby-rsa-crypto-writeup", fetched_urls
        )
        external_doc = next(
            doc
            for doc in docs
            if doc.url == "https://team.example/writeups/baby-rsa-crypto-writeup"
        )
        self.assertIn("# baby RSA", external_doc.text)
        self.assertIn("integer cube root attack", external_doc.text)
        self.assertIn("long_to_bytes", external_doc.text)

    def test_markdown_url_label_does_not_create_malformed_duplicate(self):
        markdown = "[https://team.example/crypto-writeup/](https://team.example/crypto-writeup/)"

        links = extract_ctftime_links(
            markdown, base_url="https://ctftime.org/writeup/1"
        )

        self.assertEqual(
            [link.url for link in links], ["https://team.example/crypto-writeup"]
        )

    def test_github_blob_url_is_converted_to_raw_for_fetching(self):
        self.assertEqual(
            github_raw_url("https://github.com/user/repo/blob/main/writeups/crypto.md"),
            "https://raw.githubusercontent.com/user/repo/main/writeups/crypto.md",
        )


if __name__ == "__main__":
    unittest.main()
