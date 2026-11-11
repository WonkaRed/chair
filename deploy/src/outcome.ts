// What a transaction did, read from the node's final outcome: success or the contract's panic text, the value
// the method returned, and the NEP-297 events it logged (SPEC.md "Events").

export interface LoggedEvent {
  readonly standard: string;
  readonly event: string;
  readonly data: unknown;
}

export interface TxOutcome {
  readonly hash: string;
  /** The contract's panic text (or the runtime's failure, abbreviated); null when the transaction executed. */
  readonly failure: string | null;
  /** The decoded return value of the call, when it returned one. */
  readonly returned: string | null;
  readonly events: readonly LoggedEvent[];
}

const EVENT_PREFIX = "EVENT_JSON:";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describeFailure(failure: unknown): string {
  const text = JSON.stringify(failure);
  const panic = /Smart contract panicked: ([^"\\]{1,300})/.exec(text);
  return (panic?.[1] ?? text).slice(0, 300);
}

export function parseOutcome(raw: unknown): TxOutcome {
  if (!isObject(raw) || !isObject(raw["transaction"]) || typeof raw["transaction"]["hash"] !== "string" || !isObject(raw["status"])) {
    throw new Error("transaction outcome has an unexpected shape");
  }
  const status = raw["status"];
  const failure = status["Failure"] === undefined ? null : describeFailure(status["Failure"]);
  const value = status["SuccessValue"];
  const returned = typeof value === "string" && value !== "" ? Buffer.from(value, "base64").toString("utf8") : null;
  const receipts = Array.isArray(raw["receipts_outcome"]) ? raw["receipts_outcome"] : [];
  const events: LoggedEvent[] = [];
  for (const receipt of receipts) {
    const logs = isObject(receipt) && isObject(receipt["outcome"]) ? receipt["outcome"]["logs"] : undefined;
    if (!Array.isArray(logs)) continue;
    for (const line of logs) {
      if (typeof line !== "string" || !line.startsWith(EVENT_PREFIX)) continue;
      const event: unknown = JSON.parse(line.slice(EVENT_PREFIX.length));
      if (isObject(event) && typeof event["standard"] === "string" && typeof event["event"] === "string") {
        events.push({ standard: event["standard"], event: event["event"], data: event["data"] });
      }
    }
  }
  return { hash: raw["transaction"]["hash"], failure, returned, events };
}

/** The events of one standard (`chair` by default) with one name, in log order. */
export function eventsNamed(outcome: TxOutcome, name: string, standard = "chair"): LoggedEvent[] {
  return outcome.events.filter((e) => e.standard === standard && e.event === name);
}
