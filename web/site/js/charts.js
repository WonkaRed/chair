// Line charts as plain SVG, written to the dataviz rules: 2px lines, hairline recessive grid, 8px end dots with a surface
// ring, one y axis, a legend for every multi-series chart, a crosshair tooltip, and a table view of the same numbers.
// Colours come from CSS variables (--s1..--s5), which hold the light and dark steps of one validated palette.
import { clear, h, svg } from "./dom.js";

const W = 640;
const H = 250;
const M = { l: 72, r: 16, t: 18, b: 28 };

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) return { lo: lo - 1, hi: hi + 1, ticks: [lo - 1, lo, hi + 1] };
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const nlo = Math.floor(lo / step) * step;
  const nhi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = nlo; v <= nhi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo: nlo, hi: nhi, ticks };
}

/**
 * `series`: `[{id, label, slot, values}]`, one value per epoch. The legend is the page's: it calls `setVisible` and `setFocus`. `fmt` formats a value for axis and tooltip.
 * `domain` fixes the y range (the rate chart is always -200..+200); otherwise it fits the visible series.
 */
export function lineChart(doc, { title, caption, series, fmt, domain = null, guides = [], epochsLabel = "Epoch" }) {
  const n = series[0].values.length;
  let visible = new Set(series.map((s) => s.id));
  let focus = null;
  let hover = null;

  const figure = h(doc, "figure", { class: "chart" });
  const tooltip = h(doc, "div", { class: "tooltip", role: "status", hidden: true });
  const plot = h(doc, "div", { class: "plot", tabindex: "0", role: "group", "aria-label": `${title}. Arrow keys move through epochs.` });
  const tableHost = h(doc, "div", { class: "chart-table", hidden: true });
  const toggle = h(doc, "button", { type: "button", class: "chip", "aria-pressed": "false" }, "Table");
  figure.append(h(doc, "figcaption", {}, h(doc, "span", { class: "chart-title" }, title), toggle), h(doc, "p", { class: "chart-sub" }, caption), plot, tooltip, tableHost);

  const sx = (i) => M.l + (i / (n - 1)) * (W - M.l - M.r);

  function draw() {
    clear(plot);
    const shown = series.filter((s) => visible.has(s.id));
    const all = shown.flatMap((s) => s.values);
    const dom = domain ?? (all.length ? niceTicks(Math.min(...all, ...guides.map((g) => g.value)), Math.max(...all, ...guides.map((g) => g.value))) : niceTicks(0, 1));
    const ticks = domain ? niceTicks(domain[0], domain[1], 4).ticks.filter((t) => t >= domain[0] && t <= domain[1]) : dom.ticks;
    const lo = domain ? domain[0] : dom.lo;
    const hi = domain ? domain[1] : dom.hi;
    const sy = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
    const root = svg(doc, "svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", "aria-hidden": "true", preserveAspectRatio: "xMidYMid meet" });
    for (const t of ticks) {
      root.append(svg(doc, "line", { x1: M.l, x2: W - M.r, y1: sy(t), y2: sy(t), class: t === 0 && lo < 0 ? "axis" : "grid" }));
      root.append(svg(doc, "text", { x: M.l - 8, y: sy(t) + 4, class: "tick", "text-anchor": "end" }, fmt(t, true)));
    }
    for (const g of guides) {
      root.append(svg(doc, "line", { x1: M.l, x2: W - M.r, y1: sy(g.value), y2: sy(g.value), class: "guide" }));
      root.append(svg(doc, "text", { x: W - M.r, y: sy(g.value) - 5, class: "tick", "text-anchor": "end" }, g.label));
    }
    for (let i = 0; i < n; i += 10) root.append(svg(doc, "text", { x: sx(i), y: H - 8, class: "tick", "text-anchor": "middle" }, String(i)));
    root.append(svg(doc, "text", { x: W - M.r, y: H - 8, class: "tick", "text-anchor": "end" }, epochsLabel));
    // Draw the focused series last so it sits on top.
    const order = [...shown].sort((a, b) => (a.id === focus) - (b.id === focus));
    for (const s of order) {
      const pts = s.values.map((v, i) => `${sx(i).toFixed(1)},${sy(v).toFixed(1)}`).join(" ");
      const dim = focus !== null && focus !== s.id;
      root.append(svg(doc, "polyline", { points: pts, class: `line s${s.slot}${dim ? " dim" : ""}`, fill: "none" }));
      const last = s.values.length - 1;
      root.append(svg(doc, "circle", { cx: sx(last), cy: sy(s.values[last]), r: 4, class: `dot s${s.slot}${dim ? " dim" : ""}` }));
    }
    if (hover !== null) {
      root.append(svg(doc, "line", { x1: sx(hover), x2: sx(hover), y1: M.t, y2: H - M.b, class: "cross" }));
      for (const s of shown) root.append(svg(doc, "circle", { cx: sx(hover), cy: sy(s.values[hover]), r: 4, class: `dot s${s.slot}` }));
    }
    plot.append(root);
    drawTooltip(shown, sx);
  }

  function drawTooltip(shown) {
    if (hover === null || shown.length === 0) {
      tooltip.hidden = true;
      return;
    }
    clear(tooltip);
    tooltip.append(h(doc, "div", { class: "tt-head" }, `${epochsLabel} ${hover}`));
    for (const s of [...shown].sort((a, b) => b.values[hover] - a.values[hover])) {
      tooltip.append(h(doc, "div", { class: "tt-row" }, h(doc, "span", { class: `swatch s${s.slot}` }), h(doc, "span", { class: "tt-name" }, s.label), h(doc, "span", { class: "tt-val" }, fmt(s.values[hover]))));
    }
    tooltip.hidden = false;
    // The tooltip sits beside the crosshair, flipping to the left past the middle; CSSOM writes are allowed by the CSP.
    const frac = hover / (n - 1);
    tooltip.style.setProperty("--x", `${(frac * 100).toFixed(2)}%`);
    tooltip.classList.toggle("left", frac > 0.5);
  }

  function indexAt(ev) {
    const box = plot.getBoundingClientRect();
    const x = ((ev.clientX - box.left) / box.width) * W;
    return Math.max(0, Math.min(n - 1, Math.round(((x - M.l) / (W - M.l - M.r)) * (n - 1))));
  }
  plot.addEventListener("pointermove", (ev) => ((hover = indexAt(ev)), draw()));
  plot.addEventListener("pointerleave", () => ((hover = null), draw()));
  plot.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : ev.key === "Home" ? -n : ev.key === "End" ? n : 0;
    if (step === 0) return;
    ev.preventDefault();
    hover = Math.max(0, Math.min(n - 1, (hover ?? (step > 0 ? -1 : n)) + step));
    draw();
  });
  plot.addEventListener("blur", () => ((hover = null), draw()));

  function drawTable() {
    clear(tableHost);
    const shown = series.filter((s) => visible.has(s.id));
    const head = h(doc, "tr", {}, h(doc, "th", { scope: "col" }, epochsLabel), shown.map((s) => h(doc, "th", { scope: "col" }, s.label)));
    const rows = Array.from({ length: n }, (_, i) => h(doc, "tr", {}, h(doc, "th", { scope: "row" }, String(i)), shown.map((s) => h(doc, "td", {}, fmt(s.values[i])))));
    tableHost.append(h(doc, "table", {}, h(doc, "caption", {}, `${title}: values per epoch`), h(doc, "thead", {}, head), h(doc, "tbody", {}, rows)));
  }

  const api = {
    element: figure,
    setVisible(ids) {
      visible = new Set(ids);
      api.refresh();
    },
    setFocus(id) {
      focus = id;
      draw();
    },
    refresh() {
      draw();
      drawTable();
    },
  };
  toggle.addEventListener("click", () => {
    const on = tableHost.hidden;
    tableHost.hidden = !on;
    plot.hidden = on;
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Chart" : "Table";
  });
  api.refresh();
  return api;
}
