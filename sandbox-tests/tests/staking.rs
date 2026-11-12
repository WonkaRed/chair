//! Staking, rewards and the lock, against the real wasm. Every scenario ends with the supply
//! invariant: total supply == liquid balances + stake + unclaimed reward pool.

use near_workspaces::types::NearToken;
use sandbox_tests::{TOKEN, ensure_success, events, failure_text, launch, mint_of, mul_div};
use serde_json::{Value, json};

/// Long enough that a scenario's handful of transactions never straddles a boundary by accident.
const EPOCH_MS: u64 = 90_000;

fn u(value: &str) -> u128 {
    value.parse().unwrap()
}

fn named<'a>(events: &'a [Value], standard: &str, event: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|e| e["standard"] == standard && e["event"] == event)
        .collect()
}

#[tokio::test]
async fn stake_moves_liquid_balance_into_stake_and_not_out_of_the_supply() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 100).await?;
    let supply = t.total_supply().await?;

    let result = t.stake(&bob, 40 * TOKEN).await?;
    ensure_success(&result)?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );

    assert_eq!(t.balance(&bob).await?, 60 * TOKEN);
    let staking = t.staking(&bob).await?;
    assert_eq!(
        (u(&staking.staked), u(&staking.pending_reward)),
        (40 * TOKEN, 0)
    );
    assert_eq!((staking.backing, staking.unlock_epoch), (None, 2));
    assert_eq!(u(&t.pool().await?.total_staked), 40 * TOKEN);
    assert_eq!(
        t.total_supply().await?,
        supply,
        "staked tokens stay in the supply"
    );

    let logged = events(&result);
    let staked = named(&logged, "chair", "staked");
    assert_eq!(staked.len(), 1);
    assert_eq!(
        staked[0]["data"],
        json!({ "account_id": bob.id(), "amount": (40 * TOKEN).to_string(),
                "total_staked": (40 * TOKEN).to_string() })
    );
    let moved = named(&logged, "nep141", "ft_transfer");
    assert_eq!(
        moved[0]["data"][0]["new_owner_id"],
        t.token.id().to_string()
    );
    assert_eq!(moved[0]["data"][0]["memo"], "chair:stake");

    // A second stake needs only 1 yocto (the record is paid for) and tops the balance up.
    let top_up = t
        .call(
            &bob,
            "stake",
            json!({ "amount": (10 * TOKEN).to_string() }),
            1,
        )
        .await?;
    ensure_success(&top_up)?;
    assert_eq!(u(&t.staking(&bob).await?.staked), 50 * TOKEN);

    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn the_first_stake_pays_for_its_record_and_the_surplus_is_refunded() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 100).await?;

    let before = t.near_balance(&bob).await?;
    ensure_success(&t.stake(&bob, TOKEN).await?)?;
    let spent = before - t.near_balance(&bob).await?;
    // 0.01 NEAR was attached. A record of ~100 bytes costs ~0.001 NEAR and the gas is cheaper still.
    assert!(spent > 0, "the record has to be paid for");
    assert!(
        spent < NearToken::from_millinear(5).as_yoctonear(),
        "the surplus deposit comes back: spent {spent} yoctoNEAR"
    );
    Ok(())
}

