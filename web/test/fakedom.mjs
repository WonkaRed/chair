// The smallest DOM the page's builders need, so rendering is tested without a browser. Every node records what was
// put on it, which is what the hostile-string tests inspect: tags created, attributes set, text nodes.
class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.hidden = false;
    this.dataset = {};
    this.styles = {};
    this.style = { setProperty: (k, v) => (this.styles[k] = v) };
    const own = new Set();
    this.classList = { add: (c) => own.add(c), remove: (c) => own.delete(c), toggle: (c, on) => (on ?? !own.has(c) ? own.add(c) : own.delete(c)), contains: (c) => own.has(c) };
  }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(c) { this.children.push(c); return c; }
  append(...cs) { for (const c of cs.flat()) this.children.push(typeof c === "string" ? new Text(c) : c); }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 300 }; }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.children = [new Text(String(v))]; }
}
class Text {
  constructor(data) { this.data = data; }
  get textContent() { return this.data; }
}
export const fakeDoc = () => ({
  createElement: (t) => new Node(t),
  createElementNS: (_ns, t) => new Node(t),
  createTextNode: (d) => new Text(d),
});
export const host = (doc = fakeDoc()) => doc.createElement("div");
export function* walk(node) {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}
