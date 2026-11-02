// Notes: markdown files in ~/.config/herdr-app/notes, written with a live preview, pictures pasted
// straight into the text. Nothing but those files is stored, so they are yours to edit anywhere.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, TextView } from "gpui-base";
import { agents, focused, appHome, exec, settings, theme, window, props, openOverlay, closeOverlay } from "herdr";
import * as fs from "fs/promises";

const BASE = () => appHome() + "\\notes";
const PINS = () => BASE() + "\\pins.json";
const IMAGES = () => BASE() + "\\images";
// One folder per agent: the notes list belongs to whoever is in front.
const keyOf = () => String(focused()?.agent ?? "shared").replace(/[^A-Za-z0-9_.-]+/g, "_");
const dirFor = (key) => BASE() + "\\" + key;
const SAVE_MS = 700;

const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
};

const ps = (p) => "'" + String(p).replace(/'/g, "''") + "'";

// "![alt](path)" pieces, so pictures can be drawn with image() while the rest stays markdown.
function split(text) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let at = 0, m;
  while ((m = re.exec(String(text)))) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ image: m[2].replace(/^<|>$/g, "").trim(), alt: m[1] });
    at = m.index + m[0].length;
  }
  if (at < String(text).length) out.push({ text: text.slice(at) });
  return out;
}

export default class Notes extends View {
  init(_props, cx) {
    this.notes = [];      // [{ name, at }]
    this.note = null;     // the open note's file name
    this.text = "";       // what the editor holds
    this.view = "read";  // "write" | "read"
    this.state = null;    // TextareaState of the open note
    this.pasted = null;   // the last pasted picture, while it is being inserted
    this.pins = {};       // "agent/name" -> pinned at: pinned notes show under every agent
    this.pinned = [];     // the pinned notes that still exist
    this.agent = keyOf(); // whose notes these are
    this.noteAgent = this.agent;
    this.list(cx);
    // The folder is also edited outside; a cheap re-read keeps the list honest.
    cx.timer.every(4000, (cx) => { if (!this.note) this.list(cx); });
  }

  async list(cx) {
    const key = this.agent;
    try {
      await fs.mkdir(dirFor(key), { recursive: true });
      const names = (await fs.readdir(dirFor(key))).filter((n) => n.endsWith(".md"));
      if (this.agent === key) this.notes = names.sort().reverse().map((name) => ({ name }));
    } catch { if (this.agent === key) this.notes = []; }
    await this.readPins();
    const pinned = [];
    for (const k of Object.keys(this.pins)) {
      const at = k.indexOf("/");
      const agent = k.slice(0, at), name = k.slice(at + 1);
      if (!agent || !name) continue;
      if (await fs.exists(dirFor(agent) + "\\" + name).catch(() => false)) pinned.push({ agent, name });
    }
    this.pinned = pinned;
    cx.notify();
  }

