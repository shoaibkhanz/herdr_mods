// Every Emergence shortcut in plain words, grouped, filterable by typing (as Herdr's keys dialog, ⌘/, which shows
// keys.json alone and not the keys the mods handle themselves). ⌘⇧/ or the tab bar's keyboard button. Esc closes.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { keys, props, closeOverlay, theme, setShared } from "herdr";
import { rows } from "./lib.js";

export default class EmergenceKeys extends View {
  init(_props, cx) {
    setShared("emergence.over", { at: Date.now(), open: true }); // the keyboard goes back where it was when this closes
    this.filter = "";
    this.input = InputState.new({ placeholder: "Type to filter…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  async close() { setShared("emergence.over", { at: Date.now(), open: false }); }

  render() {
    const t = theme(), close = () => closeOverlay(props().overlay);
    return v_flex().id("emergence-keys").on_key_down((e) => { if (e.key === "escape") close(); })
      .size_full().min_h(0).p(24).gap(16).bg(t.popover).text_size(12)
      .child(h_flex().h(22).items_center().justify_between()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Emergence keys"))
        .child(div().id("ek-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(close).child("Esc")))
      .child(Input.new(this.input).h(36).flex_none().px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().py(2).gap(10)
        .children(rows(keys(), this.filter).map(([name, list]) => v_flex().gap(2)
          .child(div().text_size(11.5).font_medium().text_color(t.dim).child(name))
          .children(list.map(([k, what]) => h_flex().h(26).px(8).rounded(7).items_center()
            .child(div().w(170).flex_none().text_color(t.accent).child(k))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(what)))))));
  }
}
