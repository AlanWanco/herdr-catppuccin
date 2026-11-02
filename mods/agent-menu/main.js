// The row menu of agents-tree: rename, archive, and a Catppuccin label. It is a
// popup of its own, opened from a row's right-click, the way
// herdr's own menus are: it closes on an item, or on Esc.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, props, closeOverlay, run, theme, shared, setShared } from "herdr";

// Catppuccin Mocha: the labels a row can carry, in the palette's order.
const LABELS = [
  ["rosewater", "#f5e0dc"], ["flamingo", "#f2cdcd"], ["pink", "#f5c2e7"], ["mauve", "#cba6f7"],
  ["red", "#f38ba8"], ["maroon", "#eba0ac"], ["peach", "#fab387"], ["yellow", "#f9e2af"],
  ["green", "#a6e3a1"], ["teal", "#94e2d5"], ["sky", "#89dceb"], ["sapphire", "#74c7ec"],
  ["blue", "#89b4fa"], ["lavender", "#b4befe"],
];

// A terminal title arrives as "π ⠦ <icon> Task": drop omp's mark and the glyph noise.
const cleanTitle = (raw) => String(raw ?? "")
  .replace(/[\u2800-\u28FF\uE000-\uF8FF]/g, "")
  .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")
  .replace(/^\s*\u03C0\s*/u, "")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/^[^\p{L}\p{N}]+/u, "");

export default class AgentMenu extends View {
  render() {
    const t = theme();
    const p = props() ?? {};
    const address = p.agent;
    const a = agents().find((x) => x.address === address) ?? null;
    if (!a) return v_flex().p(8).text_size(12).text_color(t.muted).child("That agent is gone.");

    const mine = (shared("agents-tree.labels") ?? {})[address] ?? null;
    const archived = (shared("agents-tree.archived") ?? []).includes(address);

    const finish = (fn) => () => {
      fn();
      closeOverlay(p.overlay);
    };
    const item = (id, text, onClick) => h_flex().id(id).h(26).px(8).items_center().rounded(6)
      .text_size(12).text_color(t.foreground).cursor_pointer().hover((el) => el.bg(t.hover))
      .on_click(onClick)
      .child(text);
    const swatch = ([name, hex]) => div().id("lm-" + name).size(16).flex_none().rounded(8).bg(hex).cursor_pointer()
      .when(mine === name, (el) => el.border(2).border_color(t.foreground))
      .hover((el) => el.border(2).border_color(t.muted))
      .on_click(finish(() => {
        const next = { ...(shared("agents-tree.labels") ?? {}) };
        next[address] = name;
        setShared("agents-tree.labels", next);
      }));

    return v_flex().w_full().p(5).bg(t.popover).gap(1)
      .child(div().px(8).pt(4).pb(4).text_size(11).text_color(t.dim).truncate()
        .child(cleanTitle(a.title) || a.program?.name || a.address))
      .child(item("am-rename", "重命名…", finish(() => run("tab.rename", { id: a.tab }))))
      .child(item("am-archive", archived ? "取消归档" : "归档", finish(() => {
        const list = (shared("agents-tree.archived") ?? []).filter((x) => x !== address);
        if (!archived) list.push(address);
        setShared("agents-tree.archived", list);
      })))
      .child(div().px(8).pt(6).pb(2).text_size(10).text_color(t.dim).child(mine ? "标签 · " + mine : "标签"))
      .children([LABELS.slice(0, 7), LABELS.slice(7)].map((line) => h_flex().gap(6).px(8).py(2).children(line.map(swatch))))
      .when(Boolean(mine), (el) => el.child(item("am-clear", "清除标签", finish(() => {
        const next = { ...(shared("agents-tree.labels") ?? {}) };
        delete next[address];
        setShared("agents-tree.labels", next);
      }))));
  }
}
