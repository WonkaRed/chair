// Element builders. Text only ever goes in through `textContent`; there is no innerHTML anywhere in the page.
const SVG_NS = "http://www.w3.org/2000/svg";

export function h(doc, tag, attrs = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" || typeof c === "number" ? doc.createTextNode(String(c)) : c);
  }
  return node;
}

export function svg(doc, tag, attrs = {}, ...children) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
  for (const c of children.flat()) if (c) node.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
