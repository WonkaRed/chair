//! Attacks on the staking and voting economics, each shown to fail against the real wasm.
//! (The 1000-epoch rounding-dust attack is a unit test: `rollover::tests`.)

use sandbox_tests::{
    NOMINATE_BOND, TOKEN, ensure_success, events, failure_text, launch, launch_with_supply,
};
use serde_json::json;

const EPOCH_MS: u64 = 120_000;

fn u(value: &str) -> u128 {
    value.parse().unwrap()
}

async fn assert_backing_is_covered_by_stake(t: &sandbox_tests::Chair) -> anyhow::Result<u128> {
    let backing: u128 = t.candidates().await?.iter().map(|c| u(&c.backing)).sum();
    let staked = u(&t.pool().await?.total_staked);
    anyhow::ensure!(
        backing <= staked,
        "backing {backing} exceeds total staked {staked}"
    );
    Ok(backing)
}

#[tokio::test]
async fn a_vote_cannot_be_replayed_by_unstaking_and_restaking_from_another_account()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let (bob, carol) = (t.user("bob", 100).await?, t.user("carol", 0).await?);
    let (dan, nominator) = (t.user("dan", 0).await?, t.user("nominator", 0).await?);
    ensure_success(&t.stake(&t.alice, 900 * TOKEN).await?)?;
    ensure_success(&t.stake(&bob, 100 * TOKEN).await?)?;
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &dan).await?)?;
    assert_eq!(assert_backing_is_covered_by_stake(&t).await?, 100 * TOKEN);

    // Bob's stake is locked for two epochs, so the same tokens cannot move on to a second voter early.
    let early = t.unstake(&bob, 100 * TOKEN).await?;
    assert!(
        failure_text(&early).contains("stake is locked"),
        "{}",
        failure_text(&early)
    );

    // Once it is unlocked, leaving takes the backing off the candidate in the same call...
    t.advance_to_epoch(2).await?;
    ensure_success(&t.unstake(&bob, 100 * TOKEN).await?)?;
    assert_eq!(assert_backing_is_covered_by_stake(&t).await?, 0);

    // ...so the same 100 tokens, staked and backed from carol's account, count once, not twice.
    ensure_success(&t.transfer(&bob, &carol, 100 * TOKEN).await?)?;
    ensure_success(&t.stake(&carol, 100 * TOKEN).await?)?;
    ensure_success(&t.back(&carol, &dan).await?)?;
    assert_eq!(assert_backing_is_covered_by_stake(&t).await?, 100 * TOKEN);
    assert_eq!(u(&t.candidates().await?[0].backing), 100 * TOKEN);

    // 100 of 1000 staked is 10%: nobody was impeached by a vote counted twice.
    t.advance_to_epoch(4).await?;
    assert_ne!(t.policy().await?.chair, dan.id().to_string());
    t.assert_supply_invariant(&[&t.alice, &bob, &carol]).await
}

#[tokio::test]
async fn a_borrowed_vote_is_locked_in_for_at_least_two_epochs() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let (whale, honest) = (t.user("whale", 500).await?, t.user("honest", 100).await?);
    let (dan, nominator) = (t.user("dan", 0).await?, t.user("nominator", 0).await?);
    ensure_success(&t.stake(&honest, 100 * TOKEN).await?)?;
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;

    // The whale stakes borrowed tokens and backs dan: 500 of 600 staked carries the vote...
    ensure_success(&t.stake(&whale, 500 * TOKEN).await?)?;
    ensure_success(&t.back(&whale, &dan).await?)?;
    t.advance_to_epoch(1).await?;
    assert_eq!(t.policy().await?.chair, dan.id().to_string());

    // ...but the lender gets the tokens back only after two epochs, not the instant the vote is counted.
    let leave = t.unstake(&whale, 500 * TOKEN).await?;
    assert!(
        failure_text(&leave).contains("stake is locked until epoch 2"),
        "{}",
        failure_text(&leave)
    );
    t.advance_to_epoch(2).await?;
    ensure_success(&t.unstake(&whale, 500 * TOKEN).await?)?;
    t.assert_supply_invariant(&[&t.alice, &whale, &honest])
        .await
}

#[tokio::test]
async fn withdrawing_after_the_boundary_cannot_undo_the_vote_or_collect_a_second_refund()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let (bob, carol) = (t.user("bob", 200).await?, t.user("carol", 100).await?);
    let (dan, nominator) = (t.user("dan", 0).await?, t.user("nominator", 0).await?);
    ensure_success(&t.stake(&bob, 200 * TOKEN).await?)?;
    ensure_success(&t.stake(&carol, 100 * TOKEN).await?)?;
    ensure_success(&t.nominate(&nominator, &dan, NOMINATE_BOND).await?)?;
    ensure_success(&t.back(&bob, &dan).await?)?;

    t.advance_to_epoch(1).await?;
    // The nominator tries to pull the nomination after the vote was already won. The boundary is applied
    // first, so there is nothing left to withdraw.
    let late = t
        .call(
            &nominator,
            "withdraw_nomination",
            json!({ "candidate": dan.id() }),
            1,
        )
        .await?;
    assert!(
        failure_text(&late).contains("no such candidate"),
        "{}",
        failure_text(&late)
    );
    assert_eq!(t.policy().await?.chair, dan.id().to_string());

    // The first call that goes through applies the impeachment; the bond comes back once, in full.
    let before = t.near_balance(&nominator).await?;
    ensure_success(&t.set_policy(&dan, 10).await?)?;
    assert_eq!(t.near_balance(&nominator).await? - before, NOMINATE_BOND);
    let denied = t.set_policy(&chair, 0).await?;
    assert!(failure_text(&denied).contains("only the chair may set policy"));
    Ok(())
}

