// The scripted run, the same story `make demo` tells against a local sandbox (sandbox-tests/examples/demo.rs), on the
// real chain: the founding chair eases to +190 bps and is refused four ways, goes silent so the rate decays, a mint
// epoch pays a staker, a burn epoch destroys part of a transfer, and the stakers vote a new chair in. Epochs are
// counted from `k = 0`, the first full epoch after the holders are set up (`record.scenarioBaseEpoch`).
//
// Every step is recorded with its transaction hash, so a rerun resumes. A step that cannot happen in its epoch
// (the run was too slow or was stopped for a while) stops the run with an error rather than quietly reshaping the story.

import { actions } from "near-api-js";
import { LAUNCH, NEAR, TOKEN, fmtNear, sha256Hex } from "./deploy.ts";
import type { TestnetAccount } from "./guard.ts";
import { eventsNamed } from "./outcome.ts";
import { recordedStep } from "./record.ts";
import type { Expect, Run } from "./run.ts";
import { TokenViews } from "./views.ts";

const GAS = 100_000_000_000_000n;
const ONE_YOCTO = 1n;
const POLL_MS = 3_000;
/** Whole tokens moved or staked by the script. */
const GRANT = 100_000n * TOKEN;
const ALICE_STAKE = 300_000n * TOKEN;
const BOB_STAKE = 100_000n * TOKEN;
const BURN_TRANSFER = 10_000n * TOKEN;
const FIRST_STAKE_DEPOSIT = NEAR / 100n;
export const PERSONA = "The AI chair: aims at half the supply staked, moves one contract step per epoch, and explains each rate in writing.";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