#[tokio::test]
async fn staking_and_claiming_are_refused_unless_they_are_valid() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 10).await?;
    let ghost = t
        .worker
        .root_account()?
        .create_subaccount("ghost")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    ensure_success(&t.stake(&bob, 4 * TOKEN).await?)?;
    let amount = |tokens: u128| json!({ "amount": (tokens * TOKEN).to_string() });

    let cases = [
        (
            "stake with no deposit",
            t.call(&bob, "stake", amount(1), 0).await?,
            "Requires attached deposit",
        ),
        (
            "stake of zero",
            t.stake(&bob, 0).await?,
            "amount must be positive",
        ),
        (
            "stake more than the liquid balance",
            t.stake(&bob, 7 * TOKEN).await?,
            "doesn't have enough balance",
        ),
        (
            "stake by an unregistered account",
            t.stake(&ghost, 1).await?,
            "is not registered",
        ),
        (
            "a first stake that does not pay for its record",
            t.call(&t.alice, "stake", amount(1), 1).await?,
            "First stake: attach",
        ),
        (
            "unstake with no deposit",
            t.call(&bob, "unstake", amount(1), 0).await?,
            "Requires attached deposit of exactly 1 yoctoNEAR",
        ),
        (
            "unstake of zero",
            t.unstake(&bob, 0).await?,
            "amount must be positive",
        ),
        (
            "unstake by someone who never staked",
            t.unstake(&ghost, 1).await?,
            "no stake",
        ),
        (
            "unstake more than staked",
            t.unstake(&bob, 5 * TOKEN).await?,
            "exceeds the staked balance",
        ),
        (
            "unstake inside the lock",
            t.unstake(&bob, TOKEN).await?,
            "stake is locked until epoch 2",
        ),
        (
            "claim with no deposit",
            t.call(&bob, "claim", json!({}), 0).await?,
            "Requires attached deposit of exactly 1 yoctoNEAR",
        ),
        (
            "claim with nothing earned",
            t.claim(&bob).await?,
            "nothing to claim",
        ),
        (
            "claim by a non-staker",
            t.claim(&ghost).await?,
            "nothing to claim",
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

    assert_eq!(t.policy().await?.epoch, 0);
    assert_eq!(
        u(&t.staking(&bob).await?.staked),
        4 * TOKEN,
        "refused calls changed nothing"
    );
    assert_eq!(t.balance(&bob).await?, 6 * TOKEN);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn unstake_works_from_the_unlock_epoch_not_before() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 100).await?;
    ensure_success(&t.stake(&bob, 40 * TOKEN).await?)?;
    assert_eq!(t.staking(&bob).await?.unlock_epoch, 2);

    t.advance_to_epoch(1).await?;
    let early = t.unstake(&bob, TOKEN).await?;
    assert!(
        failure_text(&early).contains("stake is locked until epoch 2"),
        "{}",
        failure_text(&early)
    );

    t.advance_to_epoch(2).await?;
    let result = t.unstake(&bob, 15 * TOKEN).await?;
    ensure_success(&result)?;
    assert_eq!(t.balance(&bob).await?, 75 * TOKEN);
    assert_eq!(u(&t.staking(&bob).await?.staked), 25 * TOKEN);
    let logged = events(&result);
    assert_eq!(named(&logged, "chair", "unstaked").len(), 1);
    assert_eq!(
        named(&logged, "nep141", "ft_transfer")[0]["data"][0]["memo"],
        "chair:unstake"
    );

    // A top-up restarts the lock on the whole stake.
    ensure_success(
        &t.call(&bob, "stake", json!({ "amount": TOKEN.to_string() }), 1)
            .await?,
    )?;
    assert_eq!(t.staking(&bob).await?.unlock_epoch, 4);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn easing_mints_at_the_boundary_and_stakers_claim_their_share() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 101).await?;
    let carol = t.user("carol", 51).await?;
    // Odd amounts so the shares do not divide evenly and the rounding is on show.
    let stakes = [
        (&t.alice, 350 * TOKEN + 3),
        (&bob, 100 * TOKEN + 7),
        (&carol, 50 * TOKEN + 11),
    ];
    for (who, amount) in stakes {
        ensure_success(&t.stake(who, amount).await?)?;
    }
    let total_staked: u128 = stakes.iter().map(|(_, a)| a).sum();
    let supply = t.total_supply().await?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );

    // The chair acted in epoch 0, so 50 bps is in effect during epoch 1 too and decays after it:
    // boundaries 0 and 1 mint, each floored, each on the supply the previous one left.
    let mint_0 = mint_of(supply, 50, EPOCH_MS);
    let mint_1 = mint_of(supply + mint_0, 50, EPOCH_MS);
    let index = mul_div(mint_0, TOKEN, total_staked) + mul_div(mint_1, TOKEN, total_staked);
    let owed = |staked: u128| mul_div(staked, index, TOKEN);

    t.advance_to_epoch(2).await?;
    assert_eq!(t.policy().await?.rate_bps, 0);
    // Views already show the rollover nobody has transacted yet.
    assert_eq!(t.total_supply().await?, supply + mint_0 + mint_1);
    for (who, amount) in stakes {
        assert_eq!(u(&t.staking(who).await?.pending_reward), owed(amount));
    }
    let pool = t.pool().await?;
    assert_eq!(u(&pool.reward_pool), mint_0 + mint_1);
    assert_eq!(pool.reward_per_share, index.to_string());
    t.assert_supply_invariant(&[&t.alice, &bob, &carol]).await?;

    // The first transaction after the boundary applies it, in order, with a NEP-141 mint each.
    let result = t.claim(&bob).await?;
    ensure_success(&result)?;
    assert_eq!(
        result.clone().json::<String>()?,
        owed(100 * TOKEN + 7).to_string()
    );
    let logged = events(&result);
    let minted = named(&logged, "chair", "epoch_minted");
    assert_eq!(minted.len(), 2);
    assert_eq!(minted[0]["data"]["epoch"], 0);
    assert_eq!(minted[0]["data"]["amount"], mint_0.to_string());
    assert_eq!(minted[0]["data"]["rate_bps"], 50);
    assert_eq!(minted[1]["data"]["epoch"], 1);
    assert_eq!(minted[1]["data"]["amount"], mint_1.to_string());
    assert_eq!(
        named(&logged, "nep141", "ft_mint")
            .iter()
            .map(|e| e["data"][0]["memo"].clone())
            .collect::<Vec<_>>(),
        ["chair:easing", "chair:easing"]
    );
    // Bob held 101 tokens and staked 100 and 7 yocto: what is left, plus the claim.
    assert_eq!(t.balance(&bob).await?, TOKEN - 7 + owed(100 * TOKEN + 7));
    assert_eq!(u(&t.staking(&bob).await?.pending_reward), 0);

    for who in [&t.alice, &carol] {
        ensure_success(&t.claim(who).await?)?;
    }
    // Whatever the floors left behind stays in the pool, unreachable: about a thousand yocto, never more than minted.
    let owed_total: u128 = stakes.iter().map(|(_, a)| owed(*a)).sum();
    let dust = u(&t.pool().await?.reward_pool);
    assert_eq!(dust, mint_0 + mint_1 - owed_total);
    // Each boundary's index floor loses under one unit of index, worth `total_staked / TOKEN` yocto across
    // the whole stake, and each staker's own floor loses under one yocto.
    let bound = 2 * (total_staked / TOKEN + 1) + stakes.len() as u128;
    assert!(dust <= bound, "rounding dust was {dust}, bound {bound}");
    assert_eq!(t.total_supply().await?, supply + mint_0 + mint_1);
    t.assert_supply_invariant(&[&t.alice, &bob, &carol]).await
}

