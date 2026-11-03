import unittest

from ctf_attack_memory.roderick_pwn import records_from_article


class RoderickPwnTests(unittest.TestCase):
    def test_uses_source_house_sections_without_cleaning(self):
        article = """# article
## 2.1-House of Spirit
### 漏洞成因
heap overflow
## 2.2-House of Force
### 适用范围
glibc 2.23 -- 2.29
"""

        records = records_from_article(article)

        self.assertEqual([record.challenge for record in records], ["House of Spirit", "House of Force"])
        self.assertIn("### 漏洞成因", records[0].text_chunk)
        self.assertEqual(records[0].attack_pattern, ["house of spirit"])
        self.assertEqual(records[0].category, "pwn")
        self.assertEqual(records[1].libc_versions, ["glibc 2.23-2.29"])

    def test_excludes_summary_and_footer_after_source_sections(self):
        article = """## 2.30-House of Snake
technique body
## 3-总结
备案信息和版权页脚
"""

        records = records_from_article(article)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].challenge, "House of Snake")
        self.assertNotIn("备案", records[0].text_chunk)


if __name__ == "__main__":
    unittest.main()
