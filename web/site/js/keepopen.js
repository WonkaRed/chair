// A section that is drawn again (the page reads the chain again) must not shut what the visitor opened: the proof under the newest minutes, a fold on a phone.
// Folds are matched by their order inside the section, which a redraw of the same section keeps. A fold the visitor had shut is left as the redraw makes it.

/** Runs `draw`, which rebuilds the contents of `host`, and then opens again every `<details>` that was open before it. */
export function keepFoldsOpen(host, draw) {
  const was = [...host.querySelectorAll("details")].map((fold) => fold.open === true);
  draw();
  host.querySelectorAll("details").forEach((fold, i) => {
    if (was[i]) fold.open = true;
  });
}
