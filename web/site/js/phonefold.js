// Folds for a phone: the deep sections stay in the page, one tap away, so the scroll is short where the screen is small. Native <details>, so the
// content is still in the page for find-in-page and for anyone without script: a fold is open in the HTML file and wherever the screen is not a phone,
// and the stylesheet hides its summary there, so a wide screen shows what it always did.

import { h } from "./dom.js";

/** The widths the page treats as a phone (the same break as its other narrow rules). */
const QUERY = "(max-width: 40rem)";

const onPhone = () => globalThis.matchMedia?.(QUERY)?.matches === true;

/** A fold the page draws itself (after the chain answers): shut on a phone, open elsewhere, and `setupPhoneFolds` keeps it in step on a resize. */
export function phoneFold(doc, label, ...children) {
  return h(doc, "details", { class: "fold phone-fold", open: !onPhone() }, h(doc, "summary", {}, label), children);
}

/** Shuts the `.phone-fold` details on a phone and opens them all again when the screen grows. `mq` is a MediaQueryList (injectable for tests). */
export function setupPhoneFolds(doc, mq = globalThis.matchMedia?.(QUERY)) {
  if (!mq) return;
  const apply = () => {
    for (const fold of doc.querySelectorAll(".phone-fold")) fold.open = !mq.matches;
  };
  apply();
  mq.addEventListener("change", apply);
}
