import { formatTokens } from "./amounts.js";
import { renderBound } from "./bound.js";
import { lineChart } from "./charts.js";
import { clear, h } from "./dom.js";
import { renderEarlier } from "./earlier.js";
import { renderGuarantees, VERIFY_COMMAND } from "./guarantees.js";
import { holdersModel, renderHolders, renderHoldersUnavailable } from "./holders.js";
import { createLive } from "./live.js";
import { loadEarlier, loadLog, parsePolicy } from "./loadlog.js";
import { createJoin } from "./join.js";
import { createMine, SEND_TIMEOUT_MS } from "./mine.js";
import { decisionsOfTxs } from "./decisions.js";
import { loadTexts, ownLines, renderHero, renderHeroPending, renderMinutes, resolveTexts } from "./minutes.js";
import { createOverreach } from "./overreach.js";
import { keepFoldsOpen } from "./keepopen.js";
import { setupPhoneFolds } from "./phonefold.js";
import { createPress, pressFromChain } from "./press.js";
import { BEST_OF, linkFallback, setBestOf } from "./pullquote.js";
import { refusalDisclosure, renderHeroStamp, renderRefusals } from "./refusals.js";
import { openFoldsAround, setupReveal } from "./reveal.js";
import { setupTabs } from "./tabs.js";
import { BEHAVIOURS, simulate } from "./simview.js";
import { failoverPoster, fixtureTransport, rpcTransport } from "./sources.js";
import { safeText } from "./text.js";
import { browserStore } from "./txcache.js";
import { fmtRate, LOG_PAGE, printUnit, renderFailure, renderLedger, renderLog, renderNow, renderPlain, renderReconcile, renderSource } from "./views.js";
import { config } from "../config.js";

const doc = document;
const $ = (id) => doc.getElementById(id);

function setupTheme() {
  const btn = $("theme");
  const effective = () => doc.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const label = () => (btn.textContent = effective() === "dark" ? "Light theme" : "Dark theme");
  btn.addEventListener("click", () => {
    const next = effective() === "dark" ? "light" : "dark";
    doc.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("chair-theme", next);
    } catch {
      // Storage blocked: the choice lasts for this page view.
    }
    label();
  });
  label();
}

async function makeTransport() {
  if (config.fixture === null) return { transport: rpcTransport({ ...config, store: browserStore() }), fixture: null };
  let res;
  try {
    res = await fetch(config.fixture, { credentials: "omit" });
  } catch {
    throw new Error("the recorded sandbox run could not be fetched");
  }
  if (!res.ok) throw new Error(`the recorded sandbox run could not be fetched (HTTP ${res.status})`);
  const fixture = await res.json();
  if (fixture?.schema !== "chair-web-fixture/1") throw new Error("the recorded sandbox run has an unknown schema");
  return { transport: fixtureTransport(fixture), fixture };
}

/** The hero's right-hand column keeps its place when the minutes cannot be read: a short note in the same box instead of an empty hole. */
function heroUnavailable() {
  const host = $("hero-minutes");
  clear(host);
  host.append(h(doc, "p", { class: "empty hero-empty" }, "The Chair's latest minutes could not be read just now. The numbers below say what the chain did say."));
}

/** The chain's own numbers, as soon as the quick views answer: the plain sentence, the holders' panel and the worst-case section. */
function showViews({ params, policy, supply, candidates }, made) {
  renderPlain(doc, $("now-plain"), { policy, params });
  keepFoldsOpen($("holders-body"), () => renderHolders(doc, $("holders-body"), holdersModel({ params, policy, supply, candidates }), { explorer: made.fixture ? null : config.explorerUrl, specUrl: `${config.repoUrl}/blob/${config.repoRef}/SPEC.md#epochs-and-rollover`, showPast: made.fixture === null }));
  renderBound(doc, $("bound-body"), { ...params, launchSupply: supply.launchSupply }, { explorer: made.fixture ? null : config.explorerUrl });
}

