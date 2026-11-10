import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, agents, hc } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify({ ...location(), tab: focused()?.tab });
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const DIFF_PAGE_SIZE = 80;
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

function diffPalette(t) {
  const hex = t.background.replace("#", "");
  const channels = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  const light = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 150;
  return light
    ? { add: "#d6f5dc", del: "#ffdadf", addGutter: "#a9e9b8", delGutter: "#ffb6c2", addText: "#075d29", delText: "#9b1234", selection: "#c8e1ff", selectionGutter: "#0969da", selectionText: "#082f60", selectionEdge: "#0550ae" }
    : { add: "#163d29", del: "#48212b", addGutter: "#215e39", delGutter: "#713041", addText: "#b8f5cc", delText: "#ffd0d9", selection: "#234f86", selectionGutter: "#3478c5", selectionText: "#ffffff", selectionEdge: "#9acaff" };
}

const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0, hunk = 0;
  return lines.map((line, index) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line, index, hunk: ++hunk }; }
    const kind = line[0];
    if (kind === "-") return { kind, index, hunk, oldNumber: old, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, index, hunk, newNumber: next, number: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, index, hunk, oldNumber: old++, newNumber: next, number: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

export default class Changes extends View {
  init(_props, cx) {
    this.files = []; this.rows = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    try { this.reviews = JSON.parse(localStorage.getItem("reviews.v1") ?? "{}"); } catch { this.reviews = {}; }
    this.editors = {};
    this.editorFocus = {};
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy || this.selection) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.diffPage = 0;
      this.context = context; this.root = null; this.files = []; this.open = null;
      this.setLines([]); this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.closed = false; this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const stats = {};
        const results = head.code === 0 ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        const files = [];
        const entries = status.stdout.split("\0").filter(Boolean);
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          const stat = stats[path] ?? { add: 0, del: 0 };
          files.push({ path, status: s, fresh, ...stat });
        }
        // Git's numstat excludes untracked files. Count their text without
        // requiring the user to open each file; bound concurrent disk reads.
        let next = 0;
        const freshFiles = files.filter(file => file.fresh);
        await Promise.all(Array.from({ length: Math.min(4, freshFiles.length) }, async () => {
          while (next < freshFiles.length) {
            const file = freshFiles[next++];
            const text = await readTextFile(`${root}/${file.path}`, { on }).catch(() => null);
            file.binary = text !== null && text.includes("\0");
            file.countUnavailable = text === null;
            if (text !== null && !file.binary) file.add = countLines(text);
          }
        }));
        if (key() !== context) return;
        this.root = root; this.on = on; this.hasHead = head.code === 0; this.files = files; this.limited = entries.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = text.length === 0 ? ["Empty file · 0 lines"] : [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(380, ...lines.map(line => line.length * 7 + 80));
    this.diffPage = Math.min(this.diffPage ?? 0, Math.max(0, Math.ceil(this.rows.length / DIFF_PAGE_SIZE) - 1));
  }

  pick(path, cx) {
    this.selection = null; this.diffPage = 0; this.activeComment = null;
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  review() {
    const f = focused();
    if (!f?.tab || !this.root || this.context !== key()) return null;
    const id = JSON.stringify([f.space, f.tab, this.on ?? null, this.root]);
    return this.reviews[id] ??= { id, tab: f.tab, space: f.space, root: this.root, comments: [], address: null };
  }

  saveReviews() { localStorage.setItem("reviews.v1", JSON.stringify(this.reviews)); }

  editor(c, review, cx) {
    if (!this.editors[c.id]) {
      this.editorFocus ??= {};
      this.editorFocus[c.id] = cx.focus_handle();
      const input = TextareaState.new({ value: c.body, placeholder: "Leave a review comment…", rows: 3 });
      input.on("focus", () => { this.activeComment = { c, review }; });
      input.on("change", (_e, cx) => {
        this.lastInputEdit ??= {};
        this.lastInputEdit[c.id] = { before: c.body, after: input.value() };
        c.body = input.value(); this.saveReviews(); cx.notify();
      });
      input.on("submit", (event, cx) => this.submitComment(event, c, review, input, cx));
      this.editors[c.id] = input;
    }
    return this.editors[c.id];
  }

  lineNumber(row, side) {
    if (!row || row.number === undefined || row.kind === "@") return undefined;
    if (side === "old") return row.oldNumber ?? (row.kind === "-" ? row.number : undefined);
    return row.newNumber ?? (row.kind !== "-" ? row.number : undefined);
  }

  startSelection(row, cx, event) {
    if (this.sending || !this.review() || row.number === undefined) return;
    this.selection = { path: this.open, context: this.context, start: row.index, end: row.index,
      side: row.kind === "-" ? "old" : "new", hunk: row.hunk };
    if (event?.modifiers.shift && this.lineAnchor?.path === this.open && this.lineAnchor.context === this.context
      && this.lineAnchor.hunk === row.hunk && this.lineNumber(row, this.lineAnchor.side) !== undefined) {
      this.selection.start = this.lineAnchor.index; this.selection.side = this.lineAnchor.side;
    } else this.lineAnchor = { path: this.open, context: this.context, index: row.index, side: this.selection.side, hunk: row.hunk };
    cx.stop_propagation(); cx.notify();
  }

  extendSelection(row, cx) {
    const selection = this.selection;
    if (!selection || selection.path !== this.open || selection.context !== this.context
      || row.hunk !== selection.hunk || this.lineNumber(row, selection.side) === undefined) return;
    if (selection.end !== row.index) { selection.end = row.index; cx.notify(); }
  }

  finishSelection(cx) {
    const selection = this.selection;
    this.selection = null;
    if (!selection || selection.path !== this.open || selection.context !== key()) { cx.notify(); return; }
    const low = Math.min(selection.start, selection.end), high = Math.max(selection.start, selection.end);
    const rows = this.rows.filter(row => row.index >= low && row.index <= high && row.hunk === selection.hunk
      && this.lineNumber(row, selection.side) !== undefined);
    if (!rows.length) { cx.notify(); return; }
    this.beginComment(rows[0], cx, rows, selection.side);
  }

  beginComment(row, cx, range = row ? [row] : [], side = row?.kind === "-" ? "old" : "new") {
    const review = this.review();
    if (!review || !this.open || this.sending) return;
    const first = range[0], last = range[range.length - 1];
    const number = this.lineNumber(first, side), endNumber = this.lineNumber(last, side);
    // Reopen the thread rather than creating another draft at the same anchor.
    let c = review.comments.find(item => item.path === this.open && item.number === number
      && (item.endNumber ?? item.number) === endNumber && item.side === side);
    if (!c) {
      c = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, path: this.open,
        number, endNumber, side, code: first ? range.map(r => r.text).join("\n") : undefined,
        endCode: last?.text, body: "", editing: true };
      review.comments.push(c);
    }
    // Empty placeholders are disposable; typed drafts remain available.
    review.comments = review.comments.filter(item => item === c || item.body.trim());
    for (const [id, input] of Object.entries(this.editors)) {
      if (!Object.values(this.reviews).some(r => r.comments.some(item => item.id === id))) { input.release(); delete this.editors[id]; }
    }
    if (!c.editing) c.savedBody = c.body;
    c.editing = true;
    this.activeComment = { c, review };
    this.editor(c, review, cx).focus();
    this.saveReviews(); cx.notify();
  }

  lineLabel(c) {
    return c.number === undefined ? "File comment" : `${c.side} ${c.endNumber && c.endNumber !== c.number ? `lines ${c.number}–${c.endNumber}` : `line ${c.number}`}`;
  }

  submitComment(event, c, review, input, cx) {
    // Native multiline inputs emit submit *after* inserting the newline.
    // Shift+Enter keeps that newline; plain Enter confirms the draft.
    if (event.shift || event.secondary || this.sending || !c.editing || this.review() !== review) return;
    const value = input.value();
    const edit = this.lastInputEdit?.[c.id];
    const before = value !== c.body ? c.body : edit?.after === value ? edit.before : value;
    let at = 0;
    while (at < before.length && before[at] === value[at]) at++;
    c.body = value.length === before.length + 1 && value[at] === "\n"
      && value.slice(at + 1) === before.slice(at) ? before : value;
    if (this.lastInputEdit) delete this.lastInputEdit[c.id];
    input.set_value(c.body);
    this.addComment(c, cx);
  }

  addComment(c, cx) {
    if (this.sending || !c?.body.trim()) return;
    c.editing = false; c.savedBody = c.body;
    this.selection = null;
    if (this.activeComment?.c === c) this.activeComment = null;
    this.saveReviews(); this.handle.focus(); cx.notify();
  }

  removeComment(c, review, cx) {
    if (this.sending) return;
    review.comments = review.comments.filter(item => item.id !== c.id);
    this.editors[c.id]?.release(); delete this.editors[c.id];
    if (this.activeComment?.c === c) this.activeComment = null;
    this.selection = null;
    this.saveReviews(); this.handle.focus(); cx.notify();
  }

  cancelComment(c, review, cx) {
    if (this.sending) return;
    if (c.savedBody !== undefined) {
      c.body = c.savedBody; c.editing = false; this.editors[c.id]?.set_value(c.body);
    } else { this.removeComment(c, review, cx); return; }
    this.selection = null;
    this.activeComment = null; this.saveReviews(); this.handle.focus(); cx.notify();
  }

  sendReview(cx) {
    const review = this.review();
    if (!review || this.sending) return;
    const comments = review.comments.filter(c => !c.editing && c.body.trim()).map(c => ({ ...c }));
    const candidates = agents().filter(a => a.tab === review.tab && a.space === review.space);
    const agent = candidates.find(a => a.address === review.address) ?? (!review.address && candidates.length === 1 ? candidates[0] : null);
    if (!comments.length || !agent) return;
    const message = [`Code review · ${comments.length} comments`, `Repository: ${review.root}`, "",
      ...comments.flatMap((c, i) => [`Comment ${i + 1}: ${c.path}${c.number === undefined ? " (file)" : `:${c.number}${c.endNumber && c.endNumber !== c.number ? `-${c.endNumber}` : ""} (${c.side} version)`}`,
        ...(c.code === undefined ? [] : [`Code: ${c.code}`]), c.body.trim(), ""])].join("\n");
    this.sending = true; review.notice = "";
    cx.spawn(async cx => {
      try {
        const result = await hc(["send", agent.address, message]);
        if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Could not send review");
        review.comments = review.comments.filter(c => !comments.some(sent => sent.id === c.id && sent.body === c.body));
        for (const c of comments) { if (!review.comments.some(left => left.id === c.id)) { this.editors[c.id]?.release(); delete this.editors[c.id]; } }
        review.notice = `Sent ${comments.length} comments to ${agent.title || agent.app || agent.address}`;
        this.saveReviews();
      } catch (error) { review.notice = `Review not sent; drafts kept: ${error}`; }
      finally { this.sending = false; cx.notify(); }
    });
    cx.notify();
  }

  commentCard(c, review, t) {
    return v_flex().id(`review-${c.id}`).w(340).flex_none().mx(12).my(10).p(12).gap(10).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .font_family("Geist").text_size(12)
      .child(h_flex().gap(8).child(div().flex_1().text_color(t.dim).child(`${c.editing ? "Draft" : "Pending"} · ${this.lineLabel(c)}`))
        .child(div().cursor_pointer().child("Delete").on_click((_e, cx) => this.removeComment(c, review, cx))))
      .when(c.editing && Boolean(this.editors[c.id]), el => el.child(div().h(88).p(6).rounded(6).bg(t.background).border_1().border_color(t.border).track_focus(this.editorFocus[c.id])
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.editors[c.id]).h_full().text_color(t.foreground))))
      .when(!c.editing || !this.editors[c.id], el => el.child(div().text_color(t.foreground).child(c.body || "Empty draft")))
      .when(c.editing, el => el.child(div().cursor_pointer().text_color(t.dim).child("Cancel")
        .on_click((_e, cx) => this.cancelComment(c, review, cx))))
      .child(div().cursor_pointer().px(10).py(6).rounded(6).bg(c.editing ? t.solid : t.raised).text_color(c.editing ? t.solid_foreground : t.foreground).child(c.editing && this.editors[c.id] ? "Add comment ↵" : "Edit")
        .on_click((_e, cx) => {
          if (this.sending) return;
          if (c.editing && this.editors[c.id]) { this.addComment(c, cx); return; }
          else { c.editing = true; this.editor(c, review, cx).focus(); }
          this.saveReviews(); cx.notify();
        }));
  }

  sameAnchor(c, row) {
    return c.number !== undefined && (c.endNumber ?? c.number) === this.lineNumber(row, c.side) && (c.endCode ?? c.code) === row.text;
  }

  reviewDiff(t) {
    const review = this.review();
    const comments = review?.comments.filter(c => c.path === this.open) ?? [];
    const unmatched = comments.filter(c => !this.rows.some(row => this.sameAnchor(c, row)));
    return v_flex().w_full().min_w(this.diffWidth).flex_none()
      .children(unmatched.map(c => this.commentCard(c, review, t)))
      .children(this.rows.slice((this.diffPage ?? 0) * DIFF_PAGE_SIZE, ((this.diffPage ?? 0) + 1) * DIFF_PAGE_SIZE).map(row => v_flex().flex_none().child(this.diffRow(row, t))
        .children(comments.filter(c => this.sameAnchor(c, row)).map(c => this.commentCard(c, review, t)))));
  }

  reviewFooter(t) {
    const review = this.review();
    if (!review || !review.comments.length && !review.notice) return div();
    const count = review.comments.filter(c => !c.editing && c.body.trim()).length;
    const candidates = agents().filter(a => a.tab === review.tab && a.space === review.space);
    const selected = candidates.find(a => a.address === review.address) ?? (!review.address && candidates.length === 1 ? candidates[0] : null);
    const ready = count && selected && !this.sending;
    return v_flex().flex_none().p(10).gap(6).border_t(1).border_color(t.border)
      .child(div().text_size(12).child(`Pending review · ${count} comments`))
      .when(review.comments.some(c => c.editing && c.body.trim()), el => el.child(div().text_size(11).text_color(t.dim).child("Press Enter or Add comment to include your draft in the review.")))
      .child(v_flex().max_h(90).overflow_y_scroll().children([...new Set(review.comments.map(c => c.path))].map(path =>
        div().id(`review-file-${path}`).text_size(11).truncate().cursor_pointer().text_color(t.accent)
          .child(`${path} (${review.comments.filter(c => c.path === path).length})`)
          .on_click((_e, cx) => { if (this.open !== path) this.pick(path, cx); }))))
      .child(v_flex().children(candidates.map(a => div().id(`review-agent-${a.address}`).text_size(11).cursor_pointer()
        .child(`${selected?.address === a.address ? "●" : "○"} ${a.title || a.app || a.address} · ${a.address}`)
        .on_click((_e, cx) => { if (!this.sending) { review.address = a.address; this.saveReviews(); cx.notify(); } }))))
      .when(!candidates.length, el => el.child(div().text_size(11).text_color(t.dim).child("Start an agent in this tab to send the review.")))
      .when(Boolean(review.notice), el => el.child(div().text_size(11).child(review.notice)))
      .child(div().id("send-review").h(32).px(10).rounded(6).flex().items_center().bg(ready ? t.solid : t.raised)
        .text_color(ready ? t.solid_foreground : t.dim).child(this.sending ? "Sending review…" : `Send review (${count})`)
        .on_click((_e, cx) => { if (ready) this.sendReview(cx); }));
  }

  isSelectedLine(row) {
    const selection = this.selection;
    if (selection) return row.hunk === selection.hunk && row.index >= Math.min(selection.start, selection.end)
      && row.index <= Math.max(selection.start, selection.end) && this.lineNumber(row, selection.side) !== undefined;
    const active = this.activeComment;
    if (!active?.c.editing || active.review !== this.review() || !active.review.comments.includes(active.c) || active.c.path !== this.open) return false;
    const c = active.c, number = this.lineNumber(row, c.side);
    return number !== undefined && c.number !== undefined && number >= c.number && number <= (c.endNumber ?? c.number);
  }

  diffRow(row, t) {
    const { kind, number, text } = row;
    const paint = diffPalette(t);
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    const selected = this.isSelectedLine(row);
    return h_flex().id(`diff-row-${row.index}`).w_full().h(24).flex_none().gap(8)
      .when(kind === "+", e => e.bg(paint.add).text_color(paint.addText))
      .when(kind === "-", e => e.bg(paint.del).text_color(paint.delText))
      .when(Boolean(selected), e => e.bg(paint.selection).text_color(paint.selectionText))
      .on_mouse_move((_e, cx) => this.extendSelection(row, cx))
      .on_mouse_up("left", (_e, cx) => { if (this.selection) { this.finishSelection(cx); cx.stop_propagation(); } })
      .child(h_flex().id(`comment-gutter-${row.index}`).w(60).h_full().flex_none().gap(4).items_center().justify_end().pr(6).text_color(t.dim)
        .when(kind === "+", e => e.bg(paint.addGutter).text_color(paint.addText))
        .when(kind === "-", e => e.bg(paint.delGutter).text_color(paint.delText))
        .border_l(3).border_color(selected ? paint.selectionEdge : "#00000000")
        .when(Boolean(selected), e => e.bg(paint.selectionGutter).text_color("#ffffff").font_semibold())
        .when(number !== undefined, el => el.cursor_pointer().hover(e => e.bg(selected ? paint.selectionGutter : t.selected))
          .on_mouse_down("left", (e, cx) => this.startSelection(row, cx, e)))
        .child(div().w(12).text_color(selected ? "#ffffff" : t.accent).child(number === undefined ? "" : "+"))
        .child(div().w(32).text_right().child(number === undefined ? "" : String(number))))
      .child(div().w(12).flex_none().font_semibold().text_color(selected ? paint.selectionText : kind === "+" ? paint.addText : kind === "-" ? paint.delText : t.dim).child(kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_mouse_down_out((_e, cx) => { if (this.selection) { this.selection = null; cx.notify(); } })
      .on_mouse_up("left", (_e, cx) => { if (this.selection) this.finishSelection(cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.activeComment?.c.editing && this.activeComment.review === this.review()) {
          this.cancelComment(this.activeComment.c, this.activeComment.review, cx); cx.stop_propagation(); return;
        }
        if (e.key === "escape" && this.selection) { this.selection = null; cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .when(Boolean(this.open), el => el.child(div().id("comment-file").text_size(11).cursor_pointer().child("Comment…").on_click((_e, cx) => this.beginComment(null, cx))))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)))
      // overflow_y_scrollbar() wraps the list, so its flex sizing never reached the panel's layout.
      .child(div().h(Math.max(44, Math.min(220, this.files.length * 28 + 12))).flex_none().relative().border_b(1).border_color(t.border)
        .child(v_flex().id("changes-list").absolute().inset_0().overflow_y_scroll().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(!f.binary && !f.countUnavailable && (f.add > 0 || f.status === "A"), (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)))
          .when(f.binary || f.countUnavailable, e => e.child(div().text_size(11).text_color(t.dim).child(f.binary ? "Binary" : "Count unavailable")));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder")))))
        .child(Scrollbar.vertical("changes-list").absolute().inset_0()))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.open), el => el.child(div().flex_none().px(12).py(6).text_size(11).text_color(t.dim).truncate().child(`${this.open} · Click + or drag line numbers to comment`)))
      .when(this.rows.length > DIFF_PAGE_SIZE, el => el.child(h_flex().flex_none().h(30).px(12).gap(10).items_center().text_size(11)
        .child(div().id("diff-prev-page").cursor_pointer().text_color((this.diffPage ?? 0) > 0 ? t.accent : t.dim).child("← Previous")
          .on_click((_e, cx) => { this.diffPage = Math.max(0, (this.diffPage ?? 0) - 1); this.selection = null; cx.notify(); }))
        .child(div().flex_1().text_color(t.dim).child(`Page ${(this.diffPage ?? 0) + 1} / ${Math.ceil(this.rows.length / DIFF_PAGE_SIZE)}`))
        .child(div().id("diff-next-page").cursor_pointer().text_color(((this.diffPage ?? 0) + 1) * DIFF_PAGE_SIZE < this.rows.length ? t.accent : t.dim).child("Next →")
          .on_click((_e, cx) => { this.diffPage = Math.min(Math.ceil(this.rows.length / DIFF_PAGE_SIZE) - 1, (this.diffPage ?? 0) + 1); this.selection = null; cx.notify(); }))))
      .when(this.rows.length >= 1500, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Preview limited to 1,500 diff lines; file counts show the full file.")))
      .child(div().flex_1().min_h(80).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(v_flex().id(`changes-diff-${this.open}-${this.diffPage ?? 0}`).absolute().inset_0().overflow_scroll()
          .child(this.reviewDiff(t)))
        .child(Scrollbar.vertical(`changes-diff-${this.open}-${this.diffPage ?? 0}`).absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      .child(this.reviewFooter(t))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
