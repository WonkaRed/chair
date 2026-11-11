import { formatTokens } from "./amounts.js";
import { lineChart } from "./charts.js";
import { clear, h } from "./dom.js";
import { renderGuarantees, VERIFY_COMMAND } from "./guarantees.js";
import { loadLog } from "./loadlog.js";
import { BEHAVIOURS, simulate } from "./simview.js";
import { fixtureTransport, rpcTransport } from "./sources.js";
import { fmtPct, fmtRate, renderFailure, renderLedger, renderLog, renderNow, renderReconcile, renderSource } from "./views.js";
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
  if (config.fixture === null) return { transport: rpcTransport(config), fixture: null };
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

async function showChain() {
  const state = { filter: "all", newestFirst: true, shown: 20 };
  let made;
  try {
    made = await makeTransport();
  } catch (e) {
    renderFailure(doc, $("now"), e);
    clear($("ledger-body"));
    return;
  }
  renderSource(doc, $("source"), { mode: made.fixture ? "fixture" : "live", config, fixture: made.fixture });
  const run = async () => {
    let data;
    try {
      data = await loadLog(made.transport);
    } catch (e) {
      renderFailure(doc, $("now"), e);
      clear($("ledger-body"));
      clear($("reconcile"));
      clear($("log-body"));
      return;
    }
    renderNow(doc, $("now"), data);
    renderLedger(doc, $("ledger-body"), data);
    renderReconcile(doc, $("reconcile"), data, { onRetry: run });
    const draw = () => renderLog(doc, $("log-body"), data, state, { explorer: made.fixture ? null : config.explorerUrl, rerender: draw });
    draw();
  };
  await run();
}

function showSimulation() {
  const sim = simulate();
  const slots = Object.fromEntries(BEHAVIOURS.map((b, i) => [b.id, i + 1]));
  const series = (key) => sim.series.map((s) => ({ id: s.id, label: s.label, slot: slots[s.id], values: s[key] }));
  const charts = [
    lineChart(doc, { title: "Total supply", caption: "As a share of the launch supply: 100% is where it started.", series: series("supplyPct"), fmt: (v, axis) => (axis ? `${v}%` : `${v.toFixed(2)}% of launch`), guides: [{ value: 100, label: "launch" }] }),
    lineChart(doc, { title: "Rate in effect", caption: "Basis points. Above zero mints for stakers, below zero burns a share of each transfer.", series: series("rateBps"), domain: [-200, 200], fmt: (v) => fmtRate(Math.round(v)), guides: [] }),
    lineChart(doc, { title: "Staking reward per epoch", caption: "New tokens an epoch's mint pays per staked token, as a percentage of the stake. Zero whenever the rate is not positive.", series: series("rewardPct"), fmt: (v, axis) => (axis ? `${v}%` : `${v.toFixed(3)}% of stake`) }),
  ];
  const host = $("sim-charts");
  for (const c of charts) host.append(c.element);

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
  $("sim-summary").append(h(doc, "table", { class: "summary" }, h(doc, "caption", {}, `After ${sim.epochs} epochs, from a launch supply of ${formatTokens(sim.initialSupply, 0)} tokens`), h(doc, "thead", {}, h(doc, "tr", {}, ["Chair", "Final supply", "Minted", "Burned", "Final rate"].map((t) => h(doc, "th", { scope: "col" }, t)))), h(doc, "tbody", {}, rows)));

  const p = sim.series[0].params;
  $("sim-assumptions").append(h(doc, "ul", { class: "plain" },
    h(doc, "li", {}, `${p.stakedBps / 100}% of the supply is staked, split over three stakers (50%, 30%, 20%) who claim every epoch. Staking more locks the stake for two epochs.`),
    h(doc, "li", {}, `Each epoch ${p.velocityBps / 100}% of the liquid supply moves in ${p.transfersPerEpoch} equal transfers; each burns the rate while it is negative. Nothing else trades.`),
    h(doc, "li", {}, "The chair behaviours are scripts that ignore the market. The honest chair is the shipped rule chair (rule-v1) ported to the simulator; the others are the extremes the contract allows."),
    h(doc, "li", {}, "All arithmetic is in exact integers with the contract's rounding. The simulator was written from SPEC.md and read against the contract source; it does not run the contract. There is no price, no demand and no selling."),
    h(doc, "li", {}, "A mint needs someone staked: at +200 bps each epoch mints 2% of the supply into the reward pool, shared by whoever is staked."),
  ));
}

function showGuarantees() {
  $("guarantee-list").append(renderGuarantees(doc, config));
  $("verify-cmd").textContent = VERIFY_COMMAND;
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

setupTheme();
showGuarantees();
showSimulation();
await showChain();
