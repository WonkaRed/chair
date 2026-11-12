// The one line near the top of the page. The static HTML holds a real fallback, a press answer the chain holds (it is also in the reviewed book);
// once the chain is read, the newest press answer in the verified minutes replaces it. The caption always says which of the two is on screen.
import { clear, h } from "./dom.js";
import { isTxHash, safeText } from "./text.js";

const QUOTE_CAP = 300;

/** The newest press answer of `pressFromChain`'s list (newest decision first, a decision's lines in the order the Chair wrote them), or null. */
export function newestAnswer(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const sameTx = list.filter((e) => e.tx === list[0].tx);
  return sameTx[sameTx.length - 1];
}

/**
 * `fig` is the figure in index.html: a blockquote and a figcaption. `entry` is `{ answer, epoch, tx }`; `live` says whether it was just read from the
 * chain. A link to the transaction is added only when there is an explorer and a real transaction hash.
 */
export function setPullQuote(doc, fig, entry, { explorer = null, live = false } = {}) {
  const quote = fig.querySelector("blockquote");
  const caption = fig.querySelector("figcaption");
  quote.textContent = safeText(entry.answer, QUOTE_CAP);
  clear(caption);
  const where = Number.isSafeInteger(entry.epoch) ? `, meeting ${entry.epoch}` : "";
  caption.append(h(doc, "span", {}, `${live ? "The Chair's newest answer to the press" : "A line the Chair gave the press"}${where}. `));
  if (explorer !== null && isTxHash(entry.tx)) caption.append(h(doc, "a", { href: `${explorer}/txns/${entry.tx}`, rel: "noopener noreferrer", target: "_blank" }, "On chain"));
}

/** Turns the static fallback into its linked, truthful form (the page's fallback carries its transaction and meeting as data). */
export function linkFallback(doc, fig, explorer) {
  const quote = fig.querySelector("blockquote");
  setPullQuote(doc, fig, { answer: quote.textContent, epoch: Number(fig.dataset.epoch), tx: fig.dataset.tx }, { explorer });
}
