import assert from "node:assert/strict";
import { test } from "node:test";
import { eventsNamed, parseOutcome } from "../src/outcome.ts";

const event = (standard: string, name: string, data: unknown): string => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event: name, data })}`;
const outcome = (status: unknown, logs: string[][]) => ({
  transaction: { hash: "H1" },
  status,
  receipts_outcome: logs.map((l) => ({ outcome: { logs: l } })),
});

test("a successful call: its hash, return value and events in log order", () => {
  const out = parseOutcome(outcome({ SuccessValue: Buffer.from('"42"').toString("base64") }, [[event("chair", "rate_decayed", { epoch: 4 }), "plain log", event("chair", "policy_set", { epoch: 6 })], [event("nep141", "ft_mint", [])]]));
  assert.equal(out.hash, "H1");
  assert.equal(out.failure, null);
  assert.equal(out.returned, '"42"');
  assert.deepEqual(out.events.map((e) => `${e.standard}:${e.event}`), ["chair:rate_decayed", "chair:policy_set", "nep141:ft_mint"]);
  assert.equal(eventsNamed(out, "policy_set").length, 1);
  assert.equal(eventsNamed(out, "ft_mint").length, 0);
  assert.equal(eventsNamed(out, "ft_mint", "nep141").length, 1);
});

test("an empty return value is null", () => {
  assert.equal(parseOutcome(outcome({ SuccessValue: "" }, [])).returned, null);
});

test("a contract panic is reduced to its message", () => {
  const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: only the chair may set policy" } } } };
  assert.equal(parseOutcome(outcome({ Failure: failure }, [])).failure, "only the chair may set policy");
});

test("a failure that is not a panic is kept, shortened", () => {
  const out = parseOutcome(outcome({ Failure: { ActionError: { kind: { LackBalanceForState: { x: "y".repeat(400) } } } } }, []));
  assert.match(out.failure ?? "", /LackBalanceForState/);
  assert.ok((out.failure ?? "").length <= 300);
});

test("a malformed outcome is an error, not a guess", () => {
  assert.throws(() => parseOutcome({}), /unexpected shape/);
  assert.throws(() => parseOutcome({ transaction: {}, status: {} }), /unexpected shape/);
});
