//! Nomination, backing and impeachment of the chair by stake vote, and the attacks on them,
//! against the real wasm. The launch threshold is 30% of staked tokens and the bond is 1 NEAR.

use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use sandbox_tests::{NOMINATE_BOND, TOKEN, ensure_success, events, failure_text, launch};
use serde_json::{Value, json};

/// Long enough that a scenario's transactions never straddle a boundary by accident.
const EPOCH_MS: u64 = 120_000;

fn u(value: &str) -> u128 {
    value.parse().unwrap()
}

fn named<'a>(events: &'a [Value], event: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["standard"] == "chair" && e["event"] == event)
        .collect()
}

fn near(n: f64) -> u128 {
    (n * 1e24) as u128
}

/// Total backing across all live candidates; it can never exceed total staked.
async fn total_backing(t: &sandbox_tests::Chair) -> anyhow::Result<u128> {
    Ok(t.candidates().await?.iter().map(|c| u(&c.backing)).sum())
}

#[tokio::test]
async fn nominate_escrows_the_bond_and_refunds_the_excess() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 0).await?;
    let dan = t.user("dan", 0).await?;

    let (contract_before, bob_before) = (
        t.near_balance(t.token.as_account()).await?,
        t.near_balance(&bob).await?,
    );
    let result = t.nominate(&bob, &dan, 3 * NOMINATE_BOND).await?;
    ensure_success(&result)?;
    let held = t.near_balance(t.token.as_account()).await? - contract_before;
    let spent = bob_before - t.near_balance(&bob).await?;
    // Only the bond stays (plus the contract's small share of the gas); the other 2 NEAR came back.
    assert!(
        held >= NOMINATE_BOND && held < NOMINATE_BOND + near(0.01),
        "contract kept {held}"
    );
    assert!(
        spent >= NOMINATE_BOND && spent < NOMINATE_BOND + near(0.01),
        "bob spent {spent}"
    );

    let list = t.candidates().await?;
    assert_eq!(list.len(), 1);
    assert_eq!(
        (
            list[0].candidate.as_str(),
            list[0].nominator.as_str(),
            list[0].backing.as_str()
        ),
        (dan.id().as_str(), bob.id().as_str(), "0")
    );
    assert_eq!(
        (list[0].persona_hash.clone(), u(&list[0].bond)),
        ("cd".repeat(32), NOMINATE_BOND)
    );
    let logged = events(&result);
    assert_eq!(
        named(&logged, "nominated")[0]["data"],
        json!({ "candidate": dan.id(), "nominator": bob.id(),
                "persona_hash": "cd".repeat(32), "bond": NOMINATE_BOND.to_string() })
    );
    Ok(())
}

#[tokio::test]
async fn nominations_are_refused_unless_valid() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 0).await?;
    let dan = t.user("dan", 0).await?;
    ensure_success(&t.nominate(&bob, &dan, NOMINATE_BOND).await?)?;
    let with =
        |candidate: Value, hash: String| json!({ "candidate": candidate, "persona_hash": hash });

    let cases = [
        (
            "no bond",
            t.nominate(&bob, &t.alice, 0).await?,
            "attach at least",
        ),
        (
            "a bond one yocto short",
            t.nominate(&bob, &t.alice, NOMINATE_BOND - 1).await?,
            "attach at least",
        ),
        (
            "the sitting chair",
            t.nominate(&bob, &chair, NOMINATE_BOND).await?,
            "the sitting chair cannot be nominated",
        ),
        (
            "a candidate already nominated",
            t.nominate(&bob, &dan, NOMINATE_BOND).await?,
            "candidate is already nominated",
        ),
        (
            "an empty persona hash",
            t.call(
                &bob,
                "nominate",
                with(json!(t.alice.id()), String::new()),
                NOMINATE_BOND,
            )
            .await?,
            "persona_hash must be 1..=128 bytes",
        ),
        (
            "a 129-byte persona hash",
            t.call(
                &bob,
                "nominate",
                with(json!(t.alice.id()), "x".repeat(129)),
                NOMINATE_BOND,
            )
            .await?,
            "persona_hash must be 1..=128 bytes",
        ),
    ];
    for (what, result, expected) in cases {
        assert!(result.is_failure(), "{what} was accepted");
        assert!(
            failure_text(&result).contains(expected),
            "{what}: {}",
            failure_text(&result)
        );
        assert!(
            events(&result).is_empty(),
            "{what}: a refused call must not log events"
        );
    }
    assert_eq!(
        t.candidates().await?.len(),
        1,
        "refused nominations left no trace"
    );

    // 128 bytes is the largest persona hash allowed.
    let longest = t
        .call(
            &bob,
            "nominate",
            with(json!(t.alice.id()), "x".repeat(128)),
            NOMINATE_BOND,
        )
        .await?;
    ensure_success(&longest)?;
    Ok(())
}

