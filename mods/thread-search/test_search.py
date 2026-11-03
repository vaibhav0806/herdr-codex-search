import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "codex"
        self.home.mkdir()
        self.data = Path(self.temp.name) / "index"
        self.db = sqlite3.connect(self.home / "state_5.sqlite")
        self.db.execute("CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, source TEXT)")
        self.addCleanup(self.db.close)

    def thread(self, id, title, messages, source="vscode", cwd="/projects/studio"):
        path = self.home / f"{id}.jsonl"
        if messages is not None:
            with path.open("w") as f:
                for role, text in messages:
                    f.write(json.dumps({"type": "response_item", "timestamp": "2026-11-02T12:00:00Z", "payload": {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}], "phase": "final_answer"}}) + "\n")
        self.db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?)", (id, title, cwd, 1793620800, str(path), source))
        self.db.commit()
        return path

    def run_search(self, action, *args):
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("search.py")), "--home", str(self.home), "--data", str(self.data), action, *args], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def test_finds_conversation_text_under_an_unrelated_title_without_indexing_instructions(self):
        self.thread("one", "Server maintenance", [("developer", "hidden-sentinel"), ("user", "How do I learn system design?"), ("assistant", "Use visual puzzles and bottleneck simulations.")])
        self.run_search("sync")
        results = self.run_search("search", "--query", "bottleneck")
        self.assertEqual([r["id"] for r in results["results"]], ["one"])
        self.assertIn("bottleneck", results["results"][0]["snippet"])
        self.assertEqual(self.run_search("search", "--query", "hidden-sentinel")["results"], [])

    def test_missing_transcripts_remain_searchable_but_cannot_be_resumed(self):
        self.thread("gone", "Eve migration", None)
        self.run_search("sync")
        row = self.run_search("search", "--query", "Eve")["results"][0]
        self.assertFalse(row["available"])
        self.assertFalse(self.run_search("detail", "--id", "gone")["resumable"])

    def test_refresh_updates_changed_messages_and_removes_deleted_metadata(self):
        path = self.thread("one", "Old topic", [("user", "initialmessage")])
        self.run_search("sync")
        with path.open("a") as f:
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "user_message", "message": "newlyappendedterm"}}) + "\n")
        self.run_search("sync")
        self.assertEqual(self.run_search("search", "--query", "newlyappendedterm")["results"][0]["id"], "one")
        self.db.execute("DELETE FROM threads")
        self.db.commit()
        self.run_search("sync")
        self.assertEqual(self.run_search("search", "--query", "initialmessage")["results"], [])

    def test_punctuation_is_literal_and_filters_exclude_automation_and_subagents(self):
        self.thread("human", "PR #987 — OAuth", [("user", "Fix oauth callback")])
        self.thread("automation", "Automation: OAuth digest", [("user", "oauth")])
        self.thread("worker", "OAuth worker", [("user", "oauth")], source='{"subagent":"review"}')
        self.run_search("sync")
        self.assertEqual([r["id"] for r in self.run_search("search", "--query", "PR #987")["results"]], ["human"])
        self.assertEqual([r["id"] for r in self.run_search("search", "--query", "oauth")["results"]], ["human"])
        self.assertEqual(len(self.run_search("search", "--query", "oauth", "--automations")["results"]), 2)
        self.assertEqual(self.run_search("search", "--query", "oauth", "--project", "/another/project")["results"], [])
        self.run_search("search", "--query", '" OR * : (')

    def test_source_database_and_transcript_are_read_only_and_detail_shows_matching_message(self):
        path = self.thread("one", "Topic", [("user", "earlier message"), ("assistant", "uniqueanswer in a later reply")])
        db_before = (self.home / "state_5.sqlite").read_bytes()
        log_before = path.read_bytes()
        self.run_search("sync")
        detail = self.run_search("detail", "--id", "one", "--query", "uniqueanswer")
        self.assertEqual(detail["messages"][0]["role"], "assistant")
        self.assertIn("uniqueanswer", detail["messages"][0]["text"])
        self.assertEqual((self.home / "state_5.sqlite").read_bytes(), db_before)
        self.assertEqual(path.read_bytes(), log_before)


if __name__ == "__main__":
    unittest.main()
