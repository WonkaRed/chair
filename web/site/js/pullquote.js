// "The Chair, in its own words": the closing sentence of a set of minutes, written by the AI model itself (not a line of the reviewed book: those the model only picks).
// The static HTML holds four real ones from recorded meetings, each with its transaction, as a fallback; once the chain is read, the newest four replace them.
// Each is set under a caption that says which meeting it closed and links to that meeting's transaction, when there is an explorer and a real transaction hash.
import { clear, h } from "./dom.js";
import { isTxHash, safeText } from "./text.js";

const QUOTE_CAP = 300;
/** The pull quote and the three beside it. */
export const BEST_OF = 4;

function linkTo(doc, explorer, entry, label) {
  return explorer !== null && isTxHash(entry.tx) ? h(doc, "a", { href: `${explorer}/txns/${entry.tx}`, rel: "noopener noreferrer", target: "_blank" }, label) : null;
}

const meetingOf = (entry) => (Number.isSafeInteger(entry.epoch) ? `meeting ${entry.epoch}` : "a meeting");

/** `fig` is the figure in index.html: a blockquote and a figcaption. `entry` is `{ text, epoch, tx }`. */
export function setPullQuote(doc, fig, entry, { explorer = null } = {}) {
  const caption = fig.querySelector("figcaption");
  fig.querySelector("blockquote").textContent = safeText(entry.text, QUOTE_CAP);
  clear(caption);
  caption.append(...[h(doc, "span", {}, `Closing sentence of the minutes of ${meetingOf(entry)}, written by the AI. `), linkTo(doc, explorer, entry, "On chain")].filter(Boolean)); // append(null) would print "null"
}

/** One of the three lines beside the pull quote: its quote, then the meeting and the link. */
export function setQuip(doc, li, entry, { explorer = null } = {}) {
  for (const old of li.querySelectorAll("a, span")) old.remove();
  li.querySelector("blockquote").textContent = safeText(entry.text, QUOTE_CAP);
  const label = `Meeting ${Number.isSafeInteger(entry.epoch) ? entry.epoch : "?"}, on chain`;
  li.append(linkTo(doc, explorer, entry, label) ?? h(doc, "span", {}, label.replace(", on chain", "")));
}

/** The line a static fallback item carries as data (its meeting and transaction). */
const fromData = (el, text) => ({ text, epoch: Number(el.dataset.epoch), tx: el.dataset.tx });

/** Turns the static fallback into its linked, truthful form (the page's fallback carries each transaction and meeting as data). */
export function linkFallback(doc, section, explorer) {
  const fig = section.querySelector("figure.pull");
  setPullQuote(doc, fig, fromData(fig, fig.querySelector("blockquote").textContent), { explorer });
  for (const li of section.querySelectorAll(".quips li")) setQuip(doc, li, fromData(li, li.querySelector("blockquote").textContent), { explorer });
}

/** Fills the strip from the Chair's newest own sentences (`entries`, newest first, from `ownLines`); with fewer than `BEST_OF` the recorded fallback stays, whole. */
export function setBestOf(doc, section, entries, { explorer = null } = {}) {
  if (entries.length < BEST_OF) return;
  setPullQuote(doc, section.querySelector("figure.pull"), entries[0], { explorer });
  section.querySelectorAll(".quips li").forEach((li, i) => setQuip(doc, li, entries[i + 1], { explorer }));
}