#[tokio::test]
async fn ten_one_yocto_nominations_cannot_freeze_the_list_against_a_real_staker()
-> anyhow::Result<()> {
    // The audit's probe p2: ten accounts stake 1 yocto each and nominate. The nominator's stake backs the
    // nomination at once, so each holds a slot with backing 1, and a full list gives a slot only to a
    // nominator with more stake than the least-backed nomination has backing.
    let t = launch(600_000).await?;
    let nominate = |who: &near_workspaces::Account, name: &str| {
        let t = &t;
        let (who, name) = (who.clone(), name.to_string());
        async move {
            t.call(
                &who,
                "nominate",
                json!({ "candidate": name, "persona_hash": "cd".repeat(32) }),
                NOMINATE_BOND,
            )
            .await
        }
    };

    let mut spammers = Vec::new();
    for i in 0..10 {
        let spammer = t.user(&format!("spam{i}"), 1).await?;
        ensure_success(&t.stake(&spammer, 1).await?)?;
        ensure_success(&nominate(&spammer, &format!("cand{i}.test")).await?)?;
        spammers.push(spammer);
    }
    let list = t.candidates().await?;
    assert_eq!(list.len(), 10);
    assert!(
        list.iter().all(|c| c.backing == "1"),
        "each nominator's stake backs its own nomination at once"
    );

    // A latecomer with the same 1 yocto, or with no stake at all, cannot take a slot.
    let late = t.user("late", 1).await?;
    let nobody = t.user("nobody", 0).await?;
    ensure_success(&t.stake(&late, 1).await?)?;
    for (who, what) in [(&late, "an equal stake"), (&nobody, "no stake")] {
        let refused = nominate(who, "cand10.test").await?;
        assert!(
            failure_text(&refused).contains("candidate list is full: stake more than 1 yoctoCHAIR"),
            "{what}: {}",
            failure_text(&refused)
        );
    }
    assert_eq!(t.candidates().await?.len(), 10);

    // An honest holder with 100 tokens takes the oldest of the least-backed slots; its bond goes back.
    let hank = t.user("hank", 100).await?;
    ensure_success(&t.stake(&hank, 100 * TOKEN).await?)?;
    let result = nominate(&hank, "hero.test").await?;
    ensure_success(&result)?;
    let list = t.candidates().await?;
    assert_eq!(list.len(), 10);
    assert_eq!(
        list[0].candidate, "cand1.test",
        "cand0 was the oldest of the least backed"
    );
    assert_eq!(
        (list[9].candidate.as_str(), u(&list[9].backing)),
        ("hero.test", 100 * TOKEN),
        "the nomination holds its slot with its nominator's whole stake"
    );
    let logged = events(&result);
    assert_eq!(
        named(&logged, "nomination_withdrawn")[0]["data"],
        json!({ "candidate": "cand0.test", "nominator": spammers[0].id(),
                "bond": NOMINATE_BOND.to_string() })
    );
    assert_eq!(named(&logged, "nominated").len(), 1);
    assert_eq!(
        named(&logged, "backed")[0]["data"]["candidate"],
        "hero.test"
    );

    // A spammer with more stake than another spammer evicts that one, never the honest nomination:
    // it would need more stake than the least-backed slot, and the honest one is the most backed.
    let mid = t.user("mid", 50).await?;
    ensure_success(&t.stake(&mid, 50 * TOKEN).await?)?;
    ensure_success(&nominate(&mid, "cand11.test").await?)?;
    let names: Vec<_> = t
        .candidates()
        .await?
        .into_iter()
        .map(|c| c.candidate)
        .collect();
    assert!(names.contains(&"hero.test".to_string()) && !names.contains(&"cand1.test".to_string()));
    let again = nominate(&spammers[5], "cand12.test").await?;
    assert!(
        failure_text(&again).contains("candidate list is full"),
        "{}",
        failure_text(&again)
    );

    // And the honest holder's stake does seat its candidate: 100 of the 150 staked tokens, 10% of supply.
    t.advance_to_epoch(1).await?;
    assert_eq!(t.policy().await?.chair, "hero.test");
    Ok(())
}