  async readPins() {
    try {
      const raw = JSON.parse(await fs.readFile(PINS(), "utf8"));
      this.pins = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch { this.pins = this.pins ?? {}; }
  }

  pinKey(agent, name) {
    return agent + "/" + name;
  }

  async togglePin(agent, name, cx) {
    const k = this.pinKey(agent, name);
    if (this.pins[k]) delete this.pins[k];
    else this.pins[k] = new Date().toISOString();
    try {
      await fs.mkdir(BASE(), { recursive: true });
      await fs.writeFile(PINS(), JSON.stringify(this.pins, null, 1));
    } catch { /* the list still reflects the choice in memory */ }
    await this.list(cx);
  }

  // Renaming is write + delete: the sandbox has no rename.
  async rename(oldName, wanted, cx) {
    const clean = String(wanted ?? "").trim().replace(/[\\/:*?"<>|]/g, "").replace(/\.md$/i, "").slice(0, 60);
    const to = clean ? clean + ".md" : "";
    if (!to || to === oldName) { this.renaming = false; cx.notify(); return; }
    const agent = this.noteAgent, from = dirFor(agent) + "\\" + oldName, next = dirFor(agent) + "\\" + to;
    try {
      const text = (await fs.readFile(from, "utf8")) ?? "";
      await fs.writeFile(next, text);
      await fs.unlink(from).catch(() => {});
      const k = this.pinKey(agent, oldName);
      if (this.pins[k]) { delete this.pins[k]; this.pins[this.pinKey(agent, to)] = new Date().toISOString(); await fs.writeFile(PINS(), JSON.stringify(this.pins, null, 1)).catch(() => {}); }
      this.note = to;
      this.noteAgent = agent;
    } catch { this.pasted = "Rename failed."; }
    this.renaming = false;
    await this.list(cx);
  }

  async open(name, cx, agent) {
    this.release();
    this.note = name;
    this.noteAgent = agent ?? this.agent;
    this.view = "write";
    this.failed = null;
    try {
      this.text = (await fs.readFile(dirFor(this.noteAgent) + "\\" + name, "utf8")) || "";
      this.state = EditorState.new({ value: this.text, soft_wrap: true, line_numbers: false, folding: false,
        font_family: settings().font_family, font_size: 13 });
      this.state.on("change", (_e, cx) => { this.text = this.state.value(); this.save(cx); cx.notify(); });
      this.state.on("paste_other", (_e, cx) => this.pasteImage(cx));
      this.measure(this.text, cx);
    } catch { this.text = ""; this.state = null; this.failed = "Could not open " + name; }
    cx.notify();
  }

  release() {
    if (this.state) { try { this.state.release(); } catch { /* already gone */ } }
    this.state = null;
  }

  async save(cx) {
    const name = this.note, text = this.text;
    if (!name) return;
    this.pending = Date.now();
    const at = this.pending;
    cx.timer.after(SAVE_MS, async (cx) => {
      if (this.note !== name || this.pending !== at) return;
      try { await fs.mkdir(dirFor(this.noteAgent), { recursive: true }); await fs.writeFile(dirFor(this.noteAgent) + "\\" + name, text); } catch { /* keep editing */ }
      this.saved = true;
      cx.notify();
    });
  }

  async create(cx) {
    const name = "note-" + stamp() + ".md";
    await fs.mkdir(dirFor(this.agent), { recursive: true }).catch(() => {});
    await fs.writeFile(dirFor(this.agent) + "\\" + name, "").catch(() => {});
    await this.list(cx);
    this.open(name, cx);
  }

  // The clipboard's picture, saved beside the notes and appended as markdown. GDI+ writes the PNG.
  async pasteImage(cx) {
    this.pasted = "Reading the clipboard…";
    cx.notify();
    try {
      await fs.mkdir(IMAGES(), { recursive: true });
      const file = IMAGES() + "\\img-" + stamp() + ".png";
      const cmd = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        + " if ([System.Windows.Forms.Clipboard]::ContainsImage()) {"
        + " $i=[System.Windows.Forms.Clipboard]::GetImage(); $i.Save(" + ps(file) + ", [System.Drawing.Imaging.ImageFormat]::Png); $i.Dispose(); 'ok' }"
        + " else { 'none' }";
      const r = await exec("powershell", ["-NoProfile", "-Sta", "-Command", cmd]);
      if (!/ok/.test(r.stdout)) { this.pasted = "No picture in the clipboard."; cx.notify(); return; }
      const rel = "notes/images/img-" + file.split("img-")[1];
      this.insert("\n![](" + rel + ")\n", cx);
      this.pasted = "Added " + rel;
    } catch (e) {
      this.pasted = "Paste failed: " + String(e?.message ?? e).slice(0, 80);
    }
    cx.notify();
    cx.timer.after(2500, (cx) => { this.pasted = null; cx.notify(); });
  }

  // A picture's size, so the preview can fit it to the column without stretching it.
  async measure(text, cx) {
    this.sizes = this.sizes ?? {};
    for (const part of split(text)) {
      const rel = part.image;
      if (!rel || this.sizes[rel]) continue;
      const abs = appHome() + "\\" + rel.replace(/\//g, "\\");
      const r = await exec("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=width,height", "-of", "csv=p=0", abs]).catch(() => null);
      const [w, h] = String(r?.stdout ?? "").trim().split(",").map(Number);
      if (w > 0 && h > 0) this.sizes[rel] = { w, h };
    }
    cx.notify();
  }

  box(rel) {
    const s = this.sizes?.[rel], W = this.wide ?? 320;
    if (!s) return { w: W, h: 200 };
    const k = Math.min(W / s.w, 1);
    return { w: Math.round(s.w * k), h: Math.round(s.h * k) };
  }

  startRename(cx) {
    const value = this.note.replace(/\.md$/, "");
    this.nameInput = InputState.new({ value });
    this.nameInput.set_selected_range({ start: 0, end: value.length });
    this.nameInput.on("submit", (_e, cx) => this.rename(this.note, this.nameInput.value(), cx));
    // Clicking away saves the name too, the way the rest of the panel works.
    this.nameInput.on("blur", (_e, cx) => { if (this.renaming) this.rename(this.note, this.nameInput.value(), cx); });
    this.renaming = true;
    this.nameInput.focus();
    cx.notify();
  }

  insert(add, cx) {
    const next = (this.text ?? "").replace(/\s+$/, "") + add;
    this.text = next;
    if (this.state) this.state.set_value(next);
    if (cx) this.measure(next, cx);
  }

  // A picture dropped from the desktop lands in notes/images and is appended the same way.
  async dropImage(path, cx) {
    try {
      await fs.mkdir(IMAGES(), { recursive: true });
      const name = "img-" + stamp() + "." + (path.split(".").pop() || "png");
      const args = ["-y", "-loglevel", "error", "-i", path, IMAGES() + "\\" + name];
      const r = await exec("ffmpeg", args).catch(() => null);
      if (!r || r.code !== 0) { this.pasted = "This picture cannot be read."; cx.notify(); return; }
      this.insert("\n![](notes/images/" + name + ")\n", cx);
      this.pasted = "Added notes/images/" + name;
      this.save(cx);
      cx.notify();
    } catch (e) { this.pasted = String(e?.message ?? e); cx.notify(); }
  }

  render(cx) {
    const t = theme();
    const inPane = !props()?.overlay;
    // Only an agent in front changes whose notes these are: clicking into this
    // panel leaves no agent focused, and resetting then closed the note the
    // click had just opened.
    const key = keyOf();
    const focusedAgent = focused()?.agent;
    if (focusedAgent && key !== this.agent) {
      this.release();
      this.note = null;
      this.agent = key;
      this.notes = [];
      this.list(cx);
    }
    const who = agents().find((a) => a.address === focused()?.agent) ?? null;
    const button = (id, label, action) => h_flex().id(id).h(24).px(8).flex_none().items_center().rounded(6)
      .border(1).border_color(t.border).bg(t.chrome).text_size(11.5).text_color(t.dim)
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click(action).child(label);

    const head = h_flex().h(34).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .when(Boolean(this.note), (el) => el.child(h_flex().id("notes-back").h(24).px(6).flex_none().items_center().rounded(6)
        .text_size(11.5).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { this.release(); this.note = null; this.list(cx); }).child("←")))
      .child(this.note && this.renaming
        ? div().flex_1().min_w(0).child(Input.new(this.nameInput).h(24).px(8).rounded(6).border_1()
          .border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground))
        : div().flex_1().min_w(0).truncate().text_size(12).font_semibold()
          .when(Boolean(this.note), (el) => el.cursor_pointer().on_click((_e, cx) => this.startRename(cx)))
          .child(this.note ? this.note.replace(/\.md$/, "") : "Notes"))
      .when(!this.note, (el) => el.child(div().max_w(150).truncate().text_size(10.5).text_color(t.dim)
        .child(who ? "· " + (who.space_name ?? who.address) : "· no agent")))
      .when(Boolean(this.note), (el) => el.child(h_flex().h(24).flex_none().rounded(6).bg(t.raised).p(1).gap(1)
        .child(h_flex().id("notes-write").h(22).px(8).items_center().rounded(5).text_size(11).cursor_pointer()
          .bg(this.view === "write" ? t.selected : t.raised).text_color(this.view === "write" ? t.foreground : t.dim)
          .on_click((_e, cx) => { this.view = "write"; cx.notify(); }).child("write"))
        .child(h_flex().id("notes-read").h(22).px(8).items_center().rounded(5).text_size(11).cursor_pointer()
          .bg(this.view === "read" ? t.selected : t.raised).text_color(this.view === "read" ? t.foreground : t.dim)
          .on_click((_e, cx) => { this.view = "read"; cx.notify(); }).child("read"))))
      .when(Boolean(this.note), (el) => el.child(h_flex().id("notes-pin").h(22).w(24).flex_none().items_center().justify_center().rounded(6)
        .text_color(this.pins[this.pinKey(this.noteAgent, this.note)] ? t.accent : t.dim)
        .bg(this.pins[this.pinKey(this.noteAgent, this.note)] ? t.selected : t.chrome)
        .border_1().border_color(t.border).hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.togglePin(this.noteAgent, this.note, cx))
        .child(svg("mods/workspace-chrome/" + (this.pins[this.pinKey(this.noteAgent, this.note)] ? "pin.svg" : "pin-off.svg")).size(13))))
      .child(button("notes-new", "＋", (_e, cx) => this.create(cx)))
      .when(inPane && !this.note, (el) => el.child(button("notes-open", "Open", (_e, cx) => openOverlay({ mod: "notes", kind: "dialog", width: 620, height: 660 }))));

    if (!this.note) {
      const pinnedNow = (agent, name) => Boolean(this.pins[this.pinKey(agent, name)]);
      const pinTag = (agent, name, scope) => h_flex().id("pin-" + scope + "-" + agent + "-" + name).h(20).w(20).flex_none().items_center().justify_center()
        .rounded(4).bg(pinnedNow(agent, name) ? t.selected : t.chrome)
        .text_color(pinnedNow(agent, name) ? t.accent : t.dim)
        .hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.togglePin(agent, name, cx))
        .child(svg("mods/workspace-chrome/" + (pinnedNow(agent, name) ? "pin.svg" : "pin-off.svg")).size(13));
      const row = (n, label, scope) => h_flex().id("note-" + scope + "-" + n.agent + "-" + n.name).h(28).flex_none().px(10).gap(8).items_center().cursor_pointer()
        .text_size(12).text_color(t.foreground).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => this.open(n.name, cx, n.agent))
        .child(div().flex_1().min_w(0).truncate().child(label))
        .child(pinTag(n.agent, n.name, scope));
      const title = (text, count) => h_flex().flex_none().px(10).pt(8).pb(2).gap(6).items_center()
        .child(div().text_size(10.5).text_color(t.dim).child(text))
        .child(div().text_size(10).text_color(t.dim).child(String(count)));
      const pinnedRows = this.pinned.map((n) => ({ agent: n.agent, name: n.name, label: n.agent === this.agent ? n.name.replace(/\.md$/, "") : n.agent + " · " + n.name.replace(/\.md$/, "") }));
      const mine = this.notes.map((n) => ({ agent: this.agent, name: n.name, label: n.name.replace(/\.md$/, "") }));
      return v_flex().id("notes-list").size_full().min_w(0).bg(t.surface).text_color(t.foreground).child(head)
        .child((pinnedRows.length || mine.length)
          ? v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(4).gap(1)
            .when(pinnedRows.length > 0, (el) => el.child(title("Pinned · shown to every agent", pinnedRows.length))
              .children(pinnedRows.map((n) => row(n, n.label, "pinned"))))
            .when(mine.length > 0, (el) => el.child(title("This agent", mine.length)).children(mine.map((n) => row(n, n.label, "mine"))))
          : v_flex().p(12).child(div().text_size(11.5).text_color(t.dim).child("No notes yet — press ＋ to start.")))
        .when(inPane, (el) => el.child(h_flex().flex_none().px(10).py(6).border_t(1).border_color(t.border)
          .child(div().max_w(220).truncate().text_size(10.5).text_color(t.dim).child("Files in " + dirFor(this.agent)))));
    }

    const wide = this.wide;
    const body = this.view === "write"
      ? (this.state
        ? v_flex().flex_1().min_h(0).min_w(0).p(8).on_size_change((size, cx) => {
          const h = Math.max(160, Math.round(size.height - 16));
          if (Math.abs((this.bodyH ?? 0) - h) > 4) { this.bodyH = h; cx.notify(); }
        }).child(Editor.new(this.state).w_full().h(this.bodyH ?? 420))
        : div().p(12).child("…"))
      : v_flex().flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(12).gap(8)
        .on_size_change((size, cx) => {
          const w = Math.max(120, Math.round(size.width - 24));
          if (Math.abs((this.wide ?? 0) - w) > 4) { this.wide = w; cx.notify(); }
        })
        .children(split(this.text).map((part, i) => {
          if (!part.image) return TextView.markdown("np-" + i, part.text);
          const b = this.box(part.image);
          return div().id("np-" + i).child(image(part.image).w(b.w).h(b.h));
        }));

    return v_flex().id("notes-open").size_full().min_w(0).bg(t.surface).text_color(t.foreground).child(head)
      .child(v_flex().flex_1().min_h(0).min_w(0).child(body))
      .child(h_flex().flex_none().px(10).py(5).gap(8).border_t(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim)
          .child(this.pasted ?? this.failed ?? (this.saved ? "Saved" : "Saves as you type")))
        .when(!inPane, (el) => el.child(h_flex().id("notes-close").h(22).px(8).flex_none().items_center().rounded(6)
          .text_size(11.5).text_color(t.dim).hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, _cx) => closeOverlay(props().overlay)).child("Close"))));
  }
}
