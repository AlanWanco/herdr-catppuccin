// Quests: what each finished turn asked for, what got done, what a machine proved, and what only a
// person can confirm. The omp "quests" extension writes these files; ticking a box writes back.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, exec, focused, notify, openOverlay, panes, props, run, spaces, theme } from "herdr";
import * as fs from "fs/promises";

const DIR = () => appHome() + "\\cache\\quests";
const SHOW = 12;      // quests drawn at once
const TICK = 4000;    // a cheap re-read: the extension writes these files

const stamp = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const hm = p(d.getHours()) + ":" + p(d.getMinutes());
  const day = p(d.getMonth() + 1) + "-" + p(d.getDate());
  return d.toDateString() === new Date().toDateString() ? hm : day + " " + hm;
};

// base64 without btoa/TextEncoder: the sandbox has neither.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64encode(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=")
      + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}

// base64 -> UTF-8 without TextDecoder: herdr's exec decodes a remote stdout as the local codepage,
// which turns Chinese into mojibake, so remote files travel as base64 instead.
function b64decode(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12)
      | ((clean[i + 2] === "=" ? 0 : B64.indexOf(clean[i + 2])) << 6)
      | (clean[i + 3] === "=" ? 0 : B64.indexOf(clean[i + 3]));
    bytes.push((n >> 16) & 255);
    if (clean[i + 2] !== "=") bytes.push((n >> 8) & 255);
    if (clean[i + 3] !== "=") bytes.push(n & 255);
  }
  let out = "", i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) { out += String.fromCharCode(b); continue; }
    if (b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f)); continue; }
    if (b < 0xf0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)); continue; }
    const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    const v = cp - 0x10000;
    out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
  }
  return out;
}