#[tokio::test]
async fn backing_follows_the_stake_and_can_be_moved_and_removed() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 200).await?;
    let carol = t.user("carol", 0).await?;
    let (dan, erin) = (t.user("dan", 0).await?, t.user("erin", 0).await?);
    ensure_success(&t.stake(&t.alice, 600 * TOKEN).await?)?;
    ensure_success(&t.nominate(&carol, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.nominate(&carol, &erin, NOMINATE_BOND).await?)?;

    // Refusals first: no stake, unknown candidate, not backing anyone.
    let nothing_staked = t.back(&bob, &dan).await?;
    assert!(
        failure_text(&nothing_staked).contains("stake first"),
        "{}",
        failure_text(&nothing_staked)
    );
    ensure_success(&t.stake(&bob, 100 * TOKEN).await?)?;
    let unknown = t.back(&bob, &carol).await?;
    assert!(
        failure_text(&unknown).contains("no such candidate"),
        "{}",
        failure_text(&unknown)
    );
    // Vote-moving calls need a full-access key: 1 yoctoNEAR, like every call that matters.
    for (method, args) in [
        ("back", json!({ "candidate": dan.id() })),
        ("unback", json!({})),
    ] {
        let bare = t.call(&bob, method, args, 0).await?;
        assert!(
            failure_text(&bare).contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{method}: {}",
            failure_text(&bare)
        );
    }
    let unback = t.call(&bob, "unback", json!({}), 1).await?;
    assert!(
        failure_text(&unback).contains("not backing anyone"),
        "{}",
        failure_text(&unback)
    );

    let result = t.back(&bob, &dan).await?;
    ensure_success(&result)?;
    assert_eq!(
        named(&events(&result), "backed")[0]["data"],
        json!({ "account_id": bob.id(), "candidate": dan.id(), "amount": (100 * TOKEN).to_string() })
    );
    assert_eq!(
        t.staking(&bob).await?.backing.as_deref(),
        Some(dan.id().as_str())
    );
    assert_eq!(u(&t.candidates().await?[0].backing), 100 * TOKEN);

    // Backing the same candidate again does nothing; backing another moves the whole stake.
    let again = t.back(&bob, &dan).await?;
    ensure_success(&again)?;
    assert!(named(&events(&again), "backed").is_empty());
    let moved = t.back(&bob, &erin).await?;
    ensure_success(&moved)?;
    let logged = events(&moved);
    assert_eq!(
        named(&logged, "unbacked")[0]["data"]["candidate"],
        dan.id().to_string()
    );
    assert_eq!(
        named(&logged, "backed")[0]["data"]["candidate"],
        erin.id().to_string()
    );
    let list = t.candidates().await?;
    assert_eq!((u(&list[0].backing), u(&list[1].backing)), (0, 100 * TOKEN));

    // More stake raises the backing; less lowers it, at once, from the unlock epoch.
    ensure_success(
        &t.call(
            &bob,
            "stake",
            json!({ "amount": (20 * TOKEN).to_string() }),
            1,
        )
        .await?,
    )?;
    assert_eq!(u(&t.candidates().await?[1].backing), 120 * TOKEN);
    t.advance_to_epoch(2).await?;
    ensure_success(&t.unstake(&bob, 50 * TOKEN).await?)?;
    assert_eq!(u(&t.candidates().await?[1].backing), 70 * TOKEN);
    assert!(total_backing(&t).await? <= u(&t.pool().await?.total_staked));

    ensure_success(&t.call(&bob, "unback", json!({}), 1).await?)?;
    assert_eq!(total_backing(&t).await?, 0);
    assert_eq!(t.staking(&bob).await?.backing, None);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn only_the_nominator_can_withdraw_and_gets_the_bond_back() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let (bob, carol) = (t.user("bob", 100).await?, t.user("carol", 0).await?);
    let dan = t.user("dan", 0).await?;
    ensure_success(&t.stake(&bob, 100 * TOKEN).await?)?;
    ensure_success(&t.stake(&t.alice, 600 * TOKEN).await?)?;
    ensure_success(&t.nominate(&carol, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &dan).await?)?;

    let args = json!({ "candidate": dan.id() });
    let cases = [
        (
            "a stranger",
            t.call(&bob, "withdraw_nomination", args.clone(), 1).await?,
            "only the nominator may withdraw",
        ),
        (
            "no deposit",
            t.call(&carol, "withdraw_nomination", args.clone(), 0)
                .await?,
            "Requires attached deposit of exactly 1 yoctoNEAR",
        ),
        (
            "an unknown candidate",
            t.call(
                &carol,
                "withdraw_nomination",
                json!({ "candidate": bob.id() }),
                1,
            )
            .await?,
            "no such candidate",
        ),
    ];
    for (what, result, expected) in cases {
        assert!(result.is_failure(), "{what} was accepted");
        assert!(
            failure_text(&result).contains(expected),
            "{what}: {}",
            failure_text(&result)
        );
    }
    assert_eq!(t.candidates().await?.len(), 1);

    // The nominator herself is refused while bob backs the candidate; once bob unbacks she may withdraw.
    let backed = t
        .call(&carol, "withdraw_nomination", args.clone(), 1)
        .await?;
    assert!(backed.is_failure(), "withdrawn from under its backer");
    assert!(
        failure_text(&backed).contains(
            "other accounts back this candidate: it can be withdrawn once their backing is gone"
        ),
        "{}",
        failure_text(&backed)
    );
    assert_eq!(u(&t.candidates().await?[0].backing), 100 * TOKEN);
    ensure_success(&t.call(&bob, "unback", json!({}), 1).await?)?;

    let before = t.near_balance(&carol).await?;
    let result = t.call(&carol, "withdraw_nomination", args, 1).await?;
    ensure_success(&result)?;
    let returned = t.near_balance(&carol).await? + near(0.01) - before;
    assert!(
        returned >= NOMINATE_BOND,
        "the bond came back: net {returned}"
    );
    assert!(t.candidates().await?.is_empty());
    assert_eq!(
        named(&events(&result), "nomination_withdrawn")[0]["data"],
        json!({ "candidate": dan.id(), "nominator": carol.id(), "bond": NOMINATE_BOND.to_string() })
    );

    // Bob has no backing left. A fresh nomination of the same account starts at zero and bob's old
    // backing does not leak into it, nor underflow it when bob unstakes.
    assert_eq!(t.staking(&bob).await?.backing, None);
    ensure_success(&t.nominate(&carol, &dan, NOMINATE_BOND).await?)?;
    assert_eq!(u(&t.candidates().await?[0].backing), 0);
    t.advance_to_epoch(2).await?;
    ensure_success(&t.unstake(&bob, 100 * TOKEN).await?)?;
    assert_eq!(u(&t.candidates().await?[0].backing), 0);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn a_nominator_cannot_wipe_its_backers_at_the_last_block_by_withdrawing_and_renominating()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let (bob, mallory) = (t.user("bob", 210).await?, t.user("mallory", 0).await?);
    let x = t.user("x", 0).await?;
    ensure_success(&t.stake(&bob, 200 * TOKEN).await?)?;
    ensure_success(&t.nominate(&mallory, &x, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &x).await?)?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );

    // One batch, as a script would send it in the last block before the boundary: withdraw, then
    // nominate the same account again under a new id with no backers. The first call fails, so none of it lands.
    let batch = mallory
        .batch(t.token.id())
        .call(
            Function::new("withdraw_nomination")
                .args_json(json!({ "candidate": x.id() }))
                .deposit(NearToken::from_yoctonear(1))
                .gas(Gas::from_tgas(100)),
        )
        .call(
            Function::new("nominate")
                .args_json(json!({ "candidate": x.id(), "persona_hash": "cd".repeat(32) }))
                .deposit(NearToken::from_yoctonear(NOMINATE_BOND))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?;
    assert!(
        batch.is_failure(),
        "the withdraw-and-renominate batch landed"
    );
    assert!(
        failure_text(&batch).contains("other accounts back this candidate"),
        "{}",
        failure_text(&batch)
    );
    let list = t.candidates().await?;
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].nominator.as_str(), u(&list[0].backing)),
        (mallory.id().as_str(), 200 * TOKEN)
    );
    assert_eq!(
        t.staking(&bob).await?.backing,
        Some(x.id().to_string()),
        "bob still backs x"
    );

    // The boundary seats the backed candidate, and mallory's bond comes back with the impeachment.
    let mallory_before = t.near_balance(&mallory).await?;
    t.advance_to_epoch(1).await?;
    assert_eq!(t.policy().await?.chair, x.id().to_string());
    assert!(t.candidates().await?.is_empty());
    let result = t.set_policy(&x, 10).await?;
    ensure_success(&result)?;
    assert_eq!(
        t.near_balance(&mallory).await? - mallory_before,
        NOMINATE_BOND
    );
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn enough_backing_replaces_the_chair_at_the_next_boundary() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let (bob, carol) = (t.user("bob", 210).await?, t.user("carol", 100).await?);
    let (dan, nominator) = (t.user("dan", 0).await?, t.user("nominator", 0).await?);
    ensure_success(&t.stake(&bob, 200 * TOKEN).await?)?;
    ensure_success(&t.stake(&carol, 100 * TOKEN).await?)?;
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &dan).await?)?;
    // The sitting chair decides in the same epoch it is voted out of; that decision stands.
    ensure_success(&t.set_policy(&chair, 40).await?)?;
    let supply = t.total_supply().await?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );
    assert_eq!(
        t.policy().await?.chair,
        chair.id().to_string(),
        "nothing changes mid-epoch"
    );

    // 200 of 300 staked is 66%, over the 30% threshold. The boundary decides, not the call that backed.
    let nominator_before = t.near_balance(&nominator).await?;
    t.advance_to_epoch(1).await?;
    let view = t.policy().await?;
    assert_eq!(
        (view.chair.as_str(), view.streak, view.rate_bps),
        (dan.id().as_str(), 0, 40)
    );
    assert!(
        t.candidates().await?.is_empty(),
        "the view already shows the cleared list"
    );
    assert_eq!(t.staking(&bob).await?.backing, None);

    // The impeached chair is refused. The new chair may act at once, measuring its step from 40.
    let old = t.set_policy(&chair, 40).await?;
    assert!(
        failure_text(&old).contains("only the chair may set policy"),
        "{}",
        failure_text(&old)
    );
    let too_far = t.set_policy(&dan, 91).await?;
    assert!(
        failure_text(&too_far).contains("rate step too large"),
        "{}",
        failure_text(&too_far)
    );
    let result = t.set_policy(&dan, 80).await?;
    ensure_success(&result)?;

    let logged = events(&result);
    let names: Vec<_> = logged
        .iter()
        .filter(|e| e["standard"] == "chair")
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "epoch_minted",
            "impeached",
            "nomination_withdrawn",
            "policy_set"
        ]
    );
    let mint = supply * 40 / 10_000;
    assert_eq!(
        named(&logged, "epoch_minted")[0]["data"]["amount"],
        mint.to_string()
    );
    assert_eq!(
        named(&logged, "impeached")[0]["data"],
        json!({ "epoch": 0, "previous_chair": chair.id(), "new_chair": dan.id(),
                "persona_hash": "cd".repeat(32), "backing": (200 * TOKEN).to_string(),
                "total_staked": (300 * TOKEN).to_string(), "streak_ended": 1 })
    );
    assert_eq!(
        named(&logged, "policy_set")[0]["data"]["chair"],
        dan.id().to_string()
    );
    assert_eq!(
        t.near_balance(&nominator).await? - nominator_before,
        NOMINATE_BOND,
        "the bond is refunded once, in full"
    );
    assert_eq!(t.policy().await?.rate_bps, 80);

    // The term started in epoch 1; a full epoch later the streak is 1.
    t.advance_to_epoch(2).await?;
    assert_eq!(t.policy().await?.streak, 1);

    // Everyone's backing from the old term is dead: staking more or less moves nothing and cannot underflow.
    ensure_success(&t.nominate(&nominator, &chair, NOMINATE_BOND).await?)?;
    ensure_success(&t.unstake(&bob, 5 * TOKEN).await?)?;
    ensure_success(
        &t.call(&bob, "stake", json!({ "amount": TOKEN.to_string() }), 1)
            .await?,
    )?;
    assert_eq!(total_backing(&t).await?, 0);
    t.assert_supply_invariant(&[&t.alice, &bob, &carol, &chair])
        .await
}