async function showChain() {
  const state = { filter: "all", newestFirst: true, shown: LOG_PAGE };
  let made;
  try {
    made = await makeTransport();
  } catch (e) {
    renderFailure(doc, $("now"), e);
    renderFailure(doc, $("now-plain"), e);
    renderHoldersUnavailable(doc, $("holders-body"), e);
    heroUnavailable();
    renderFailure(doc, $("minutes-body"), e);
    renderFailure(doc, $("refusals-body"), e);
    clear($("ledger-body"));
    return;
  }
  const texts = loadTexts();
  const showSource = () => renderSource(doc, $("source"), { mode: made.fixture ? "fixture" : "live", config, fixture: made.fixture, rpcUrl: made.transport.rpcInUse?.() });
  showSource();
  let shown = null; // the data on screen, if a read has succeeded
  const minutesView = { shown: 0, total: 0 }; // how many minutes cards are open, kept between draws (js/minutes.js)
  const explorer = made.fixture ? null : config.explorerUrl;
  const indexerUrl = made.fixture ? null : config.indexerUrl;
  const contextFor = (bundled, resolved, params) => ({ texts: bundled, resolved, explorer, indexerUrl, repoBase: `${config.repoUrl}/blob/${config.repoRef}`, network: made.fixture ? null : config.network, unit: printUnit(params) });
  let heroEpoch = null; // the meeting of the decision the hero shows, once it shows one
  const drawHero = (d, ctx) => {
    keepFoldsOpen($("hero-minutes"), () => renderHero(doc, $("hero-minutes"), d, ctx)); // every read redraws it: its silence line follows the meeting, and an open proof stays open
    // Where the two columns stack, the minutes (and their mark) fall below the first screen: a link-sized copy of the mark, only for a minute that checked out, sits under the sentence.
    const mark = $("hero-minutes").querySelector(".minutes-paper.verified .seal .verdict");
    const quick = $("hero-verified");
    clear(quick);
    quick.hidden = mark === null;
    if (mark !== null) quick.append(h(doc, "a", { class: mark.className, href: "#hero-minutes" }, mark.textContent.trim()));
    const meeting = d.decisions[0]?.epoch ?? null;
    if (meeting !== null && heroEpoch !== null && meeting > heroEpoch) $("hero-minutes").firstElementChild?.classList.add("fresh"); // a minute that arrives while the page is open eases in (style.css; not under reduced motion)
    if (meeting !== null) heroEpoch = meeting;
  };
  const live = config.fixture === null ? createLive(doc, $("next-meeting"), {
    readPolicy: () => made.transport.view("get_policy").then(parsePolicy),
    reload: async () => {
      await reloadChain();
      return shown?.decisions[0]?.epoch ?? -1;
    },
  }) : null;
  /** The chain's views have answered but the index has not: what is already true goes in the hero (see `renderHeroPending`), unless a read has drawn it. */
  const showPending = async ({ policy, params }) => {
    const bundled = await texts;
    const remembered = decisionsOfTxs(made.transport.remembered?.() ?? [], made.transport.token).decisions.slice(0, 1);
    const resolved = await resolveTexts(remembered, bundled);
    if (!pendingOpen) return;
    renderHeroPending(doc, $("hero-minutes"), { policy, remembered }, contextFor(bundled, resolved, params));
  };
  let pendingOpen = true; // false once any read has drawn the hero for real
  const run = async () => {
    let data;
    let over = false; // the whole read has ended: its own hero draw is the last word
    let early = false; // the read-ahead drew the hero in this read
    /** The newest decision, read ahead of the rest of the log: the hero is drawn from it as soon as it is known. */
    const showLatest = async ({ decision, policy, params }) => {
      const bundled = await texts;
      const resolved = await resolveTexts([decision], bundled);
      if (over) return;
      early = true;
      pendingOpen = false;
      drawHero({ decisions: [decision], remembered: [], status: "partial", policy }, contextFor(bundled, resolved, params));
    };
    try {
      data = await loadLog(made.transport, { onViews: (views) => (showViews(views, made), live?.setPolicy(views.policy), pendingOpen && !over && !early && void showPending(views)), onLatest: showLatest });
    } catch (e) {
      over = true;
      pendingOpen = false;
      if (shown !== null) {
        // A failed retry must not take down what was read: keep it, and say quietly that the chain is out of reach for the moment.
        renderReconcile(doc, $("reconcile"), shown, { onRetry: run });
        $("reconcile").prepend(h(doc, "p", { class: "note", role: "status" }, `Reconnecting: the chain could not be reached just now (${safeText(e?.message ?? String(e), 160)}). Everything on this page is from the last successful read.`));
        return;
      }
      renderFailure(doc, $("now"), e);
      renderFailure(doc, $("now-plain"), e);
      renderHoldersUnavailable(doc, $("holders-body"), e);
      heroUnavailable();
      renderFailure(doc, $("minutes-body"), e);
      renderFailure(doc, $("refusals-body"), e);
      clear($("ledger-body"));
      clear($("reconcile"));
      clear($("log-body"));
      return;
    }
    over = true;
    await paint(data, { earlier: false, early });
  };
  /** Everything that is drawn from the transactions read. A read of older ones (`earlier`) draws only what they can change, so the rest of the page stays as the visitor left it. */
  const paint = async (data, { earlier, early = false }) => {
    const before = shown;
    shown = data;
    showSource();
    const bundled = await texts;
    const ctx = contextFor(bundled, await resolveTexts([...data.decisions, ...data.remembered], bundled), data.params);
    chainData = data;
    resolvedTexts = ctx.resolved;
    // A read of older transactions that a newer read has overtaken (a join-watch reload finished first) is dropped: it would paint the older window over it.
    const more = async () => {
      const base = shown;
      const next = await loadEarlier(made.transport, base);
      if (shown === base) await paint(next, { earlier: true });
    };
    keepFoldsOpen($("minutes-body"), () => renderMinutes(doc, $("minutes-body"), data, ctx, minutesView));
    renderEarlier(doc, $("minutes-earlier"), data, { what: "decisions", label: "Show earlier meetings", more });
    renderRefusals(doc, $("refusals-body"), data, { explorer, indexerUrl });
    renderHeroStamp(doc, $("hero-stamp"), data, { explorer });
    const disclosure = refusalDisclosure(data);
    if (disclosure !== null) $("limits-refusals").textContent = disclosure;
    renderEarlier(doc, $("refusals-earlier"), data, { what: "refusals", label: "Show earlier refusals", more });
    renderReconcile(doc, $("reconcile"), data, { onRetry: run });
    const draw = () => renderLog(doc, $("log-body"), data, state, { explorer, indexerUrl, rerender: draw });
    draw();
    renderEarlier(doc, $("log-earlier"), data, { what: "mints and burns", label: "Show earlier mints and burns", more });
    if (earlier && !before?.outOfReach) return; // an earlier read changes the hero only when it has just found the first decision
    // What the read-ahead drew stands when the index failed part-way and the whole read has no decision to say.
    live?.setPolicy(data.policy);
    pendingOpen = false;
    if (data.decisions.length > 0 || !early) drawHero(data, ctx);
    overreach.refresh();
    committee.refresh();
    mine?.refresh();
    const answers = pressFromChain(data.decisions, ctx.resolved);
    press.setChain(answers);
    setBestOf(doc, $("best-of"), ownLines(data.decisions, ctx.resolved, BEST_OF), { explorer });
    renderNow(doc, $("now"), data);
    renderLedger(doc, $("ledger-body"), data);
  };
  let reading = null; // one read at a time: the join panel asks again while it waits for the Chair's minutes
  reloadChain = () => (reading ??= run().finally(() => (reading = null)));
  await reloadChain();
}

