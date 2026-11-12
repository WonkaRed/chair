//! The leash on the real wasm: the chair's rate is per day and every meeting mints one meeting's share of it
//! (SPEC.md "The leash in numbers"), so a chair pinned at +200 cannot print more than a day's rate a day.

use sandbox_tests::{
    EPOCH_MS, INITIAL_SUPPLY, TOKEN, ensure_success, events, launch, launch_with_supply, mint_of,
};
use serde_json::Value;

/// The launch epoch length: 960 meetings a day.
const MEETING_MS: u64 = 90_000;

fn u(value: &Value) -> u128 {
    value.as_str().unwrap().parse().unwrap()
}

#[tokio::test]
async fn at_90_second_epochs_a_meeting_mints_one_960th_of_the_daily_rate() -> anyhow::Result<()> {
    let t = launch(MEETING_MS).await?;
    let chair = t.scoped_chair().await?;
    let params: Value = t.token.view("get_params").await?.json()?;
    assert_eq!(params["meetings_per_day"], 960);
    assert_eq!(
        params["max_rate_bps"], 200,
        "the bound is the same number, now per day"
    );

    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    let supply = t.total_supply().await?;
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );
    t.advance_to_epoch(1).await?;

    // 50 bps a day on 10^30 units over 960 meetings, floored: 5_208_333_333_333_333_333_333.
    let mint = mint_of(supply, 50, MEETING_MS);
    assert_eq!(mint, supply * 50 / 9_600_000);
    assert_eq!(mint, 5_208_333_333_333_333_333_333);
    assert_eq!(t.total_supply().await?, supply + mint);
    assert_eq!(t.pool().await?.reward_pool.parse::<u128>()?, mint);
    let claimed = t.claim(&t.alice).await?;
    ensure_success(&claimed)?;
    let log = events(&claimed);
    let minted: Vec<&Value> = log
        .iter()
        .filter(|e| e["event"] == "epoch_minted")
        .collect();
    assert_eq!(
        minted.len(),
        1,
        "boundary 0 only: the claim came early in epoch 1"
    );
    assert_eq!(u(&minted[0]["data"]["amount"]), mint);
    t.assert_supply_invariant(&[&t.alice, &chair]).await
}

#[tokio::test]
async fn one_basis_point_a_day_on_a_million_coins_mints_a_nonzero_amount_a_meeting()
-> anyhow::Result<()> {
    // A million coins at 24 decimals is 10^30 units; 1 bps a day over 960 meetings is 10^30 / 9_600_000 each.
    let million = (1_000_000 * TOKEN).to_string();
    let t = launch_with_supply(MEETING_MS, &million).await?;
    let chair = t.scoped_chair().await?;
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    ensure_success(&t.set_policy(&chair, 1).await?)?;
    assert_eq!(
        t.policy().await?.epoch,
        0,
        "the scenario must stay in epoch 0"
    );
    t.advance_to_epoch(1).await?;
    let mint = t.total_supply().await? - 1_000_000 * TOKEN;
    assert_eq!(mint, 104_166_666_666_666_666_666_666);
    assert_eq!(mint, mint_of(1_000_000 * TOKEN, 1, MEETING_MS));
    Ok(())
}

#[tokio::test]
async fn a_chair_pinned_at_the_maximum_mints_one_meetings_share_each_boundary_and_no_more()
-> anyhow::Result<()> {
    // 30 s epochs are 2880 a day, so each boundary may mint at most supply * 200 / (10_000 * 2880) = supply / 144_000.
    // The chair climbs 50 bps an epoch to +200 and stays; every boundary's mint equals that formula, on the supply the
    // previous boundary left, and the supply after eight of them matches the same recurrence exactly.
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    ensure_success(&t.stake(&t.alice, 500 * TOKEN).await?)?;
    let launch_supply: u128 = INITIAL_SUPPLY.parse()?;
    let mut log: Vec<Value> = Vec::new();
    for epoch in 0u64..9 {
        t.advance_to_epoch(epoch).await?;
        let rate = ((epoch as i32 + 1) * 50).min(200);
        let result = t.set_policy(&chair, rate).await?;
        ensure_success(&result)?;
        log.extend(events(&result));
    }
    let mints: Vec<u128> = log
        .iter()
        .filter(|e| e["event"] == "epoch_minted")
        .map(|e| u(&e["data"]["amount"]))
        .collect();
    assert_eq!(
        mints.len(),
        8,
        "boundaries 0..=7 are applied once epoch 8 is open"
    );
    let mut supply = launch_supply;
    for (boundary, mint) in mints.iter().enumerate() {
        let rate = ((boundary as u128 + 1) * 50).min(200);
        assert_eq!(
            *mint,
            mint_of(supply, rate, EPOCH_MS),
            "boundary {boundary}"
        );
        assert!(
            mint * 144_000 <= supply,
            "boundary {boundary}: more than 1/144000 of the supply"
        );
        supply += mint;
    }
    assert_eq!(t.total_supply().await?, supply);
    assert!(
        supply < launch_supply + launch_supply / 10_000,
        "eight meetings are far under 1 bps of the supply"
    );
    t.assert_supply_invariant(&[&t.alice, &chair]).await
}