export async function runScenario(run: Run): Promise<void> {
  const { record, say } = run;
  const a = record.accounts;
  const token = a.token;
  const views = new TokenViews(run.rpc, token);
  const call = (method: string, args: Record<string, unknown>, deposit = 0n) => [actions.functionCall(method, args, GAS, deposit)];
  const holder = (id: string, signer: TestnetAccount, method: string, args: Record<string, unknown>, deposit: bigint, what: string, proves: string, expect: Expect = { kind: "success" }) =>
    run.step({ id, signer, receiver: token, actions: call(method, args, deposit), what, proves, expect });

  say(`\n$CHAIR on NEAR testnet: ${token}, ${record.launch.epochMs / 1000}s epochs, chair ${a.chair} (function-call key, set_policy only)`);

  // --- setup: holders. At rate 0 nothing mints or burns, so it does not matter which epoch this happens in.
  say("\nsetup: two holders register, receive tokens from the owner, and stake");
  const storageMin = await views.storageMin();
  for (const who of ["bob", "carol"] as const) {
    await holder(`setup-register-${who}`, a[who], "storage_deposit", { account_id: null, registration_only: true }, storageMin, `${who} registers with the token (storage_deposit)`, "NEP-145 registration: the holder can now receive tokens");
    await holder(`setup-grant-${who}`, a.alice, "ft_transfer", { receiver_id: a[who], amount: GRANT.toString() }, ONE_YOCTO, `owner ${a.alice} sends ${GRANT / TOKEN} $CHAIR to ${who}`, "an ordinary NEP-141 transfer at rate 0 moves the whole amount (no burn)");
  }
  await holder("setup-stake-alice", a.alice, "stake", { amount: ALICE_STAKE.toString() }, FIRST_STAKE_DEPOSIT, `alice stakes ${ALICE_STAKE / TOKEN} $CHAIR`, "stakers earn the epoch mints; staked tokens also carry the vote");
  await holder("setup-stake-bob", a.bob, "stake", { amount: BOB_STAKE.toString() }, FIRST_STAKE_DEPOSIT, `bob stakes ${BOB_STAKE / TOKEN} $CHAIR`, "a second staker: carol stays liquid");

  let base = record.scenarioBaseEpoch;
  if (base === null) {
    base = (await views.policy()).epoch + 1;
    record.scenarioBaseEpoch = base;
    run.save();
  }
  const first = base;
  const epochOf = (k: number): number => first + k;

  /** True when an earlier run already did something in epoch `k`: a resumed run passes through it instead of waiting for it. */
  const begun = (k: number): boolean => record.transactions.some((t) => t.step.startsWith(`e${k}-`));

  /** Waits for epoch `k` to begin; stops the run if it is already over and nothing was done in it. */
  const atEpoch = async (k: number, title: string): Promise<void> => {
    for (;;) {
      const now = (await views.policy()).epoch;
      if (now === epochOf(k)) break;
      if (now > epochOf(k)) {
        if (begun(k)) return say(`\nepoch ${k} (chain epoch ${epochOf(k)}): done in an earlier run`);
        throw new Error(`epoch ${k} (chain epoch ${epochOf(k)}) is already over (chain epoch ${now}): the run missed its slot; start a new deployment`);
      }
      await sleep(POLL_MS);
    }
    say(`\nepoch ${k} (chain epoch ${epochOf(k)})${title === "" ? "" : `: ${title}`}`);
  };

  /** An epoch-bound step that is not yet recorded must be sent in its own epoch: a late send would mean something else. */
  const inEpoch = async (k: number, id: string): Promise<void> => {
    if (recordedStep(record, id) !== undefined) return;
    const now = (await views.policy()).epoch;
    if (now !== epochOf(k)) throw new Error(`${id}: chain epoch is ${now}, the step belongs to ${epochOf(k)}; start a new deployment`);
  };

  const decision = async (k: number, rate: number, why: string, id = `e${k}-set-${rate}`) => {
    await inEpoch(k, id);
    const text = `Scripted founding-chair decision for chain epoch ${epochOf(k)}: ${signed(rate)} bps. ${why}`;
    const out = await run.step({
      id,
      signer: a.chair,
      receiver: token,
      actions: call("set_policy", { rate_bps: rate, reasoning_hash: sha256Hex(text) }),
      what: `chair sets ${signed(rate)} bps for epoch ${epochOf(k)}`,
      proves: why,
      expect: { kind: "success" },
      note: text,
    });
    const set = out === null ? [] : eventsNamed(out, "policy_set");
    if (out !== null && (set.length !== 1 || (set[0]?.data as { epoch?: number }).epoch !== epochOf(k))) throw new Error(`${id}: the decision did not land in chain epoch ${epochOf(k)}`);
    return out;
  };

  const refusedDecision = async (k: number, id: string, signer: TestnetAccount, rate: number, what: string, panic: string) => {
    await inEpoch(k, `e${k}-${id}`);
    return run.step({
      id: `e${k}-${id}`,
      signer,
      receiver: token,
      actions: call("set_policy", { rate_bps: rate, reasoning_hash: sha256Hex(`${id} ${signed(rate)}`) }),
      what,
      proves: `the contract refuses it: "${panic}"`,
      expect: { kind: "panic", text: panic },
    });
  };

  const ledgerHolds = async (): Promise<void> => {
    const s = await views.supply();
    if (s.total !== s.launch + s.minted - s.burned) throw new Error("supply identity broken: total != launch + minted - burned");
    say(`  ledger: supply ${s.total} = launch ${s.launch} + minted ${s.minted} - burned ${s.burned}`);
  };

  // --- the chair eases
  await atEpoch(0, "the founding chair eases, 50 bps at most per epoch");
  await decision(0, 40, "First step up from 0, inside the 50 bps step bound.");
  await atEpoch(1, "");
  await decision(1, 90, "Another 50 bps step up.");
  await atEpoch(2, "");
  await decision(2, 140, "Another 50 bps step up.");
  await atEpoch(3, "");
  await decision(3, 190, "Another 50 bps step up, 10 below the +200 ceiling.");
  say("epoch 3: the chair has already decided; a second try, and an impostor");
  await refusedDecision(3, "second-decision", a.chair, 150, "chair sets +150 bps a second time in the same epoch", "policy already set this epoch");
  await refusedDecision(3, "impostor", a.carol, 0, `a non-chair account (${a.carol}) sets 0 bps`, "only the chair may set policy");

  // --- the chair tries to break its bounds
  await atEpoch(4, "the chair tries to break its bounds");
  await refusedDecision(4, "above-bound", a.chair, 201, "chair sets +201 bps", "rate_bps out of bounds");
  await refusedDecision(4, "step-too-large", a.chair, 100, "chair sets +100 bps, a 90 bps jump from +190", "rate step too large");
  await run.step({
    id: "e4-chair-key-ft-transfer",
    signer: a.chair,
    receiver: token,
    actions: call("ft_transfer", { receiver_id: a.carol, amount: "1" }),
    what: "ft_transfer signed with the chair's function-call key (no deposit: a function-call key may not attach one at all)",
    proves: "the protocol refuses it before the contract runs (MethodNameMismatch): the key can call set_policy and nothing else; no transaction is included",
    expect: { kind: "protocol", name: "MethodNameMismatch" },
  });

  // --- silence: the rate decays by contract code
  say("\nthe chair goes silent for epochs 4 and 5");
  await atEpoch(6, "the rate decayed 50 bps per missed epoch");
  const decayed = (await views.policy()).rateBps;
  if (decayed !== 90) throw new Error(`expected the rate to decay from +190 to +90, the chain says ${decayed}`);
  say(`  get_policy.rate_bps = ${signed(decayed)} (190 -> 140 -> 90), with no transaction sent`);
  const back = await decision(6, 140, "Back after two silent epochs: the step bound is measured from the decayed rate, +90.");
  if (back !== null) {
    const decays = eventsNamed(back, "rate_decayed");
    if (decays.length !== 2) throw new Error(`expected 2 rate_decayed events for the 2 silent epochs, got ${decays.length}`);
    say(`  the same transaction logged ${decays.length} rate_decayed events (one per missed epoch) and the policy_set`);
  }

  // --- a mint epoch pays a staker
  await atEpoch(7, "a mint epoch: the +140 bps at the last boundary paid the stakers");
  const pending = (await views.staking(a.alice)).pendingReward;
  const supply = await views.supply();
  if (pending === 0n || supply.minted === 0n) throw new Error("no reward after epochs at a positive rate");
  say(`  alice's pending reward ${pending} of ${supply.minted} base units minted so far`);
  const balanceBefore = await views.balance(a.alice);
  const claim = await holder("e7-claim", a.alice, "claim", {}, ONE_YOCTO, "alice claims her staking reward", "the epoch mints are paid from the reward pool to stakers");
  if (claim?.returned != null) {
    const paid = BigInt(JSON.parse(claim.returned) as string);
    if (paid === 0n || (await views.balance(a.alice)) !== balanceBefore + paid) throw new Error("claim did not credit the amount it returned");
    say(`  claimed ${paid} base units into alice's liquid balance`);
  }
  await decision(7, 90, "Ease off: 50 bps down from +140.");
  await ledgerHolds();

  // --- a burn epoch destroys part of a transfer
  await atEpoch(8, "");
  await decision(8, 40, "Ease off: 50 bps down from +90.");
  await atEpoch(9, "a burn epoch: the chair tightens to -10 bps, a transfer burns its share");
  await decision(9, -10, "Tighten: 50 bps down from +40, into negative territory.");
  const carolBefore = await views.balance(a.carol);
  const supplyBefore = (await views.supply()).total;
  const transfer = await holder("e9-burn-transfer", a.alice, "ft_transfer", { receiver_id: a.carol, amount: BURN_TRANSFER.toString() }, ONE_YOCTO, `alice sends ${BURN_TRANSFER / TOKEN} $CHAIR to carol at -10 bps`, "a negative rate burns 0.1% of every transfer: carol receives less than alice spent and the supply falls by the burn");
  if (transfer !== null) {
    const burned = (BURN_TRANSFER * 10n) / 10_000n;
    const carolGot = (await views.balance(a.carol)) - carolBefore;
    const supplyAfter = (await views.supply()).total;
    if (carolGot !== BURN_TRANSFER - burned || supplyBefore - supplyAfter !== burned || eventsNamed(transfer, "transfer_burned").length !== 1) {
      throw new Error("the transfer did not burn exactly 0.1%");
    }
    say(`  ${BURN_TRANSFER} sent, ${burned} burned, carol received ${carolGot}`);
  }
  await ledgerHolds();

  // --- impeachment
  say("\nimpeachment: alice nominates the challenger; alice and bob back it with their whole stake");
  const persona = sha256Hex(PERSONA);
  await run.step({
    id: "e9-nominate",
    signer: a.alice,
    receiver: token,
    actions: call("nominate", { candidate: a.challenger, persona_hash: persona }, LAUNCH.nominateBond),
    what: `alice nominates ${a.challenger}, attaching the ${fmtNear(LAUNCH.nominateBond)} NEAR bond`,
    proves: "anyone can nominate a chair; the bond is escrowed and returned when the nomination ends",
    expect: { kind: "success" },
    note: `persona_hash ${persona} commits to: ${PERSONA}`,
  });
  for (const who of ["alice", "bob"] as const) {
    await holder(`e9-back-${who}`, a[who], "back", { candidate: a.challenger }, ONE_YOCTO, `${who} backs ${a.challenger} with the whole stake`, "stake is the vote: backing counts at the next epoch boundary");
  }
  const candidates = await views.candidates();
  const backing = candidates.find((c) => c.candidate === a.challenger)?.backing ?? 0n;
  const staked = (await views.supply()).staked;
  if (candidates.length !== 1 || backing * 10_000n <= BigInt(LAUNCH.impeachThresholdBps) * staked) throw new Error("the challenger does not have enough backing");
  say(`  get_candidates: ${a.challenger} backed by ${backing} of ${staked} staked (needs more than ${LAUNCH.impeachThresholdBps / 100}%)`);
  if ((await views.policy()).chair !== a.chair) throw new Error("the chair changed before the boundary");
  say(`  the chair is still ${a.chair} until the boundary`);

  await atEpoch(10, "the stake vote seats the challenger");
  const policy = await views.policy();
  if (policy.chair !== a.challenger) throw new Error(`expected ${a.challenger} to take the chair, got ${policy.chair}`);
  say(`  get_policy.chair = ${policy.chair}, streak ${policy.streak}`);
  await refusedDecision(10, "impeached-chair", a.chair, 0, "the impeached chair sets 0 bps", "only the chair may set policy");
  await ledgerHolds();
  say(`\nscripted run complete. ${a.challenger} is the chair; the chair agent takes over from epoch ${epochOf(10)}.`);
}