const base = (p) => String(p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
const norm = (p) => String(p ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
const questKey = (q) => JSON.stringify([q.machine ?? "", q.file]);

// The folder a quest belongs to, named the way the agent list names that agent.
function labelFor(cwd) {
  const agent = agents().find((a) => norm(panes().find((p) => p.pane === a.pane)?.cwd) === norm(cwd));
  if (!agent) return base(cwd) || String(cwd ?? "");
  const tab = agent.tab_name && agent.tab_name !== String(agent.tab_index) ? " · " + agent.tab_name : "";
  return (agent.space_name ?? agent.address) + tab;
}

export default class Quests extends View {
  init(_props, cx) {
    this.quests = [];     // newest first, each with its file
    this.onlyMine = true;  // follow the agent in front; 'all folders' is one click away
    this.writes = new Map();
    this.canceling = new Set();
    this.revision = 0;
    this.list(cx);
    cx.timer.every(TICK, (cx) => this.list(cx));
  }

  async list(cx) {
    // Do not publish a scan taken before a checkbox write or cancellation.
    if (this.writes.size || this.canceling.size) return;
    const revision = this.revision;
    const machines = [null, ...new Set(spaces().map((s) => s.machine).filter(Boolean))];
    const out = [];
    for (const machine of machines) {
      let names = [];
      let read = null;
      if (!machine) {
        try { names = (await fs.readdir(DIR())).filter((n) => n.endsWith(".json")); } catch { names = []; }
        read = async (name) => fs.readFile(DIR() + "\\" + name, "utf8");
      } else {
        const home = this.homes = this.homes ?? {};
        if (!home[machine]) {
          const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
          home[machine] = String(r?.stdout ?? "").trim();
        }
        const path = home[machine] + "/.config/herdr-app/cache/quests";
        const r = await exec("sh", ["-c", 'ls -1 "$1" 2>/dev/null', "sh", path], { on: machine }).catch(() => null);
        names = String(r?.stdout ?? "").split(/\r?\n/).filter((n) => n.endsWith(".json"));
        read = async (name) => {
          const r = await exec("sh", ["-c", 'base64 < "$1"', "sh", path + "/" + name], { on: machine }).catch(() => null);
          return r && r.code === 0 ? b64decode(r.stdout) : null;
        };
      }
      for (const name of names.slice(-40)) {
        try {
          const text = await read(name);
          const q = JSON.parse(text);
          if (q && typeof q === "object") out.push({ ...q, file: name, machine });
        } catch { /* a half-written file waits for the next pass */ }
      }
    }
    if (revision !== this.revision) return;
    out.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
    this.quests = out;
    cx.notify();
  }

  // A tick is written into the quest file itself, so the record travels with the quest. The box moves
  // first: the write can take a second on another machine, and the poll must not read over it.
  toggle(q, key, cx) {
    const id = questKey(q);
    if (this.canceling.has(id)) return;
    this.revision++;
    const checked = { ...(q.checked ?? {}) };
    if (checked[key]) delete checked[key];
    else checked[key] = new Date().toISOString();
    q.checked = checked;
    cx.notify();
    const write = (this.writes.get(id) ?? Promise.resolve()).then(() => this.persist(q));
    this.writes.set(id, write);
    write.finally(() => { if (this.writes.get(id) === write) this.writes.delete(id); });
  }

  async persist(q) {
    const body = JSON.stringify({ ...q, file: undefined, machine: undefined }, null, 1);
    try {
      if (!q.machine) await fs.writeFile(DIR() + "\\" + q.file, body);
      else {
        const path = (this.homes?.[q.machine] ?? "") + "/.config/herdr-app/cache/quests/" + q.file;
        await exec("sh", ["-c", 'printf %s "$1" | base64 -d > "$2"', "sh", b64encode(body), path], { on: q.machine });
      }
    } catch { /* the box still moves */ }
  }

  async cancel(q, cx) {
    const id = questKey(q);
    if (this.canceling.has(id)) return;
    this.canceling.add(id);
    this.revision++;
    cx.notify();
    try {
      // A checkbox save already in flight must finish before its file is removed.
      await this.writes.get(id);
      if (!q.machine) await fs.unlink(DIR() + "\\" + q.file);
      else {
        const home = this.homes?.[q.machine];
        if (!home) throw new Error("The quest's machine is unavailable.");
        const path = home + "/.config/herdr-app/cache/quests/" + q.file;
        const result = await exec("sh", ["-c", 'rm -f -- "$1"', "sh", path], { on: q.machine });
        if (result.code !== 0) throw new Error(result.stderr?.trim() || "Remote cleanup failed.");
      }
      this.quests = this.quests.filter((item) => questKey(item) !== id);
    } catch (error) {
      notify({ title: "Could not cancel quest", body: String(error?.message ?? error), level: "error" });
    } finally {
      this.canceling.delete(id);
      this.revision++;
      cx.notify();
    }
  }

  // What the person confirmed, written the way they would say it, handed to the agent's prompt.
  feedback(q) {
    const lines = ["Quest — " + (String(q.prompt ?? "").trim() || String(q.ask ?? "").trim()),
      stamp(q.at) + " · " + (base(q.cwd) || String(q.session ?? ""))];
    if (q.prompt && q.ask) lines.push("recap: " + String(q.ask));
    const done = q.done ?? [];
    const proven = done.filter((d) => d.machine);
    const unproven = done.filter((d) => !d.machine);
    if (proven.length) {
      lines.push("", "Done, proven by a machine:");
      for (const d of proven) lines.push("- " + String(d.what ?? "") + (d.proof ? " (" + String(d.proof) + ")" : ""));
    }
    if (unproven.length) {
      lines.push("", "Done, not proven:");
      for (const d of unproven) lines.push("- " + String(d.what ?? ""));
    }
    const verify = q.verify ?? [];
    if (verify.length) {
      lines.push("", "You confirmed:");
      verify.forEach((v, i) => lines.push((q.checked?.["verify:" + i] ? "[x] " : "[ ] ") + String(v.what ?? "") + (v.how ? " — " + v.how : "")));
    }
    const openItems = q.open ?? [];
    const notDone = openItems.filter((o) => !o.needsDecision);
    if (notDone.length) {
      lines.push("", "Left undone:");
      for (const o of notDone) lines.push("- " + String(o.what ?? "") + (o.why ? " (" + String(o.why) + ")" : ""));
    }
    const calls = openItems.filter((o) => o.needsDecision);
    if (calls.length) {
      lines.push("", "Needs my call:");
      for (const o of calls) lines.push("- " + String(o.what ?? "") + (o.why ? " (" + String(o.why) + ")" : ""));
    }
    return lines.join("\n");
  }

  sendToAgent(q, cx) {
    cx.write_to_clipboard(this.feedback(q));
    run("terminal.paste");
    notify({ title: "Quest ready", body: "Pasted into the agent — press Enter to send it." });
  }

  render(cx) {
    const t = theme();
    const inPane = !props()?.overlay;
    const mine = norm(this.agentCwd());
    let list = this.quests;
    if (this.onlyMine && mine) list = list.filter((q) => norm(q.cwd) === mine);
    const shown = list.slice(0, SHOW);
    const open = shown.reduce((n, q) => n + (q.verify ?? []).filter((_, i) => !(q.checked ?? {})["verify:" + i]).length, 0);

    const head = h_flex().h(34).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().child("Quests"))
      .when(open > 0, (el) => el.child(div().text_size(10.5).text_color(t.blocked).child(String(open) + " to confirm")))
      .child(h_flex().id("q-filter").h(22).px(7).flex_none().items_center().rounded(6).text_size(11)
        .bg(this.onlyMine ? t.selected : t.chrome).text_color(this.onlyMine ? t.foreground : t.dim)
        .border_1().border_color(t.border).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => { this.onlyMine = !this.onlyMine; cx.notify(); })
        .child(this.onlyMine ? "this folder" : "all folders"))
      .child(h_flex().id("q-refresh").h(22).px(7).flex_none().items_center().rounded(6).text_size(11).text_color(t.dim)
        .hover((x) => x.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => cx.spawn((cx) => this.list(cx))).child("↻"))
      .when(inPane, (el) => el.child(h_flex().id("q-open").h(22).px(7).flex_none().items_center().rounded(6)
        .text_size(11).text_color(t.dim).border_1().border_color(t.border).hover((x) => x.bg(t.hover))
        .on_click((_e, cx) => openOverlay({ mod: "quests", kind: "dialog", width: 620, height: 700 }))
        .child("Open")));

    const box = (q, key, i) => {
      const on = Boolean((q.checked ?? {})[key]);
      return h_flex().id("q-" + questKey(q) + "-" + key).h(16).w(16).flex_none().items_center().justify_center().rounded(4)
        .border_1().border_color(on ? t.done : t.input).bg(on ? t.done : t.chrome)
        .cursor_pointer().on_click((_e, cx) => this.toggle(q, key, cx))
        .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.solid_foreground)));
    };

    const section = (label, rows) => v_flex().gap(3)
      .child(div().pt(6).text_size(10).text_color(t.dim).child(label))
      .children(rows);

    const quest = (q) => {
      const id = questKey(q);
      const canceling = this.canceling.has(id);
      const verify = (q.verify ?? []).map((v, i) => h_flex().id("qv-" + id + "-" + i).gap(7).items_start()
        .child(box(q, "verify:" + i, i))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(11.5).text_color(t.foreground).child(String(v.what ?? "")))
          .when(Boolean(v.how), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(v.how))))
          .when(Boolean((q.checked ?? {})["verify:" + i]), (el) => el.child(div().text_size(10).text_color(t.done).child("you confirmed this")))));
      const finished = (q.done ?? []).map((d) => h_flex().gap(7).items_start()
        .child(div().h(16).w(16).flex_none().items_center().justify_center()
          .child(div().text_size(10).text_color(d.machine ? t.done : t.dim).child(d.machine ? "✓" : "·")))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(11.5).text_color(d.machine ? t.muted : t.foreground).child(String(d.what ?? "")))
          .when(Boolean(d.proof), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(d.proof))))));
      // Two kinds of open item: one wants a decision, the other is just not done yet.
      const openRow = (o) => h_flex().gap(7).items_start()
        .child(div().h(16).w(16).flex_none().items_center().justify_center()
          .child(div().text_size(10).text_color(o.needsDecision ? t.blocked : t.dim).child(o.needsDecision ? "?" : "·")))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(11.5).text_color(t.foreground).child(String(o.what ?? "")))
          .when(Boolean(o.why), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(String(o.why))))
          .when(Boolean(o.needsDecision), (el) => el.child(div().text_size(10).text_color(t.blocked).child("waiting on you"))));
      const calls = (q.open ?? []).filter((o) => o.needsDecision).map(openRow);
      const pending = (q.open ?? []).filter((o) => !o.needsDecision).map(openRow);

      return v_flex().id("q-" + id).gap(4).px(10).py(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().text_size(10.5).text_color(t.dim).child(stamp(q.at)))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.dim).child(base(q.cwd) || q.session || ""))
          .child(div().text_size(10).text_color(t.dim).child(String(q.session ?? "").slice(0, 8))))
        .when(Boolean(q.prompt), (el) => el.child(v_flex().gap(2)
          .child(div().text_size(10).text_color(t.dim).child("you asked"))
          .child(div().text_size(12).text_color(t.foreground)
            .child(String(q.prompt).length > 320 ? String(q.prompt).slice(0, 320) + "…" : String(q.prompt)))))
        .when(Boolean(q.ask), (el) => el.child(div().text_size(10.5).text_color(t.muted).child("recap · " + String(q.ask))))
        .when(verify.length > 0, (el) => el.child(section("needs your confirmation", verify)))
        .when(finished.length > 0, (el) => el.child(section("done", finished)))
        .when(calls.length > 0, (el) => el.child(section("needs your call", calls)))
        .when(pending.length > 0, (el) => el.child(section("left undone", pending)))
        .child(h_flex().pt(6).gap(6)
          .child(h_flex().id("q-send-" + id).h(22).px(8).flex_none().items_center().rounded(6)
            .border_1().border_color(t.border).bg(t.chrome).text_size(11).text_color(t.accent)
            .hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.sendToAgent(q, cx))
            .child("Feedback to agent"))
          .child(h_flex().id("q-cancel-" + id).h(22).px(8).flex_none().items_center().rounded(6)
            .border_1().border_color(t.border).bg(t.chrome).text_size(11).text_color(t.muted)
            .hover((x) => x.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => cx.spawn((cx) => this.cancel(q, cx)))
            .child(canceling ? "Canceling…" : "Cancel")));
    };

    const groups = [];
    for (const q of shown) {
      const key = norm(q.cwd);
      const at = groups.find((g) => g.key === key);
      if (at) at.items.push(q);
      else groups.push({ key, cwd: q.cwd, items: [q] });
    }

    const emptyHere = !shown.length && this.onlyMine && Boolean(mine);
    const body = shown.length
      ? v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(
        groups.map((g) => v_flex().gap(1)
          .child(h_flex().flex_none().px(10).pt(10).pb(3).gap(6).items_center()
            .child(div().text_size(10.5).text_color(t.muted).child(labelFor(g.cwd)))
            .child(div().text_size(10).text_color(t.dim).child(String(g.items.length))))
          .children(g.items.map(quest))))
      : v_flex().p(12).gap(8)
        .child(div().text_size(11.5).text_color(t.dim)
          .child(emptyHere
            ? "No quests for " + base(this.agentCwd()) + " yet."
            : "No quests yet. They appear when a turn ends in an omp session that has the quests extension."))
        .when(emptyHere && this.quests.length > 0, (el) => el.child(h_flex().child(h_flex().id("q-showall").h(22).px(8).flex_none().items_center()
          .rounded(6).border_1().border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
          .hover((x) => x.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.onlyMine = false; cx.notify(); })
          .child("Show all folders (" + this.quests.length + ")"))));

    return v_flex().id("quests").size_full().min_w(0).bg(t.surface).text_color(t.foreground).child(head)
      .child(v_flex().flex_1().min_h(0).min_w(0).child(body))
      .when(inPane, (el) => el.child(h_flex().flex_none().px(10).py(5).border_t(1).border_color(t.border)
        .child(div().max_w(300).truncate().text_size(10.5).text_color(t.dim).child("Files in " + DIR()))));
  }

  agentCwd() {
    const agent = agents().find((a) => a.address === focused()?.agent);
    return agent ? (panes().find((p) => p.pane === agent.pane)?.cwd ?? "") : "";
  }
}
