// Sections ease in as they are scrolled to. Nothing is hidden unless this has set up an observer: the stylesheet only hides what
// `.reveal-on .reveal:not(.in)` covers, so without script, without IntersectionObserver, or with reduced motion asked for, the whole page is simply there.
const prefersReduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/** `items` are the `.reveal` elements and `root` the page element that gets `reveal-on`. Those already on screen are shown at once, without a fade. */
export function setupReveal(items, root, { observer = globalThis.IntersectionObserver, reduced = prefersReduced(), viewHeight = globalThis.innerHeight } = {}) {
  if (typeof observer !== "function" || reduced) return false;
  const onScreen = (el) => el.getBoundingClientRect().top < viewHeight;
  items.filter(onScreen).forEach((el) => el.classList.add("in"));
  const waiting = items.filter((el) => !onScreen(el));
  const io = new observer((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px" });
  for (const el of waiting) io.observe(el);
  root.classList.add("reveal-on");
  return true;
}

/** Opens every closed fold-out around `el` and scrolls to it, so a link into a folded section lands on something visible. */
export function openFoldsAround(el) {
  let opened = false;
  for (let n = el; n; n = n.parentElement) {
    if (n.tagName === "DETAILS" && !n.open) (n.open = true), (opened = true);
  }
  if (opened) el.scrollIntoView?.();
  return opened;
}
