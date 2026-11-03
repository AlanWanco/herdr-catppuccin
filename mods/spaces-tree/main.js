// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, appHome, home, spaces, machines, panes, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";
import * as fs from "fs/promises";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
const clockOf = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// The gateway host is not in the source: one line in this file names it, and
// the two ports are fixed (3425 key-authenticated API, 3430 magpie web).
const GATEWAY_FILE = () => appHome() + "/magpie-gateway.txt"; // ~/.config/herdr-app
const WEB_KEY_FILE = () => home() + "/.config/herdr-app/magpie-web.key";
let hostOnce = null;
const gatewayHost = () => (hostOnce ??= (async () => {
  try { return (await fs.readFile(GATEWAY_FILE(), "utf8")).trim() || "127.0.0.1"; } catch { return "127.0.0.1"; }
})());

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
// Catppuccin Mocha accents for the space markers, and a glyph each instead of a letter.
const MOCHA = ["#cba6f7", "#89b4fa", "#a6e3a1", "#fab387", "#f5c2e7", "#94e2d5", "#f9e2af", "#b4befe", "#f38ba8", "#74c7ec"];
const GLYPHS = ["\u2756", "\u25c6", "\u2726", "\u2733", "\u2727", "\u25c8"];
const seedOf = (id) => [...String(id)].reduce((n, c) => n + c.codePointAt(0), 0);

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// A device icon per machine, and the tree glyphs that tie a space to its machine.
const DEVICE = { "": "win", "mac-mini": "mac" };
const deviceIcon = (machine) => `mods/spaces-tree/${DEVICE[machine ?? ""] ?? "dev"}.svg`;

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("spaces-tree.folded") ?? "[]"));
    this.tab = shared("spaces-tree.tab") ?? "spaces"; // "spaces" | "routing" | "usage"
    this.stats = null;    // what `omp stats --json` said, kept between opens
    this.statsAt = 0;
    this.routes = [];     // magpie web's routing decisions, newest last
    this.traceSeq = 0;    // the last seq seen; `after=` returns only newer ones
    this.totals = null;   // { requests, rerouted, errors } over the trace window
    this.traceAt = 0;
    this.openPlans = new Set(JSON.parse(localStorage.getItem("spaces-tree.openPlans") ?? "[]")); // usage rows opened
    this.webKey = null;   // magpie web sign-in key, from its file
    this.webCookie = null;
    this.loadStats(cx);

    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // The gateway's own routing decisions live in magpie web, not the 3425 API.
    cx.timer.every(4000, (cx) => this.loadTrace(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // The gateway answers with the provider key omp already holds: quotas per provider, and today's use.
  async loadGateway(cx) {
    if (this.fetching) return;
    this.fetching = true;
    try {
      if (!this.key) {
        const r = await exec("omp", ["auth", "export"]).catch(() => null);
        if (r && r.code === 0) {
          try {
            const held = JSON.parse(String(r.stdout ?? ""));
            this.key = (held.credentials ?? []).find((c) => c.provider === "magpie")?.credential?.key ?? null;
          } catch { this.key = null; }
        }
      }
      if (this.key) {
        const headers = { Authorization: "Bearer " + this.key };
        const pair = await Promise.all([
          fetch("http://" + (await gatewayHost()) + ":3425/v1/magpie/quotas", { headers }).then((x) => x.json()).catch(() => null),
          fetch("http://" + (await gatewayHost()) + ":3425/v1/magpie/usage", { headers }).then((x) => x.json()).catch(() => null),
        ]);
        if (pair[0]?.data) {
          this.quotas = pair[0].data;
        }
        if (pair[1]?.series) this.usage = pair[1];
        if (pair[0] || pair[1]) this.gwAt = Date.now();
      }
    } catch { this.gwError = true; }
    this.fetching = false;
    cx.notify();
  }

  // magpie web (3430) signs in with a key and answers with a cookie; its trace is
  // the gateway's own routing decisions, polled by seq so each read is a delta.
  async loadTrace(cx) {
    if ((this.tab ?? "spaces") !== "routing") return;
    if (!this.webKey) {
      try { this.webKey = (await fs.readFile(WEB_KEY_FILE(), "utf8")).trim() || null; } catch { this.webKey = null; }
    }
    if (!this.webKey) { this.traceErr = "no web key"; return; }
    const WEB = "http://" + (await gatewayHost()) + ":3430";
    // The 303 carries the cookie in a header the mod's fetch does not expose, so
    // the sign-in goes through curl and only the cookie is kept.
    const signIn = async () => {
      try {
        const r = await exec("curl", ["-s", "-i", "-X", "POST", "-H", "Content-Type: application/x-www-form-urlencoded",
          "--data", "back=%2F&key=" + this.webKey, WEB + "/_magpie/sign-in"]);
        const hit = /^set-cookie:\s*([^;\r\n]+)/im.exec(String(r?.stdout ?? ""));
        this.webCookie = hit ? hit[1].trim() : null;
        if (!this.webCookie) this.traceErr = "signin: no cookie (" + String(r?.code ?? "?") + ")";
      } catch (e) { this.webCookie = null; this.traceErr = "signin err " + String(e?.message ?? e).slice(0, 60); }
      return Boolean(this.webCookie);
    };
    const read = async (after) => {
      try {
        const j = await (await fetch(WEB + "/api/gateway/trace?after=" + after, { headers: { Cookie: this.webCookie } })).json();
        return j && Array.isArray(j.routes) ? j : null;
      } catch { return null; }
    };
    try {
      if (!this.webCookie && !(await signIn())) return;
      let j = await read(this.traceSeq ?? 0);
      if (!j && (await signIn())) j = await read(this.traceSeq ?? 0);
      if (!j) return;
      if (j.totals) this.totals = j.totals;
      if (Number.isFinite(j.seq)) this.traceSeq = j.seq;
      // A request that was still answering when it was read came back finished
      // under the same id: those rows only refresh on a full read.
      const merged = new Map(this.routes.map((r) => [r.id, r]));
      for (const r of j.routes ?? []) merged.set(r.id, r);
      if (this.routes.some((r) => r.done === false)) {
        for (const r of (await read(0))?.routes ?? []) merged.set(r.id, r);
      }
      this.routes = [...merged.values()].sort((a, b) => Number(a.id) - Number(b.id)).slice(-40);
      this.traceAt = Date.now();
      this.traceErr = null;
    } catch (e) { this.traceErr = "trace err " + String(e?.message ?? e).slice(0, 70); }
    cx.notify();
  }

  // Magpie usage comes from omp's own request log; the gateway itself answers only with a key.
  async loadStats(cx) {
    try {
      const raw = await fs.readFile(appHome() + "\\cache\\magpie-stats.json", "utf8");
      const held = JSON.parse(raw);
      if (held && typeof held === "object") { this.stats = held; this.statsAt = held.at ?? 0; }
    } catch { /* first run */ }
    if ((this.tab ?? "spaces") === "usage") {
      if (!this.quotas || Date.now() - (this.gwAt ?? 0) > 60000) this.loadGateway(cx);
      if (Date.now() - (this.statsAt ?? 0) > 300000) this.refreshStats(cx);
    }
    cx.notify();
  }

  async refreshStats(cx) {
    if (this.fetching) return;
    this.fetching = true;
    try {
      const r = await exec("omp", ["stats", "--json"], {}).catch(() => null);
      const text = String(r?.stdout ?? "");
      const at = text.indexOf("{");
      if (r && r.code === 0 && at >= 0) {
        const all = JSON.parse(text.slice(at));
        const magpie = (all.byModel ?? []).filter((m) => m.provider === "magpie");
        const next = {
          at: Date.now(),
          overall: all.overall ?? {},
          byModel: magpie,
          series: (all.timeSeries ?? []).slice(-48),
        };
        this.stats = next;
        this.statsAt = next.at;
        try { await fs.writeFile(appHome() + "\\cache\\magpie-stats.json", JSON.stringify(next)); } catch { /* keep it in memory */ }
      }
    } catch { /* the panel keeps the last numbers */ }
    this.fetching = false;
    cx.notify();
  }

  // The gateway's own decisions, grouped the way its routing page draws them:
  // caller -> model group -> the account that answered. One row per pair, not
  // one per request, or a busy session buries everything else. Columns are
  // percentages: the panel is resizable, so nothing is pinned to a width.
  routingView(t, collapsed) {
    // Rows get a fixed-width badge so they line up; the totals get pills that fit.
    const badge = (text, color) => h_flex().w(34).h(18).items_center().justify_center().rounded(9).bg(t.raised).flex_none()
      .child(div().text_size(10).text_color(color).child(text));
    const pill = (text, color) => h_flex().h(18).px(7).items_center().rounded(9).bg(t.raised).flex_none()
      .child(div().text_size(10).text_color(color).child(text));
    const ago = (at) => {
      const s = Math.max(0, Math.round((Date.now() - at) / 1000));
      return s < 3 ? "now" : s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h";
    };
    const tint = (name) => MOCHA[seedOf(name ?? "") % MOCHA.length];
    const W = Math.max(220, (find(layout(), "sidebar")?.size?.px ?? 380) - 40);

    const keys = new Map();
    for (const r of this.routes) {
      const served = r.served ?? (r.usage ?? [])[0]?.model ?? "";
      const group = r.group?.name ?? r.provider ?? "";
      const key = [r.agent, group, served, r.provider ?? ""].join("|");
      const g = keys.get(key) ?? { agent: String(r.agent ?? ""), group, served, provider: String(r.provider ?? ""), n: 0, ms: 0, timed: 0, err: 0, live: false, at: 0, order: null };
      g.n += 1;
      if (Number.isFinite(r.ms)) { g.ms += r.ms; g.timed += 1; }
      if ((r.status ?? 200) >= 400) g.err += 1;
      if (r.done === false) g.live = true;
      g.at = Math.max(g.at, Date.parse(r.time) || 0);
      if ((r.order ?? []).length) g.order = r.order;   // candidates at the last decision
      keys.set(key, g);
    }
    const rows = [...keys.values()].sort((a, b) => b.at - a.at).slice(0, collapsed ? 5 : 9);
    // "Resting" is what the routing page means: accounts the gateway will not
    // pick right now because their window is spent (used 100).
    const restingOf = (g) => (g.order ?? [])
      .filter((o) => !g.served || o.model === g.served)
      .filter((o) => (o.used ?? 0) >= 100).length;
    const row = (g) => {
      const resting = restingOf(g);
      return v_flex().w_full().gap(1).py(3).px(3).rounded(5)
        .hover((x) => x.bg(t.hover))
        .child(h_flex().gap(6).items_center()
          .child(div().w(2).h(20).rounded(1).bg(tint(g.agent)).flex_none())
          .child(div().min_w(0).w(Math.round(W * 0.76)).truncate().text_size(12.5).text_color(t.foreground).child(g.group))
          .child(div().w(10).h(10).flex_none().items_center().justify_center()
            .when(g.live, (x) => x.child(div().w(7).h(7).rounded(4).bg(t.working))))
          .child(badge(g.n + "\u00d7", t.muted)))
        .child(h_flex().gap(6).items_center().pl(8)
          .child(div().min_w(0).w(Math.round(W * 0.44)).truncate().text_size(10).text_color(t.muted)
            .child(g.agent + (g.served ? " \u00b7 " + g.served : "")))
          .child(div().w(Math.round(W * 0.18)).text_size(10).text_color(resting ? t.working : t.dim)
            .child(resting ? resting + " rest" : "no rest"))
          .child(div().w(Math.round(W * 0.12)).text_size(10).text_color(g.err ? t.blocked : t.dim)
            .child(g.err ? g.err + " err" : g.timed ? (g.ms / g.timed / 1000).toFixed(1) + "s" : "")));
    };

    return v_flex().flex_1().min_h(0).px(12).pb(12).gap(4).overflow_y_scrollbar()
      .child(h_flex().gap(6).items_center()
        .child(div().w(W - 86).text_size(12).text_color(t.dim).child("magpie \u00b7 routing"))
        .child(div().w(60).text_size(10).text_color(t.dim).child(this.traceAt ? ago(this.traceAt) : ""))
        .child(div().id("magpie-routing-refresh").w(20).text_size(13).text_color(t.dim).cursor_pointer()
          .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.loadTrace(cx)).child("\u21bb")))
      .when(Boolean(this.totals), (el) => el.child(h_flex().gap(6).items_center().pb(4)
        .child(pill(String(this.totals.requests ?? 0) + " req", t.muted))
        .child(pill(String(this.totals.rerouted ?? 0) + " reroute", t.muted))
        .when((this.totals.errors ?? 0) > 0, (x) => x.child(pill(String(this.totals.errors) + " err", t.blocked)))))
      .when(rows.length > 0, (el) => el.child(v_flex().gap(0).children(rows.map(row))))
      .when(!rows.length && Boolean(this.traceErr), (el) => el.child(div().text_size(10).text_color(t.blocked)
        .child(String(this.traceErr))))
      .child(div().pt(6).text_size(10).text_color(t.dim)
        .child(this.traceAt ? "magpie web \u00b7 " + this.routes.length + " decisions held" : "reading magpie web\u2026"));
  }

  // A small dashboard: what today cost in requests and tokens, and which models
  // carried it. Quotas are worst-account-per-plan until you open one.
  usageView(t, collapsed) {
    const local = this.stats;
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const todayKey = dayStart.toISOString().slice(0, 10);
    const today = (this.usage?.series ?? []).find((p) => String(p.time ?? "").slice(0, 10) === todayKey) ?? null;
    const resetIn = (iso) => {
      const ms = Date.parse(iso) - Date.now();
      if (!Number.isFinite(ms)) return "";
      if (ms <= 0) return "resetting";
      const m = Math.round(ms / 60000);
      if (m < 60) return m + "m left";
      const h = Math.round(m / 60);
      return h < 48 ? h + "h left" : Math.round(h / 24) + "d left";
    };
    const short = (name) => {
      const raw = String(name ?? "");
      // CLIProxyAPI names its keys "#1 Gemini 7 days": keep the key and the family.
      const tag = /^#(\d+)\s+(\w)/.exec(raw);
      const head = tag ? "#" + tag[1] + tag[2].toUpperCase() + " " : "";
      const s = raw.toLowerCase();
      if (s.includes("5 hour")) return head + "5h";
      if (s.includes("7 day")) return head + "7d";
      if (s.includes("free model")) return head + "tok";
      if (s.includes("extra")) return head + "ex";
      if (s.includes("flex")) return head + "flex";
      if (s.includes("auto")) return head + "auto";
      if (s.includes("credit")) return head + "cr";
      return head + raw.slice(head.length, head.length + 6);
    };
    // The bar is what is left, not what was used: a full bar means room to go.
    // The track is a share of the panel and the fill a share of the track, so
    // both follow a resize; percentages must be whole numbers here.
    // The bar is what is left, not what was used: a full bar means room to go.
    // Its track is a share of the live sidebar width and the fill a share of the
    // track; a percentage inside an element sized by a percentage does not
    // resolve here, so both are measured in pixels every render.
    const panelW = Math.max(220, (find(layout(), "sidebar")?.size?.px ?? 380) - 40);
    const trackW = Math.round(panelW * 0.42);
    const bar = (used) => {
      const left = Math.max(0, Math.min(100, 100 - (Number(used) || 0)));
      return h_flex().gap(6).items_center()
        .child(div().w(trackW).h(3).rounded(2).bg(t.raised)
          .child(div().h(3).w(left > 0 ? Math.max(1, Math.round(trackW * left / 100)) : 0).rounded(2)
            .bg(left <= 10 ? t.blocked : left <= 30 ? t.working : t.done)))
        .child(div().w(34).text_size(10).text_color(t.muted).child(Math.round(left) + "%"));
    };

    const plans = new Map();
    for (const q of this.quotas ?? []) {
      const key = [q.name ?? q.provider ?? "", q.plan ?? ""].join("|");
      const holder = plans.get(key) ?? { key, name: String(q.name ?? q.provider ?? ""), plan: String(q.plan ?? ""), n: 0, windows: new Map(), accounts: [] };
      holder.n += 1;
      holder.accounts.push(q);
      for (const w of q.windows ?? []) {
        if (!Number.isFinite(w.used)) continue;
        const seen = holder.windows.get(w.name) ?? { name: w.name, used: 0, resetsAt: null };
        seen.used = Math.max(seen.used, w.used);
        seen.resetsAt = seen.resetsAt ?? w.resetsAt ?? null;
        holder.windows.set(w.name, seen);
      }
      plans.set(key, holder);
    }

    // Fixed left labels, percentage bar; this panel lays out left to right with
    // no alignment helpers, so every column states its own width.
    const winRow = (w) => h_flex().gap(6).items_center()
      .child(div().w(46).text_size(10).text_color(t.dim).child(short(w.name)))
      .child(bar(w.used))
      .child(div().w(Math.round(panelW * 0.22)).text_size(9.5).text_color(t.dim).child(resetIn(w.resetsAt)));

    const account = (p) => {
      const single = p.accounts.length <= 1;
      const open = single || this.openPlans.has(p.key);
      // One account needs no switch: its bars are the row. Several stay folded
      // until opened, then each account lists its own.
      const wins = single ? [...p.windows.values()].sort((a, b) => b.used - a.used).slice(0, 3) : [];
      const detail = single ? [] : p.accounts.slice(0, 8);
      const shown = (q) => (q.windows ?? []).filter((w) => Number.isFinite(w.used)).slice(0, 3);
      const tall = detail.reduce((n, q) => n + 20 + shown(q).length * 18, 0) + 6;
      return v_flex().w_full().gap(1).py(3).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => {
            if (single) return;
            open ? this.openPlans.delete(p.key) : this.openPlans.add(p.key);
            localStorage.setItem("spaces-tree.openPlans", JSON.stringify([...this.openPlans]));
            cx.notify();
          })
          .child(h_flex().w(14).items_center().justify_center()
            .when(!single, (el) => el.child(svg(open ? "mods/workspace-chrome/chevron-down.svg" : "mods/workspace-chrome/chevron-right.svg")
              .size(12).flex_none().text_color(open ? t.foreground : t.dim))))
          .child(div().min_w(0).w(Math.round(panelW * 0.42)).truncate().text_size(12.5).text_color(t.foreground).child(p.name))
          .child(div().min_w(0).w(Math.round(panelW * 0.28)).truncate().text_size(10).text_color(t.dim).child(p.plan))
          .when(p.n > 1, (el) => el.child(div().text_size(10).text_color(t.dim).child("\u00d7" + p.n))))
        .children(wins.map(winRow))
        .when(!single, (el) => el.child(v_flex().gap(2).pl(13).overflow_hidden().h(open ? tall : 0)
          .transition("height", { duration: 150, easing: "ease-out" })
          .children(detail.map((q) => v_flex().gap(0)
            .child(div().py(1).text_size(10).text_color(t.muted).child(String(q.user ?? q.name ?? "")))
            .children(shown(q).map(winRow))))));
    };
    // Plans with several accounts first: those are the ones with a switch.
    const worst = (p) => Math.max(...[...p.windows.values()].map((w) => w.used));
    const rows = [...plans.values()]
      .filter((p) => p.windows.size > 0)
      .sort((a, b) => (b.accounts.length > 1) - (a.accounts.length > 1) || worst(b) - worst(a))
      .slice(0, collapsed ? 3 : 6);
    const line = (label, value) => h_flex().gap(6).items_center()
      .child(div().w(Math.round(panelW * 0.28)).flex_none().text_size(11).text_color(t.dim).child(label))
      .child(div().min_w(0).w(Math.round(panelW * 0.60)).truncate().text_size(11.5).text_color(t.foreground).child(value));

    return v_flex().flex_1().min_h(0).px(12).pb(12).gap(4).overflow_y_scrollbar()
      .child(h_flex().gap(6).items_center()
        .child(div().w(panelW - 126).text_size(12).text_color(t.dim).child("magpie \u00b7 usage"))
        .child(div().w(100).text_size(10).text_color(t.dim).child(this.gwAt ? "sampled " + clockOf(this.gwAt) : ""))
        .child(div().id("magpie-usage-refresh").w(20).text_size(13).text_color(t.dim).cursor_pointer()
          .hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => { this.gwAt = 0; this.loadGateway(cx); this.refreshStats(cx); }).child("\u21bb")))
      .when(this.gwError || (!this.key && !rows.length), (el) => el.child(div().text_size(11).text_color(t.blocked)
        .child(this.gwError ? "Gateway unreachable." : "No magpie key in omp auth.")))
      .children(rows.map(account))
      .when(Boolean(today), (el) => el.child(v_flex().gap(2).pt(5)
        .child(div().text_size(10.5).text_color(t.dim).child("today"))
        .child(line("calls", String(today.calls ?? 0)))
        .child(line("cost", "$" + Number(today.cost ?? 0).toFixed(2)))
        .child(line("tokens out", String(today.output ?? 0)))))
      .when(Boolean(local), (el) => el.child(v_flex().gap(2).pt(5).border_t(1).border_color(t.border)
        .child(div().text_size(10.5).text_color(t.dim).child("omp \u00b7 today"))
        .child(line("requests", String((local.series ?? []).filter((p) => p.timestamp >= dayStart.getTime()).reduce((n, p) => n + (p.requests ?? 0), 0))))
        .child(line("cache reads", Math.round((local.overall?.cacheRate ?? 0) * 100) + "%"))));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r, last = false) => (collapsed ? this.compact(r, t) : this.row(r, t, last ? "elbow" : "tee"));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).text_size(12).text_color(t.dim)
      .when(collapsed, (el) => el.flex().items_center().justify_center())
      .child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map((r) => draw(r, true));
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, (el) => el.justify_center())
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("spaces-tree.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(deviceIcon(m)).size(14).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .when(collapsed, (el) => el.justify_center())
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.map((r, i) => draw(r, i === mine.length - 1)) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t, prefix) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const seed = seedOf(w.id);
    const fill = color.startsWith("#") ? color : MOCHA[seed % MOCHA.length];
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .when(Boolean(prefix), (el) => el.pl(6))
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(prefix), el => el.child(svg(`mods/spaces-tree/${prefix}.svg`).w(14).h(20).flex_none().text_color(t.dim)))
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(11).font_bold().text_color("#11111b").child(GLYPHS[seed % GLYPHS.length])))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .when(agents().some((a) => a.space === w.id), (el) => el.child(h_flex().flex_none().h(15).min_w(15).px(4)
            .items_center().justify_center().rounded(8).bg(t.raised).text_size(10).text_color(t.muted)
            .child(String(agents().filter((a) => a.space === w.id).length))))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    // The rail has no tabs: it always lists spaces, whatever tab the panel was on.
    const tab = collapsed ? "spaces" : (this.tab ?? "spaces");
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(34).pl(collapsed ? 0 : 16).pr(collapsed ? 0 : 10).items_center().justify_between().text_size(12).text_color(t.dim)
        .when(collapsed, (el) => el.justify_center())
        .when(!collapsed, el => el.child(h_flex().gap(2)
          .children([{ id: "spaces", label: "Spaces" }, { id: "routing", label: "Routing" }, { id: "usage", label: "Usage" }].map((v) => {
            const on = (this.tab ?? "spaces") === v.id;
            return h_flex().id("space-tab-" + v.id).h(23).px(9).flex_none().items_center().rounded(7)
              .text_size(12).cursor_pointer().bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
              .hover((x) => x.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => { this.tab = v.id; setShared("spaces-tree.tab", v.id); if (v.id === "usage") this.loadStats(cx); if (v.id === "routing") this.loadTrace(cx); cx.notify(); })
              .child(v.label);
          }))))
        .when(tab === "spaces", (el) => el.child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(tab === "usage"
        ? this.usageView(t, collapsed)
        : tab === "routing"
        ? this.routingView(t, collapsed)
        : v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
          .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
          .children(this.grouped(t, collapsed)));
  }
}