/** One honest line for the supply chart: the behaviours that barely move the supply are drawn on top of each other there, so say so and point at the chart that tells them apart. */
function stayedPut(series) {
  const flat = series.filter((s) => Math.max(...s.supplyPct.map((v) => Math.abs(v - 100))) < 0.5);
  if (flat.length < 2) return "";
  const worst = Math.max(...flat.flatMap((s) => s.supplyPct.map((v) => Math.abs(v - 100))));
  const names = flat.map((s) => s.label).join(", ").replace(/, ([^,]*)$/, " and $1");
  return ` ${names} all stay within ${worst.toFixed(2)}% of the launch supply, so they run together here as bands of colour. The rate chart above shows how they differ.`;
}

function showSimulation() {
  const sim = simulate();
  const slots = Object.fromEntries(BEHAVIOURS.map((b, i) => [b.id, i + 1]));
  const series = (key) => sim.series.map((s) => ({ id: s.id, label: s.label, slot: slots[s.id], values: s[key] }));
  const charts = [
    lineChart(doc, { title: "Total supply", caption: `As a share of the launch supply: 100% is where it started.${stayedPut(sim.series)}`, series: series("supplyPct"), fmt: (v, axis) => (axis ? `${v}%` : `${v.toFixed(2)}% of launch`), guides: [{ value: 100, label: "launch" }] }),
    lineChart(doc, { title: "Rate in effect", caption: "Basis points. Above zero mints for stakers, as basis points of supply a day, shared out over the day's meetings. Below zero burns a share of each transfer.", series: series("rateBps"), domain: [-200, 200], fmt: (v, axis) => (axis ? fmtRate(Math.round(v)).replace(" bps", "") : fmtRate(Math.round(v))), guides: [] }),
    lineChart(doc, { title: "Staking reward per meeting", caption: "New tokens a meeting's mint pays per staked token, as a percentage of the stake. Zero whenever the rate is not positive.", series: series("rewardPct"), fmt: (v, axis) => (axis ? `${v}%` : `${v.toFixed(3)}% of stake`) }),
  ];
  // Up front, the chart that tells all five apart (the rate); the two where some of them run together sit in the fold-out.
  $("sim-charts").append(charts[1].element);
  for (const c of [charts[0], charts[2]]) $("sim-charts-more").append(c.element);

  const legend = $("sim-legend");
  const visible = new Set(BEHAVIOURS.map((b) => b.id));
  const drawLegend = () => {
    clear(legend);
    legend.append(h(doc, "ul", { class: "legend", "aria-label": "Chair behaviours. Press to show or hide one in all three charts." }, BEHAVIOURS.map((b) => {
      const on = visible.has(b.id);
      const btn = h(doc, "button", { type: "button", class: `legend-item${on ? "" : " off"}`, "aria-pressed": String(on), title: b.note }, h(doc, "span", { class: `swatch s${slots[b.id]}` }), b.label);
      btn.addEventListener("click", () => {
        if (on && visible.size > 1) visible.delete(b.id);
        else visible.add(b.id);
        for (const c of charts) c.setVisible(visible);
        drawLegend();
      });
      const focus = (id) => () => charts.forEach((c) => c.setFocus(id));
      btn.addEventListener("pointerenter", focus(b.id));
      btn.addEventListener("pointerleave", focus(null));
      btn.addEventListener("focus", focus(b.id));
      btn.addEventListener("blur", focus(null));
      return h(doc, "li", {}, btn);
    })));
  };
  drawLegend();

  const rows = sim.series.map((s) => h(doc, "tr", {},
    h(doc, "th", { scope: "row" }, h(doc, "span", { class: `swatch s${slots[s.id]}` }), s.label, h(doc, "span", { class: "sub" }, s.note)),
    h(doc, "td", { "data-label": "Final supply" }, `${(Number((s.finalSupply * 10_000n) / sim.initialSupply) / 100).toFixed(1)}% of launch`),
    h(doc, "td", { "data-label": "Minted" }, formatTokens(s.minted, 0)),
    h(doc, "td", { "data-label": "Burned" }, formatTokens(s.burned, 0)),
    h(doc, "td", { "data-label": "Final rate" }, fmtRate(s.rateBps[s.rateBps.length - 1])),
  ));
  $("sim-summary").append(h(doc, "table", { class: "summary" }, h(doc, "caption", {}, `After ${sim.epochs} meetings, from a launch supply of ${formatTokens(sim.initialSupply, 0)} tokens`), h(doc, "thead", {}, h(doc, "tr", {}, ["Chair", "Final supply", "Minted", "Burned", "Final rate"].map((t) => h(doc, "th", { scope: "col" }, t)))), h(doc, "tbody", {}, rows)));

  const p = sim.series[0].params;
  $("sim-assumptions").append(h(doc, "ul", { class: "plain" },
    h(doc, "li", {}, `${p.stakedBps / 100}% of the supply is staked, split over three stakers (50%, 30%, 20%) who claim every meeting. Staking more locks the stake for two meetings.`),
    h(doc, "li", {}, `Each meeting ${p.velocityBps / 100}% of the liquid supply moves in ${p.transfersPerEpoch} equal transfers; each burns the rate while it is negative. Nothing else trades.`),
    h(doc, "li", {}, "The chair behaviours are scripts that ignore the market. The honest chair is the shipped rule chair (rule-v1) ported to the simulator; the others are the extremes the contract allows."),
    h(doc, "li", {}, "All arithmetic is in exact integers with the contract's rounding. The simulator was written from SPEC.md and read against the contract source; it does not run the contract. There is no price, no demand and no selling."),
    h(doc, "li", {}, `A mint needs someone staked. The rate is per day: at +200 bps (2% a day) each meeting mints 1/${sim.meetingsPerDay} of that into the reward pool, shared by whoever is staked.`),
  ));
}

