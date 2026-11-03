import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, TextView } from "gpui-base";
import { appHome, closeOverlay, exec, focused, props, run, spaces, terminals, theme } from "herdr";

const shortTitle = (s) => s.split("\n").find(s => s.trim())?.trim() || "Untitled conversation";
const projectName = (path) => path?.replace(/\/$/, "").split("/").pop() || "Home";
const dateLabel = (seconds) => {
  const date = new Date(seconds * 1000);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en", { month: "short", day: "numeric" });
};

export default class ThreadSearch extends View {
  init(_props, cx) {
    if (props()?.launcher) { this.width = 268; return; }
    this.query = props()?.query ?? "";
    this.input = InputState.new({ placeholder: "Search your Codex conversations…", value: this.query });
    this.handle = cx.focus_handle();
    this.results = [];
    this.at = 0;
    this.start = 0;
    this.searchVersion = 0;
    this.detailVersion = 0;
    this.loading = true;
    this.syncing = false;
    this.project = false;
    this.recent = false;
    this.automations = false;
    this.currentFolder = focused()?.cwd;
    this.stats = {};
    this.error = "";
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      const version = ++this.searchVersion;
      this.loading = true;
      this.detail = null;
      this.detailVersion++;
      cx.timer.after(180, (cx) => {
        if (version === this.searchVersion) this.search(cx);
      });
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.resume(cx));
    this.input.focus();
    this.search(cx);
    this.refresh(cx);
  }

  async call(action, args = []) {
    const result = await exec("python3", [appHome() + "/mods/thread-search/search.py", "--data", appHome() + "/data/thread-search", action, ...args]);
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Error(result.stderr?.trim() || "Search did not return a result. Try refreshing."); }
    if (result.code !== 0 || data.error) throw new Error(data.error || result.stderr || "Search failed.");
    return data;
  }

  refresh(cx) {
    if (this.syncing) return;
    this.syncing = true;
    this.syncError = "";
    cx.spawn(async (cx) => {
      try {
        let pending;
        do {
          const data = await this.call("sync");
          this.stats = data;
          pending = data.pending;
          this.search(cx);
          cx.notify();
        } while (pending);
      } catch (e) {
        this.syncError = String(e.message ?? e);
      }
      this.syncing = false;
      cx.notify();
    });
    cx.notify();
  }

  search(cx) {
    const version = ++this.searchVersion;
    const args = ["--query", this.query];
    if (this.project && this.currentFolder) args.push("--project", this.currentFolder);
    if (this.recent) args.push("--days", "14");
    if (this.automations) args.push("--automations");
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const data = await this.call("search", args);
        if (version !== this.searchVersion) return;
        this.results = data.results;
        this.stats = { ...this.stats, ...data };
        this.at = 0;
        this.start = 0;
        this.error = "";
        this.select(0, cx);
      } catch (e) {
        if (version !== this.searchVersion) return;
        this.error = String(e.message ?? e);
        this.results = [];
        this.detail = null;
      }
      this.loading = false;
      cx.notify();
    });
  }

  select(index, cx) {
    this.at = Math.max(0, Math.min(index, this.results.length - 1));
    if (this.at < this.start) this.start = this.at;
    if (this.at >= this.start + this.visibleRows()) this.start = this.at - this.visibleRows() + 1;
    const row = this.results[this.at];
    this.detail = null;
    const version = ++this.detailVersion;
    if (row) cx.spawn(async (cx) => {
      try {
        const data = await this.call("detail", ["--id", row.id, "--query", this.query]);
        if (version !== this.detailVersion) return;
        this.detail = data;
      } catch (e) {
        if (version !== this.detailVersion) return;
        this.detail = { error: String(e.message ?? e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  visibleRows() {
    return Math.max(2, Math.floor((this.listHeight ?? 400) / 78));
  }

  dismiss() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  resume(cx) {
    const detail = this.detail;
    if (this.loading || this.resuming || !detail?.resumable || detail.id !== this.results[this.at]?.id) return;
    this.resuming = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const fresh = await this.call("detail", ["--id", detail.id]);
        if (!fresh.resumable) {
          this.detail = fresh;
          cx.notify();
          return;
        }
        const existing = terminals().find(t => t.state === "live" && t.argv?.includes(fresh.id));
        if (existing) run("agent.focus", { terminal: existing.address });
        else {
          const space = spaces().find(s => !s.machine && s.folder === fresh.cwd);
          const argv = ["env", `CODEX_HOME=${fresh.codex_home}`, fresh.codex, "resume", fresh.id, "--no-daemon", "--cd", fresh.cwd];
          const name = shortTitle(fresh.title).slice(0, 60);
          if (space) run("tab.new", { space: space.id, name, folder: fresh.cwd, argv });
          else run("space.new", { name: projectName(fresh.cwd), folder: fresh.cwd, machine: "", tab: name, argv });
        }
        this.dismiss();
      } catch (e) {
        this.error = String(e.message ?? e);
        cx.notify();
      } finally {
        this.resuming = false;
      }
    });
  }

  pill(id, label, on, action) {
    const t = theme();
    return div().id(id).px(9).py(5).rounded(6).text_size(11)
      .text_color(on ? t.foreground : t.muted).bg(on ? t.selected : t.popover)
      .hover(s => s.bg(t.hover)).cursor_pointer().on_click(action).child(label);
  }

  displayText(text) {
    return text.replace(/\s*<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>\s*/g, "\n\n").trim();
  }

  preview(t) {
    const row = this.results[this.at];
    const detail = this.detail;
    if (!row) return v_flex().size_full().items_center().justify_center().gap(12)
      .child(svg("mods/workspace-chrome/search.svg").size(28).text_color(t.dim))
      .child(div().text_size(13).text_color(t.muted).child("Find the conversation you remember."));
    return v_flex().size_full().min_w(0).gap(15).p(22)
      .child(div().text_size(10).font_semibold().text_color(t.dim).child(this.query ? "CONVERSATION PREVIEW" : "RECENT CONVERSATION"))
      .child(div().text_size(18).font_semibold().text_color(t.foreground).child(shortTitle(row.title).slice(0, 240)))
      .child(div().text_size(11).text_color(t.dim).child(row.cwd))
      .child(div().h(1).bg(t.border).flex_none())
      .child(v_flex().id("thread-preview-scroll").flex_1().min_h(0).overflow_y_scrollbar().gap(18)
        .when(!row.available, el => el.child(v_flex().gap(8)
          .child(div().text_size(13).text_color(t.muted).child("Transcript unavailable"))
          .child(div().text_size(12).text_color(t.dim).child("Codex still lists this thread, but its conversation file is no longer on this Mac. You can find its title, but cannot preview or resume it here."))))
        .when(Boolean(detail?.error), el => el.child(div().text_size(12).text_color(t.blocked).child(detail.error)))
        .when(row.available && !detail, el => el.child(div().text_size(12).text_color(t.dim).child("Loading preview…")))
        .when(row.available && detail && !detail.messages?.length && !detail.error, el => el.child(div().text_size(12).text_color(t.dim).child("The conversation is still being indexed. Preview will appear when indexing finishes.")))
        .children((detail?.messages ?? []).map((message, i) => v_flex().gap(7)
          .child(h_flex().gap(8).items_center()
            .child(div().text_size(10).font_semibold().text_color(message.role === "user" ? t.accent : t.muted).child(message.role === "user" ? "YOU" : "CODEX"))
            .child(div().text_size(10).text_color(t.dim).child(message.timestamp?.slice(0, 10) ?? "")))
          .child(TextView.markdown(`thread-message-${row.id}-${i}-${this.detailVersion}`, this.displayText(message.text)).text_size(12).text_color(t.foreground)))))
      .when(detail?.available && !detail.resumable, el => el.child(div().text_size(11).text_color(t.blocked).child(detail.resume_error)));
  }

  render(cx) {
    const t = theme();
    if (props()?.launcher) return h_flex().id("thread-search-launcher").size_full().px(9).pb(7)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } })
      .child(h_flex().id("open-thread-search").size_full().px(10).gap(9).items_center().rounded(7).border_1().border_color(t.border).bg(t.background)
        .text_color(t.muted).text_size(12).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(() => run("mod.open", { name: "thread-search" }))
        .child(svg("mods/workspace-chrome/search.svg").size(14).flex_none())
        .when(this.width >= 160, el => el.child(div().flex_1().child("Search threads"))
          .child(div().text_size(10).text_color(t.dim).child("⌘⇧K"))));
    const shown = this.results.slice(this.start, this.start + this.visibleRows());
    const ready = !this.loading && !this.resuming && this.detail?.resumable;
    return v_flex().id("thread-search").size_full().min_h(0).overflow_hidden().bg(t.popover).text_size(13).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        if (event.key === "escape") { this.dismiss(); return; }
        if (event.key === "down" || event.key === "up") {
          this.select(this.at + (event.key === "down" ? 1 : -1), cx);
          cx.stop_propagation();
        }
      })
      .child(h_flex().h(60).flex_none().px(22).gap(13).items_center()
        .child(svg("mods/workspace-chrome/search.svg").size(23).text_color(t.accent))
        .child(Input.new(this.input).flex_1().h(46).text_size(21).text_color(t.foreground))
        .child(div().text_size(10).text_color(t.dim).border_1().border_color(t.border).rounded(5).px(6).py(3).child("esc")))
      .child(h_flex().h(36).flex_none().px(15).gap(5).items_center().border_t(1).border_color(t.border)
        .child(this.pill("threads-all", "All projects", !this.project, (_e, cx) => { this.project = false; this.search(cx); }))
        .when(Boolean(this.currentFolder), el => el.child(this.pill("threads-project", "This project", this.project, (_e, cx) => { this.project = true; this.search(cx); })))
        .child(div().w(1).h(14).mx(5).bg(t.border))
        .child(this.pill("threads-recent", "Past 2 weeks", this.recent, (_e, cx) => { this.recent = !this.recent; this.search(cx); }))
        .child(this.pill("threads-automations", "Include automations", this.automations, (_e, cx) => { this.automations = !this.automations; this.search(cx); }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(this.loading ? "Searching…" : this.stats.matched > this.results.length ? `${this.results.length} of ${this.stats.matched} threads` : `${this.stats.matched ?? 0} threads`)))
      .child(h_flex().flex_1().min_h(0).items_stretch().border_t(1).border_color(t.border)
        .child(v_flex().w(390).h_full().flex_none().min_h(0).border_r(1).border_color(t.border).bg(t.chrome)
          .child(h_flex().h(33).flex_none().px(17).items_center().justify_between().text_size(10).text_color(t.dim)
            .child(this.query ? "MATCHING THREADS" : "RECENT THREADS")
            .when(Boolean(this.results.length), el => el.child(`${this.at + 1} / ${this.results.length}`)))
          .child(v_flex().id("thread-results").flex_1().min_h(0).px(6)
            .on_size_change((size, cx) => { if (this.listHeight !== size.height) { this.listHeight = size.height; cx.notify(); } })
            .on_scroll_wheel((event, cx) => { this.select(this.at + (event.delta.y < 0 ? 1 : -1), cx); cx.stop_propagation(); })
            .when(Boolean(this.error), el => el.child(div().p(16).text_size(12).text_color(t.blocked).child(this.error)))
            .when(!this.loading && !this.results.length && !this.error, el => el.child(v_flex().p(18).gap(10)
              .child(div().text_size(15).font_semibold().child("No threads found"))
              .child(div().text_size(12).text_color(t.muted).child("Try a project name, a PR number, or a few words from a conversation."))))
            .children(shown.map((row, i) => {
              const index = this.start + i;
              const selected = index === this.at;
              return v_flex().id(`thread-${row.id}`).h(74).flex_none().px(12).py(8).gap(4).mb(4).rounded(8)
                .bg(selected ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
                .on_click((_e, cx) => { this.select(index, cx); this.input.focus(); })
                .child(h_flex().gap(8).items_center()
                  .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(shortTitle(row.title)))
                  .child(div().flex_none().text_size(10).text_color(t.dim).child(dateLabel(row.updated_at))))
                .child(div().truncate().text_size(11).text_color(selected ? t.foreground : t.muted).child(row.available ? row.snippet : "Transcript unavailable · title only"))
                .child(h_flex().gap(6).items_center().text_size(10).text_color(t.dim)
                  .child(div().truncate().child(projectName(row.cwd)))
                  .when(Boolean(row.match_role), el => el.child(`· ${row.match_role === "user" ? "Your message" : "Codex reply"}`))
                  .when(row.automation, el => el.child("· Automation")));
            }))))
        .child(div().flex_1().h_full().min_w(0).min_h(0).child(this.preview(t))))
      .child(h_flex().h(40).flex_none().px(18).gap(12).items_center().border_t(1).border_color(t.border)
        .child(div().text_size(10).text_color(t.dim).child("↑ ↓ Select"))
        .child(div().id("threads-refresh").text_size(10).text_color(this.syncError ? t.blocked : t.dim).cursor_pointer().on_click((_e, cx) => this.refresh(cx))
          .child(this.syncError ? "Refresh failed · retry" : this.syncing ? "Indexing conversations…" : `${this.stats.indexed ?? 0} local transcripts · Refresh`))
        .child(div().flex_1())
        .child(div().id("threads-resume").px(12).py(7).rounded(6).bg(ready ? t.solid : t.raised).text_color(ready ? t.solid_foreground : t.dim).text_size(11)
          .when(Boolean(ready), el => el.cursor_pointer().hover(s => s.opacity(0.85)))
          .on_click((_e, cx) => this.resume(cx)).child("↵  Resume in new tab")));
  }
}
