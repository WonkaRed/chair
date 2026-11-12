// The five guarantees: a plain claim up front, then the words of SPEC.md with the SPEC section and the tests that prove it, folded.
import { h } from "./dom.js";

export const GUARANTEES = [
  {
    plain: "The rate can never pass 2% a day when printing or 2% of a transfer when burning, or move more than 0.5% at a time.",
    text: "The rate stays between −200 and +200 bps and moves at most 50 bps from one epoch to the next. Both numbers are constants in the code; no call changes them.",
    spec: ["Methods: set_policy", "methods"],
    tests: [["sandbox-tests/tests/policy.rs", "out_of_bounds_rate_is_rejected"], ["sandbox-tests/tests/policy.rs", "too_large_step_is_rejected"]],
  },
  {
    plain: "If the Chair goes quiet, the rate fades to zero by itself.",
    text: "If the chair stops acting, the rate decays 50 bps per epoch to zero and stays there. At zero nothing is minted or burned: the token is an ordinary NEP-141 token with staking.",
    spec: ["The mechanic without the chair", "the-mechanic-without-the-chair"],
    tests: [["sandbox-tests/tests/chair_rules.rs", "a_silent_chair_cannot_stall_the_token_the_rate_decays_to_zero_by_contract_code"]],
  },
  {
    plain: "No admin, no owner: nothing can change the rules, print coins or move anyone's tokens.",
    text: "There is no admin and no owner. The exported methods are a closed list: none sets the chair, changes a parameter, mints, burns, upgrades the code or moves anyone's tokens, and the token account's keys are deleted at deploy.",
    spec: ["No admin, no owner", "no-admin-no-owner"],
    tests: [["sandbox-tests/tests/no_admin.rs", "the_exported_surface_has_no_admin_and_nothing_the_deployer_can_use"], ["sandbox-tests/tests/no_admin.rs", "the_deployers_own_key_is_deleted_so_it_signs_nothing"]],
  },
  {
    plain: "Every coin printed or burned is logged, and the log adds up to the real supply.",
    text: "Every mint and burn is logged with its amount and epoch, and the log adds up to the contract's own ledger: launch + minted − burned = total supply, at all times.",
    spec: ["Events: the public log of every mint and burn", "events"],
    tests: [["sandbox-tests/tests/ledger.rs", "every_mint_and_burn_is_in_the_events_and_adds_up_to_the_ledger_view"]],
  },
  {
    plain: "Holders, not the developers, decide who the Chair is.",
    text: "Holders decide who the chair is: a candidate backed by more than the threshold share of staked tokens, and by more than 5% of the whole supply, replaces the chair at the next epoch boundary. The chair's own key can call set_policy and nothing else.",
    spec: ["Epochs and rollover: impeachment", "epochs-and-rollover"],
    tests: [["sandbox-tests/tests/impeachment.rs", "enough_backing_replaces_the_chair_at_the_next_boundary"], ["sandbox-tests/tests/impeachment.rs", "backing_must_also_exceed_five_percent_of_the_supply_to_seat_a_chair"], ["sandbox-tests/tests/policy.rs", "function_call_key_can_set_policy_but_cannot_transfer"]],
  },
];

export const VERIFY_COMMAND = "cargo test -p sandbox-tests --test no_admin";

export function renderGuarantees(doc, config) {
  const base = `${config.repoUrl}/blob/${config.repoRef}`;
  const link = (href, text) => h(doc, "a", { href, rel: "noopener noreferrer", target: "_blank" }, text);
  const items = GUARANTEES.map((g) =>
    h(doc, "li", {},
      h(doc, "p", { class: "claim" }, g.plain),
      h(doc, "p", { class: "proof" }, "Spec: ", link(`${base}/SPEC.md#${g.spec[1]}`, g.spec[0]), "."),
      h(doc, "details", { class: "fold proof-fold" },
        h(doc, "summary", {}, "The exact guarantee, and its tests"),
        h(doc, "p", { class: "exact" }, g.text),
        h(doc, "p", { class: "proof" }, "Test: ", g.tests.flatMap(([file, name], i) => [i ? " and " : "", link(`${base}/${file}`, name)]), "."),
      ),
    ),
  );
  return h(doc, "ol", { class: "guarantees" }, items);
}