function showGuarantees() {
  $("guarantee-list").append(renderGuarantees(doc, config));
  const copy = $("copy");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(VERIFY_COMMAND);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Select the command and copy it";
    }
    setTimeout(() => (copy.textContent = "Copy"), 2000);
  });
}

/** Sections ease in as they are reached; a link into a folded section opens the fold. */
function setupPage() {
  setupPhoneFolds(doc);
  const tabs = setupTabs(doc, $("try"));
  setupReveal([...doc.querySelectorAll(".reveal")], doc.documentElement);
  const open = (fragment) => {
    let id = "";
    try {
      id = decodeURIComponent(fragment.replace(/^#/, ""));
    } catch {
      // A malformed fragment names nothing.
    }
    const target = id === "" ? null : doc.getElementById(id);
    if (target) {
      const panel = tabs?.panelOf(target);
      if (panel) tabs.select(panel); // a link to a panel of the "Try it" strip opens its tab
      for (const fold of target.querySelectorAll(":scope > .phone-fold")) fold.open = true; // a link to a section opens its phone fold
      openFoldsAround(target);
    }
  };
  addEventListener("hashchange", () => open(location.hash));
  // The same link pressed twice changes no hash, so the link itself is what opens the fold again after the visitor shut it.
  doc.addEventListener("click", (e) => {
    const link = e.target?.closest?.('a[href^="#"]');
    if (link) open(link.getAttribute("href"));
  });
  open(location.hash);
}

setupTheme();
const pageExplorer = config.fixture === null ? config.explorerUrl : null;
linkFallback(doc, $("best-of"), pageExplorer);
renderBound(doc, $("bound-body"), {}, { explorer: pageExplorer });
const press = createPress(doc, $("press-body"), { discoveryUrl: config.pressDiscoveryUrl, discoveryApiUrl: config.pressDiscoveryApiUrl ?? "", explorer: pageExplorer });
let chainData = null; // loadLog's latest result, for the overreach panel's hint and its desk-closed list
let resolvedTexts = null; // the minutes texts that match their chain hashes, for the join panel
let reloadChain = async () => undefined;
const overreach = createOverreach(doc, $("overreach-body"), { request: press.request, explorer: pageExplorer, rpcUrl: config.rpcUrls[0], refusals: () => chainData });
const committee = createJoin(doc, $("join-body"), { section: $("join"), request: press.request, explorer: pageExplorer, chain: () => ({ data: chainData, resolved: resolvedTexts }), reload: () => reloadChain() });
// Your own test coins: the visitor's key, the faucet's coins, and calls signed in this browser and sent to the same RPC nodes the page reads from (not in the recorded-run mode, which has none).
const wire = (ms) => failoverPoster(fetch.bind(globalThis), "rpc", config.rpcUrls, undefined, ms);
const [readNodes, sendNodes] = config.fixture === null ? [wire(10_000), wire(SEND_TIMEOUT_MS)] : [null, null]; // a node may take some seconds to run a transaction
const mine = readNodes === null ? null : createMine(doc, $("mine-body"), { section: $("mine"), link: $("nav-mine"), request: press.request, post: (body) => (body.method === "send_tx" ? sendNodes : readNodes).post("", body), token: config.account, explorer: pageExplorer, sample: config.sampleReceiver, supply: () => chainData?.supply.totalSupply ?? null });
showGuarantees();
showSimulation();
setupPage();
await showChain();