#[tokio::test]
async fn backing_exactly_at_the_threshold_does_not_impeach_one_yocto_less_stake_elsewhere_does()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let (bob, carol) = (t.user("bob", 600).await?, t.user("carol", 300).await?);
    let (dan, nominator) = (t.user("dan", 0).await?, t.user("nominator", 0).await?);
    // Alice holds the remaining 100: 1000 staked in all, carol's 300 backing dan.
    for (who, tokens) in [(&bob, 600), (&carol, 300), (&t.alice, 100)] {
        ensure_success(&t.stake(who, tokens * TOKEN).await?)?;
    }
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&carol, &dan).await?)?;

    // 300 of 1000 staked is exactly 30%: the threshold must be exceeded, not met.
    t.advance_to_epoch(2).await?;
    assert_eq!(t.policy().await?.chair, chair.id().to_string());
    assert_eq!(t.candidates().await?.len(), 1, "the nomination stays live");

    // One yocto less stake elsewhere puts the same backing over the line at the next boundary.
    ensure_success(&t.unstake(&t.alice, 1).await?)?;
    assert_eq!(
        t.policy().await?.chair,
        chair.id().to_string(),
        "nothing changes until the boundary"
    );
    t.advance_to_epoch(3).await?;
    assert_eq!(t.policy().await?.chair, dan.id().to_string());
    t.assert_supply_invariant(&[&t.alice, &bob, &carol]).await
}

