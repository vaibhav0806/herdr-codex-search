import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SourceTextModule, SyntheticModule } from "node:vm";

async function setup({ local = false, resumable = true } = {}) {
  const commands = [];
  const closed = [];
  const modules = {
    "gpui-kit": { View: class {}, div() {}, svg() {} },
    "gpui-base": { h_flex() {}, v_flex() {}, InputState: {}, Input: {}, TextView: {} },
    "herdr": {
      appHome: () => "/app", closeOverlay: id => closed.push(id), exec() {}, focused() {},
      props: () => ({ overlay: "search-overlay" }), run: (name, args) => commands.push({ name, args }),
      spaces: () => [{ id: "remote", machine: "vps", folder: "/projects/one" }, ...(local ? [{ id: "local", machine: null, folder: "/projects/one" }] : [])],
      terminals: () => [], theme() {},
    },
  };
  const mod = new SourceTextModule(await readFile(new URL("./main.js", import.meta.url), "utf8"));
  await mod.link(name => new SyntheticModule(Object.keys(modules[name]), function () {
    for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
  }));
  await mod.evaluate();
  const view = new mod.namespace.default();
  const detail = { id: "thread-id", title: "Fix the callback", cwd: "/projects/one", resumable, codex_home: "/home/codex space", codex: "/bin/codex" };
  Object.assign(view, { loading: false, detail, results: [detail], at: 0 });
  view.call = async () => detail;
  const tasks = [];
  const cx = { spawn(fn) { const promise = fn(cx); tasks.push(promise); }, notify() {} };
  const settle = async () => { while (tasks.length) await Promise.all(tasks.splice(0)); };
  return { view, detail, commands, closed, cx, settle };
}

test("resume stays on this Mac even when the focused repository exists on a remote machine", async () => {
  const { view, commands, closed, cx, settle } = await setup();
  view.resume(cx);
  await settle();
  assert.equal(commands[0].name, "space.new");
  assert.equal(commands[0].args.machine, "");
  assert.equal(commands[0].args.folder, "/projects/one");
  assert.deepEqual(commands[0].args.argv, ["env", "CODEX_HOME=/home/codex space", "/bin/codex", "resume", "thread-id", "--no-daemon", "--cd", "/projects/one"]);
  assert.deepEqual(closed, ["search-overlay"]);
});

test("resume uses an existing local project space instead of its remote counterpart", async () => {
  const { view, commands, cx, settle } = await setup({ local: true });
  view.resume(cx);
  await settle();
  assert.equal(commands[0].name, "tab.new");
  assert.equal(commands[0].args.space, "local");
});

test("a transcript removed after preview does not launch a terminal", async () => {
  const { view, commands, closed, cx, settle } = await setup();
  view.call = async () => ({ ...view.detail, resumable: false, available: false });
  view.resume(cx);
  await settle();
  assert.equal(commands.length, 0);
  assert.equal(closed.length, 0);
});

test("repeated Enter while resume is validating launches just one tab", async () => {
  const { view, commands, cx, settle } = await setup({ local: true });
  view.resume(cx);
  view.resume(cx);
  await settle();
  assert.equal(commands.length, 1);
});

test("conversation preview excludes generated memory bookkeeping while keeping the answer", async () => {
  const { view } = await setup();
  const text = "OAuth refresh verified.\n\n<oai-mem-citation>\n<citation_entries>private bookkeeping</citation_entries>\n</oai-mem-citation>\n\nCI is green; not merged.";
  assert.equal(view.displayText(text), "OAuth refresh verified.\n\nCI is green; not merged.");
});