#[tokio::test]
async fn a_stake_made_after_a_boundary_earns_nothing_from_it_and_cannot_leave_straight_after_the_next()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 500).await?;
    ensure_success(&t.stake(&t.alice, 100 * TOKEN).await?)?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    let supply = t.total_supply().await?;
    let mint_0 = mint_of(supply, 50, EPOCH_MS);

    // Epoch 1 begins: boundary 0 has passed, its mint belongs to alice alone, whoever stakes now.
    t.advance_to_epoch(1).await?;
    ensure_success(&t.stake(&bob, 400 * TOKEN).await?)?;
    assert_eq!(
        u(&t.staking(&bob).await?.pending_reward),
        0,
        "bob earned nothing from boundary 0"
    );
    assert_eq!(
        u(&t.staking(&t.alice).await?.pending_reward),
        mul_div(100 * TOKEN, mul_div(mint_0, TOKEN, 100 * TOKEN), TOKEN),
        "alice's whole stake earned boundary 0, to the floor of the index"
    );

    // Boundary 1 mints again (50 bps is still in effect) and bob shares it.
    let mint_1 = mint_of(supply + mint_0, 50, EPOCH_MS);
    t.advance_to_epoch(2).await?;
    let bob_share = mul_div(400 * TOKEN, mul_div(mint_1, TOKEN, 500 * TOKEN), TOKEN);
    assert_eq!(u(&t.staking(&bob).await?.pending_reward), bob_share);

    // The jump-in, take-a-share, jump-out attack: bob cannot leave until epoch 3, after two boundaries.
    let leave = t.unstake(&bob, 400 * TOKEN).await?;
    assert!(
        failure_text(&leave).contains("stake is locked until epoch 3"),
        "{}",
        failure_text(&leave)
    );
    t.advance_to_epoch(3).await?;
    ensure_success(&t.unstake(&bob, 400 * TOKEN).await?)?;
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn unstaking_keeps_the_reward_already_earned_and_stops_earning() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let bob = t.user("bob", 100).await?;
    ensure_success(&t.stake(&bob, 100 * TOKEN).await?)?;
    ensure_success(&t.stake(&t.alice, 100 * TOKEN).await?)?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    let supply = t.total_supply().await?;
    let mint_0 = mint_of(supply, 50, EPOCH_MS);
    let mint_1 = mint_of(supply + mint_0, 50, EPOCH_MS);

    // Bob leaves in epoch 2, having sat through boundaries 0 and 1 (both minted); the rate is 0 by then.
    t.advance_to_epoch(2).await?;
    ensure_success(&t.unstake(&bob, 100 * TOKEN).await?)?;
    let earned = u(&t.staking(&bob).await?.pending_reward);
    let half = |mint: u128| mul_div(100 * TOKEN, mul_div(mint, TOKEN, 200 * TOKEN), TOKEN);
    assert_eq!(
        earned,
        half(mint_0) + half(mint_1),
        "half of both mints, each floored through the index: the stakes were equal"
    );
    assert_eq!(
        t.balance(&bob).await?,
        100 * TOKEN,
        "the reward is claimed separately, not paid by unstake"
    );

    // Claiming after the exit still works and pays exactly the settled amount.
    let claimed = t.claim(&bob).await?;
    assert_eq!(claimed.clone().json::<String>()?, earned.to_string());
    assert_eq!(t.balance(&bob).await?, 100 * TOKEN + earned);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}