#[tokio::test]
async fn backing_must_also_exceed_five_percent_of_the_supply_to_seat_a_chair() -> anyhow::Result<()>
{
    // Nobody else stakes, so the one backer holds 100% of the stake, far over the 30% threshold. Only the
    // quorum (500 bps of the 1000-token supply, strictly) decides: exactly 50 tokens is not enough.
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let params: Value = t.token.view("get_params").await?.json()?;
    assert_eq!(params["quorum_bps"], 500);
    let (bob, nominator) = (t.user("bob", 51).await?, t.user("nominator", 0).await?);
    let dan = t.user("dan", 0).await?;
    ensure_success(&t.stake(&bob, 50 * TOKEN).await?)?;
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &dan).await?)?;
    t.advance_to_epoch(1).await?;
    assert_eq!(t.policy().await?.chair, chair.id().to_string());
    assert_eq!(t.candidates().await?.len(), 1, "the nomination stays live");

    // One yocto more, staked during epoch 1, seats it at the next boundary.
    ensure_success(&t.stake(&bob, 1).await?)?;
    assert_eq!(u(&t.candidates().await?[0].backing), 50 * TOKEN + 1);
    t.advance_to_epoch(2).await?;
    assert_eq!(t.policy().await?.chair, dan.id().to_string());
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}
