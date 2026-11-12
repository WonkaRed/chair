// The page reads the newest transactions of the token and no more (js/loadlog.js): the token has run for days and holds tens of thousands. What that
// means is said under each list built from them, with the control that reads the page of transactions before them. Chain strings never come in here;
// every figure is a count or a time the page computed.
import { clear, h } from "./dom.js";
import { fmtTime } from "./views.js";

/** The sentence that says what a list covers, and what it leaves out. `what` is the kind of list ("decisions", "refusals", "mints and burns"). */
export function scopeLine(d, what) {
  const since = d.sinceMs === null || d.sinceMs === undefined ? "" : `, back to ${fmtTime(d.sinceMs)}`;
  const meetings = what === "decisions" && d.decisions.length > 0 ? ` (meetings ${d.decisions.at(-1).epoch} to ${d.decisions[0].epoch})` : "";
  const always = what === "refusals" ? " and the test calls made on purpose, which are always read" : "";
  return `This shows the ${what} in the latest ${d.txCount} transactions${since}${meetings}${always}. Earlier ones are on chain and are read when you ask.`;
}

/**
 * Under a list: what it covers, and a button that reads the next page of older transactions and redraws the page from them. Nothing is drawn when
 * the whole history is already in. `more()` resolves when the page has been redrawn and rejects with the reason it could not read more.
 */
export function renderEarlier(doc, host, d, { what, label, more }) {
  clear(host);
  if (!d.partial) return;
  const status = h(doc, "p", { class: "note earlier-note" }, scopeLine(d, what));
  const button = h(doc, "button", { type: "button", class: "chip more earlier-more" }, label);
  const problem = h(doc, "p", { class: "note warnnote", role: "status", hidden: true });
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Reading earlier transactions...";
    problem.hidden = true;
    try {
      await more();
    } catch (e) {
      button.disabled = false;
      button.textContent = label;
      problem.textContent = `Earlier transactions could not be read just now (${String(e?.message ?? e).slice(0, 120)}). Press again to try again.`;
      problem.hidden = false;
    }
  });
  host.append(status, button, problem);
}
