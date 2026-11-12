import test from "node:test";
import assert from "node:assert/strict";
import { fakeDoc, walk } from "./fakedom.mjs";
import { lineChart } from "../site/js/charts.js";

const flat = (v) => Array.from({ length: 5 }, () => v);
const chart = (series, guides = []) => lineChart(fakeDoc(), { title: "T", caption: "c", series, fmt: (v) => String(v), guides });
const drawn = (api, tag) => [...walk(api.element)].filter((n) => n.tag === tag);

test("lines lying on each other get nested stroke widths, so every colour shows", () => {
  const api = chart([
    { id: "a", label: "A", slot: 1, values: flat(100) },
    { id: "b", label: "B", slot: 2, values: flat(100.01) },
    { id: "c", label: "C", slot: 3, values: flat(100.02) },
    { id: "d", label: "D", slot: 4, values: [100, 98, 96, 94, 92] },
  ]);
  const widths = drawn(api, "polyline").map((l) => l.styles["stroke-width"]);
  assert.deepEqual(widths, ["8px", "5px", undefined, undefined]);
  assert.deepEqual(drawn(api, "circle").map((c) => c.attrs.r), ["7", "5.5", "4", "4"]);
});

test("lines that differ are left at the plain width", () => {
  const api = chart([{ id: "a", label: "A", slot: 1, values: flat(1) }, { id: "b", label: "B", slot: 2, values: flat(9) }]);
  assert.deepEqual(drawn(api, "polyline").map((l) => l.styles["stroke-width"]), [undefined, undefined]);
});

test("a guide's label sits at the left end, away from where lines finish", () => {
  const api = chart([{ id: "a", label: "A", slot: 1, values: flat(100) }], [{ value: 100, label: "launch" }]);
  const label = drawn(api, "text").find((t) => t.textContent === "launch");
  assert.equal(label.attrs["text-anchor"], "start");
});