#[tokio::test]
async fn nobody_can_back_with_tokens_they_have_not_staked() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let (bob, dan) = (t.user("bob", 900).await?, t.user("dan", 0).await?);
    ensure_success(&t.nominate(&bob, &dan, NOMINATE_BOND).await?)?;

    // Bob holds 900 liquid tokens, which is no vote at all.
    let result = t.back(&bob, &dan).await?;
    assert!(
        failure_text(&result).contains("stake first"),
        "{}",
        failure_text(&result)
    );
    assert_eq!(assert_backing_is_covered_by_stake(&t).await?, 0);
    Ok(())
}

#[tokio::test]
async fn unregistering_with_stake_keeps_the_supply_honest_and_the_stake_recoverable()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let bob = t.user("bob", 100).await?;
    ensure_success(&t.stake(&bob, 40 * TOKEN).await?)?;
    let supply = t.total_supply().await?;

    // Force-unregistering destroys the 60 liquid tokens (standard NEP-145) and leaves the stake alone.
    let gone = t
        .call(&bob, "storage_unregister", json!({ "force": true }), 1)
        .await?;
    ensure_success(&gone)?;
    assert_eq!(t.total_supply().await?, supply - 60 * TOKEN);
    assert_eq!(u(&t.staking(&bob).await?.staked), 40 * TOKEN);
    t.assert_supply_invariant(&[&t.alice, &bob]).await?;

    // The stake cannot be paid out to an unregistered account; registering again recovers it.
    t.advance_to_epoch(2).await?;
    let refused = t.unstake(&bob, 40 * TOKEN).await?;
    assert!(
        failure_text(&refused).contains("is not registered"),
        "{}",
        failure_text(&refused)
    );
    ensure_success(
        &t.call(
            &bob,
            "storage_deposit",
            json!({}),
            10_000_000_000_000_000_000_000,
        )
        .await?,
    )?;
    ensure_success(&t.unstake(&bob, 40 * TOKEN).await?)?;
    assert_eq!(t.balance(&bob).await?, 40 * TOKEN);
    t.assert_supply_invariant(&[&t.alice, &bob]).await
}

#[tokio::test]
async fn at_the_supply_cap_the_mint_is_clipped_and_cannot_overflow() -> anyhow::Result<()> {
    // Launch with the largest supply the contract allows and stake a single yocto: the reward index
    // takes the whole mint over one unit of stake, the case that overflows any 128-bit index.
    let cap = u128::MAX / 10_000;
    let t = launch_with_supply(EPOCH_MS, &(cap - 1_000).to_string()).await?;
    let chair = t.scoped_chair().await?;
    ensure_success(&t.stake(&t.alice, 1).await?)?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;

    // One boundary at 50 bps a day mints ~2.4e29 (120 s epochs), far over the 1000 yocto of headroom under the cap.
    t.advance_to_epoch(1).await?;
    assert_eq!(t.total_supply().await?, cap);
    assert_eq!(u(&t.staking(&t.alice).await?.pending_reward), 1_000);

    let result = t.claim(&t.alice).await?;
    ensure_success(&result)?;
    assert_eq!(result.clone().json::<String>()?, "1000");
    // Boundary 1 also minted at 50 bps (the chair acted in epoch 0) but the cap is reached: nothing more.
    t.advance_to_epoch(3).await?;
    assert_eq!(t.total_supply().await?, cap);
    assert!(
        events(&t.claim(&t.alice).await?).is_empty(),
        "nothing is left to claim"
    );
    t.assert_supply_invariant(&[&t.alice, &chair]).await
}

#[tokio::test]
async fn one_yocto_of_stake_and_a_sock_puppet_cannot_seat_a_chair() -> anyhow::Result<()> {
    // The audit's probe p1: with nobody else staked, one yocto is 100% of the stake and cleared the old
    // threshold. The quorum (5% of the supply) now holds the seat against it, for as many epochs as it likes.
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let (mallory, sock) = (t.user("mallory", 1).await?, t.user("sock", 0).await?);
    ensure_success(&t.stake(&mallory, 1).await?)?;
    ensure_success(&t.nominate(&mallory, &sock, NOMINATE_BOND).await?)?;
    assert_eq!(u(&t.candidates().await?[0].backing), 1);

    t.advance_to_epoch(3).await?;
    assert_eq!(t.policy().await?.chair, chair.id().to_string());
    assert_eq!(
        t.candidates().await?.len(),
        1,
        "the nomination is still live"
    );
    let refused = t.set_policy(&sock, 50).await?;
    assert!(
        failure_text(&refused).contains("only the chair may set policy"),
        "{}",
        failure_text(&refused)
    );
    t.assert_supply_invariant(&[&t.alice, &mallory]).await
}
