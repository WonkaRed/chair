# History

[Back to the README](../README.md)

## The first token

This is the second token. The first, `token.chair-coin-2.testnet`, took its rate per meeting, so a rogue Chair at the ceiling could compound 2% every 90 seconds; I made the rate per day for that reason. Its records stay in [`docs/chair-coin-2/`](chair-coin-2/), and the logs of the agents that chaired it are the `docs/testnet-run-agent-*` files, indexed in [`docs/ai-chair-runs.md`](ai-chair-runs.md). The old token is retired, its agent is stopped, and its only Chair key is held by me and is not used.

## Which chairs have run

Two chairs have run on testnet: the rule-based agent (`chair-agent/`, `rule-v1`: no model, no API key) and the LLM chair driven by `qwen3.8-27b` on my own hardware (labelled `local:qwen3.8-27b` in every log line). Which decisions have saved text, and which are on chain without it, is under ["It runs on NEAR testnet"](the-running-demo.md#it-runs-on-near-testnet) above; the runs are in [`docs/ai-chair-runs.md`](ai-chair-runs.md). The LLM chair has never been run against the Anthropic API, so no Claude model has chaired a run.
