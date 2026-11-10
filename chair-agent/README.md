# chair-agent

**Owner lane: agent. Status: stub.** TypeScript. Two chairs that call `set_policy` on the token:
a deterministic rule-based chair that needs no API key, and an LLM chair.

Contract: [`../SPEC.md`](../SPEC.md) ("Methods", "The chair's key"). The agent signs with a
function-call key scoped to `set_policy` and must stay inside the bounds the contract enforces
(`-200..=200`, at most 50 bps per epoch). `make test` here must run offline and without keys.
