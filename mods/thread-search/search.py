import argparse
import fcntl
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from pathlib import Path


def connect(data):
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = data / "threads.sqlite"
    db = sqlite3.connect(path, timeout=3)
    os.chmod(path, 0o600)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, rollout_path TEXT, available INTEGER, automation INTEGER, stamp TEXT)")
    db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(thread_id UNINDEXED, role UNINDEXED, timestamp UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')")
    return db


def source_threads(home):
    paths = sorted(home.glob("state_*.sqlite"), key=lambda p: int(p.stem.split("_")[-1]), reverse=True)
    if not paths:
        raise ValueError(f"No Codex session database found in {home}")
    with sqlite3.connect(paths[0].as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        return [dict(r) for r in db.execute("SELECT id, title, cwd, updated_at, rollout_path FROM threads WHERE source IN ('cli', 'vscode') ORDER BY updated_at DESC")]


def transcript(path):
    seen = set()
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            p = event.get("payload", {})
            role, text = None, ""
            if event.get("type") == "response_item" and p.get("type") == "message":
                role = p.get("role")
                if role not in ("user", "assistant"):
                    continue
                if role == "assistant" and p.get("phase") not in (None, "final_answer"):
                    continue
                text = "\n".join(c.get("text", "") for c in p.get("content", []) if isinstance(c, dict))
            elif event.get("type") == "event_msg" and p.get("type") in ("user_message", "agent_message"):
                role = "user" if p["type"] == "user_message" else "assistant"
                text = p.get("message", "")
            if not isinstance(text, str) or not text.strip():
                continue
            if text.startswith(("# AGENTS.md", "<environment_context>", "<permissions", "<skill>", "<external_codex_apps_open_page>")):
                continue
            key = (role, text)
            if key in seen:
                continue
            seen.add(key)
            yield (role, event.get("timestamp", ""), text)


def counts(db):
    row = db.execute("SELECT count(*) AS total, coalesce(sum(available), 0) AS available, coalesce(sum(stamp IS NOT NULL), 0) AS indexed FROM threads").fetchone()
    return dict(row)


def sync(db, home, data, budget):
    with (data / "sync.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {**counts(db), "pending": True}
        rows = source_threads(home)
        ids = {r["id"] for r in rows}
        for old in db.execute("SELECT id FROM threads").fetchall():
            if old["id"] not in ids:
                db.execute("DELETE FROM messages WHERE thread_id=?", (old["id"],))
                db.execute("DELETE FROM threads WHERE id=?", (old["id"],))
        changed = []
        for r in rows:
            path = Path(r["rollout_path"])
            try:
                stat = path.stat()
                stamp = f"{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}"
            except FileNotFoundError:
                stamp = None
            old = db.execute("SELECT stamp FROM threads WHERE id=?", (r["id"],)).fetchone()
            title = r["title"].strip() or "Untitled conversation"
            automation = title.startswith("Automation:")
            db.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, cwd=excluded.cwd, updated_at=excluded.updated_at, rollout_path=excluded.rollout_path, available=excluded.available, automation=excluded.automation", (r["id"], title, r["cwd"], r["updated_at"], str(path), int(stamp is not None), int(automation), None))
            if stamp is None:
                db.execute("DELETE FROM messages WHERE thread_id=?", (r["id"],))
                db.execute("UPDATE threads SET stamp=NULL WHERE id=?", (r["id"],))
            elif old is None or old["stamp"] != stamp:
                changed.append((r["id"], path, stamp))
        db.commit()
        start = time.monotonic()
        done = 0
        for id, path, stamp in changed:
            if done and time.monotonic() - start > budget:
                break
            try:
                messages = [(id, *m) for m in transcript(path)]
            except FileNotFoundError:
                continue
            with db:
                db.execute("DELETE FROM messages WHERE thread_id=?", (id,))
                db.executemany("INSERT INTO messages VALUES (?,?,?,?)", messages)
                db.execute("UPDATE threads SET stamp=? WHERE id=?", (stamp, id))
            done += 1
        return {**counts(db), "pending": done < len(changed)}


def match_query(query):
    tokens = re.findall(r"\w+", query, flags=re.UNICODE)
    return " AND ".join('"' + t + '"*' for t in tokens[:16])


def summarize(text, query, length=220):
    text = " ".join(text.split())
    tokens = re.findall(r"\w+", query)
    match = re.search("|".join(re.escape(t) for t in tokens), text, re.I) if tokens else None
    start = max(0, match.start() - 60) if match else 0
    return ("…" if start else "") + text[start:start + length] + ("…" if len(text) > start + length else "")


def search(db, args):
    where, params = [], []
    if not args.automations:
        where.append("automation=0")
    if args.project:
        where.append("cwd=?")
        params.append(args.project)
    if args.days:
        where.append("updated_at>=?")
        params.append(int(time.time()) - args.days * 86400)
    rows = db.execute("SELECT * FROM threads" + (" WHERE " + " AND ".join(where) if where else ""), params).fetchall()
    q = args.query.strip().lower()
    tokens = re.findall(r"\w+", q)
    matches = {}
    fts = match_query(q)
    if fts:
        for r in db.execute("SELECT thread_id, text, role, bm25(messages) AS rank FROM messages WHERE messages MATCH ? ORDER BY rank LIMIT 2000", (fts,)):
            if r["thread_id"] not in matches:
                matches[r["thread_id"]] = r
    results = []
    for r in rows:
        title = r["title"].lower()
        haystack = title + " " + r["cwd"].lower() + " " + r["id"]
        title_match = bool(tokens) and all(t in haystack for t in tokens)
        body = matches.get(r["id"])
        if q and not title_match and body is None:
            continue
        score = (100 if title_match else 0) + (80 if q and q in title else 0) + (min(40, -body["rank"]) if body else 0)
        result = {k: r[k] for k in ("id", "title", "cwd", "updated_at")}
        result.update(available=bool(r["available"]), indexed=r["stamp"] is not None, automation=bool(r["automation"]), snippet=summarize(body["text"] if body else r["title"], q), match_role=body["role"] if body else None, score=score)
        results.append(result)
    results.sort(key=lambda r: (-r["score"], -r["updated_at"]))
    return {"results": results[:60], "matched": len(results), **counts(db)}


def detail(db, args):
    row = db.execute("SELECT * FROM threads WHERE id=?", (args.id,)).fetchone()
    if row is None:
        raise ValueError("This thread is no longer in Codex history. Refresh and search again.")
    fts = match_query(args.query)
    messages = []
    if fts:
        messages = db.execute("SELECT role, timestamp, text FROM messages WHERE messages MATCH ? AND thread_id=? ORDER BY bm25(messages) LIMIT 4", (fts, args.id)).fetchall()
    if not messages:
        messages = list(reversed(db.execute("SELECT role, timestamp, text FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 4", (args.id,)).fetchall()))
    path = Path(row["rollout_path"])
    exists = path.is_file()
    codex = shutil.which("codex")
    folder_exists = Path(row["cwd"]).is_dir()
    reason = "" if exists and folder_exists and codex else "Transcript unavailable." if not exists else "The original project folder is missing." if not folder_exists else "Codex CLI was not found on Herdr's PATH."
    return {"id": row["id"], "title": row["title"], "cwd": row["cwd"], "resumable": exists and folder_exists and bool(codex), "resume_error": reason, "codex_home": str(args.home.resolve()), "codex": codex, "available": exists, "messages": [{"role": r["role"], "timestamp": r["timestamp"], "text": r["text"][:6000]} for r in messages]}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", type=Path, default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    parser.add_argument("--data", type=Path, default=Path(os.environ.get("HERDR_APP_HOME", str(Path.home() / ".config/herdr-app"))) / "data/thread-search")
    parser.add_argument("action", choices=("sync", "search", "detail"))
    parser.add_argument("--query", default="")
    parser.add_argument("--id")
    parser.add_argument("--project")
    parser.add_argument("--days", type=int)
    parser.add_argument("--automations", action="store_true")
    parser.add_argument("--budget", type=float, default=4)
    args = parser.parse_args()
    with connect(args.data) as db:
        if args.action == "sync":
            result = sync(db, args.home, args.data, args.budget)
        elif args.action == "search":
            result = search(db, args)
        else:
            result = detail(db, args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (sqlite3.Error, OSError, ValueError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
