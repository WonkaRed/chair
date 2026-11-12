// The "Try it" panel: the overreach game, the join toy and the test coins are three sections that keep their own ids and code; this makes them the panels
// of one tab strip. Without script they are simply stacked, as before. A panel the page hides (join and the coins appear only when the desk can serve them)
// has its tab hidden with it, and a link to any panel opens that panel's tab.

/** `root` holds `[role=tablist]` and the `.tabpanel` sections; each tab is `#tab-<panel id>`. `Observer` is injectable for tests. Returns `{ select, panelOf }`. */
export function setupTabs(doc, root, { Observer = globalThis.MutationObserver } = {}) {
  const list = root.querySelector('[role="tablist"]');
  const panels = [...root.querySelectorAll(".tabpanel")];
  const tabOf = (panel) => doc.getElementById(`tab-${panel.id}`);
  if (list === null || panels.length === 0 || panels.some((p) => tabOf(p) === null)) return null;
  let current = null;

  const visible = () => panels.filter((p) => !p.hidden);
  function select(panel, { focus = false } = {}) {
    if (panel.hidden) return;
    current = panel;
    for (const p of panels) {
      const on = p === panel;
      const tab = tabOf(p);
      p.classList.toggle("on", on);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    if (focus) tabOf(panel).focus();
  }
  /** Writing `hidden` again, even to the same value, is a change the observer sees: write it only when it differs, or sync would watch itself forever. */
  const setHidden = (el, on) => {
    if (el.hidden !== on) el.hidden = on;
  };
  /** A tab shows exactly when its panel is shown; if the open one goes away, the first one left opens. */
  function sync() {
    for (const p of panels) setHidden(tabOf(p), p.hidden);
    const shown = visible();
    setHidden(list, shown.length < 2);
    if (current === null || current.hidden) {
      const first = shown[0];
      if (first !== undefined) select(first);
    }
  }

  for (const p of panels) {
    p.setAttribute("role", "tabpanel");
    tabOf(p).addEventListener("click", () => select(p));
  }
  list.addEventListener("keydown", (e) => {
    const shown = visible();
    const at = shown.indexOf(panels.find((p) => tabOf(p) === e.target) ?? current); // from the tab that has focus
    const next = { ArrowRight: shown[(at + 1) % shown.length], ArrowLeft: shown[(at - 1 + shown.length) % shown.length], Home: shown[0], End: shown.at(-1) }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next, { focus: true });
  });
  root.classList.add("try-on");
  if (typeof Observer === "function") new Observer(sync).observe(root, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  sync();
  return { select, panelOf: (el) => el.closest?.(".tabpanel") ?? null };
}
