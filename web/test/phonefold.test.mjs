import assert from "node:assert/strict";
import { test } from "node:test";
import { setupPhoneFolds } from "../site/js/phonefold.js";

const rig = (matches) => {
  const folds = [{ open: true }, { open: true }];
  const listeners = [];
  const mq = { matches, addEventListener: (_, fn) => listeners.push(fn) };
  return { folds, mq, listeners, doc: { querySelectorAll: (sel) => (sel === ".phone-fold" ? folds : []) } };
};

test("on a phone the folds start shut, and open again when the screen grows", () => {
  const { folds, mq, listeners, doc } = rig(true);
  setupPhoneFolds(doc, mq);
  assert.deepEqual(folds.map((f) => f.open), [false, false]);
  mq.matches = false;
  listeners.forEach((fn) => fn());
  assert.deepEqual(folds.map((f) => f.open), [true, true]);
});

test("on a wide screen nothing is shut, and a phone-sized resize shuts them", () => {
  const { folds, mq, listeners, doc } = rig(false);
  setupPhoneFolds(doc, mq);
  assert.deepEqual(folds.map((f) => f.open), [true, true]);
  mq.matches = true;
  listeners.forEach((fn) => fn());
  assert.deepEqual(folds.map((f) => f.open), [false, false]);
});

test("without matchMedia the folds are left open", () => {
  const { folds, doc } = rig(true);
  setupPhoneFolds(doc, undefined);
  assert.deepEqual(folds.map((f) => f.open), [true, true]);
});
