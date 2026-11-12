// The "Try it" tab strip: roving focus, arrow keys, a hidden panel takes its tab with it, and the observer never feeds on itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { setupTabs } = await import(join(root, "site", "js", "tabs.js"));

/** An element that counts every write to `hidden`, as a MutationObserver would see it. */
function el(id = "") {
  const own = new Set();
  const e = { id, writes: 0, _hidden: false, attrs: {}, listeners: {}, tabIndex: 0, focused: false, children: [] };
  Object.defineProperty(e, "hidden", { get: () => e._hidden, set: (v) => { e.writes++; e._hidden = v; } });
  e.classList = { add: (c) => own.add(c), toggle: (c, on) => (on ? own.add(c) : own.delete(c)), contains: (c) => own.has(c) };
  e.setAttribute = (k, v) => (e.attrs[k] = v);
  e.addEventListener = (t, fn) => (e.listeners[t] ??= []).push(fn);
  e.focus = () => (e.focused = true);
  e.closest = () => null;
  return e;
}

function rig(ids = ["overreach", "join", "mine"]) {
  const panels = ids.map((id) => el(id));
  const tabs = ids.map((id) => el(`tab-${id}`));
  const list = el("tablist");
  const root = el("try");
  root.querySelector = (sel) => (sel === '[role="tablist"]' ? list : null);
  root.querySelectorAll = () => panels;
  const doc = { getElementById: (id) => tabs.find((t) => t.id === id) ?? null };
  let notify = () => {};
  class Observer { constructor(fn) { notify = fn; } observe() {} }
  const api = setupTabs(doc, root, { Observer });
  const key = (k, target = null) => { let stopped = false; list.listeners.keydown[0]({ key: k, target, preventDefault: () => (stopped = true) }); return stopped; };
  const selected = () => tabs.map((t) => t.attrs["aria-selected"]);
  return { api, panels, tabs, list, root, key, selected, notify: () => notify() };
}

test("the first panel opens; one tab is selected and focusable, the others are out of the tab order", () => {
  const r = rig();
  assert.deepEqual(r.selected(), ["true", "false", "false"]);
  assert.deepEqual(r.tabs.map((t) => t.tabIndex), [0, -1, -1]);
  assert.deepEqual(r.panels.map((p) => p.classList.contains("on")), [true, false, false]);
  assert.ok(r.root.classList.contains("try-on"), "the styles that hide the other panels apply only once script has run");
  assert.deepEqual(r.panels.map((p) => p.attrs.role), ["tabpanel", "tabpanel", "tabpanel"]);
});

test("a click opens that panel; arrows wrap and move focus; Home and End jump", () => {
  const r = rig();
  r.tabs[1].listeners.click[0]();
  assert.deepEqual(r.selected(), ["false", "true", "false"]);
  assert.equal(r.key("ArrowRight"), true);
  assert.deepEqual(r.selected(), ["false", "false", "true"]);
  assert.equal(r.tabs[2].focused, true);
  r.key("ArrowRight");
  assert.deepEqual(r.selected(), ["true", "false", "false"], "wraps round");
  r.key("ArrowLeft");
  assert.deepEqual(r.selected(), ["false", "false", "true"]);
  r.key("Home");
  assert.deepEqual(r.selected(), ["true", "false", "false"]);
  r.key("End");
  assert.deepEqual(r.selected(), ["false", "false", "true"]);
  assert.equal(r.key("a"), false, "other keys are left alone");
  r.tabs[2].listeners.click[0]();
  r.key("ArrowRight", r.tabs[0]);
  assert.deepEqual(r.selected(), ["false", "true", "false"], "arrows move from the tab that has focus");
});

test("a panel the page hides takes its tab away, and with one panel left there is no strip; the open panel hiding opens the first one left", () => {
  const r = rig();
  r.panels[1].hidden = true;
  r.panels[2].hidden = true;
  r.notify();
  assert.deepEqual(r.tabs.map((t) => t.hidden), [false, true, true]);
  assert.equal(r.list.hidden, true, "a strip of one is not shown");
  r.panels[1].hidden = false;
  r.notify();
  assert.equal(r.list.hidden, false);
  r.tabs[1].listeners.click[0]();
  r.panels[1].hidden = true;
  r.notify();
  assert.deepEqual(r.selected(), ["true", "false", "false"]);
  r.key("ArrowRight");
  assert.equal(r.selected()[0], "true", "a hidden panel is never selected");
});

test("sync writes `hidden` only when it changes: the observer watches it, so a write of the same value would loop forever", () => {
  const r = rig();
  r.panels[2].hidden = true;
  r.notify();
  const before = [...r.tabs, r.list].map((e) => e.writes);
  for (let i = 0; i < 5; i++) r.notify();
  assert.deepEqual([...r.tabs, r.list].map((e) => e.writes), before);
});

test("without the markup it does nothing and says so", () => {
  const root = el("try");
  root.querySelector = () => null;
  root.querySelectorAll = () => [];
  assert.equal(setupTabs({ getElementById: () => null }, root, { Observer: undefined }), null);
});
