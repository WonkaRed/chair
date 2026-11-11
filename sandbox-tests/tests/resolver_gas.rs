//! `ft_resolve_transfer` rolls the epoch before it refunds, and its gas budget is fixed when
//! `ft_transfer_call` schedules it. These tests build the most expensive rollover the contract can face
//! (a full candidate list of the longest account ids and persona hashes, a mint, a decay and an
//! impeachment that refunds ten bonds) and check the refund still arrives, with headroom to spare.

use near_workspaces::Account;
use near_workspaces::result::ExecutionFinalResult;
use sandbox_tests::{
    Chair, JUMP_BLOCKS, NOMINATE_BOND, TOKEN, ensure_success, events, failure_text, launch,
};
use serde_json::json;
use std::time::Duration;

/// The resolver's static budget in the contract (`GAS_FOR_RESOLVE_TRANSFER`), in Tgas.
const RESOLVER_BUDGET_TGAS: u64 = 30;
const EPOCH_MS: u64 = 150_000;
/// Hops the delaying receiver chains; each is a failed call to a missing account, one block apiece.
const HOPS: usize = 40;
/// How long before a boundary the transfer is sent: inside the receiver's delay.
const LEAD_MS: u64 = 2_000;

fn leb_u(mut v: u64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn leb_s(mut v: i64, out: &mut Vec<u8>) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if (v == 0 && byte & 0x40 == 0) || (v == -1 && byte & 0x40 != 0) {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn section(id: u8, body: &[u8], module: &mut Vec<u8>) {
    module.push(id);
    leb_u(body.len() as u64, module);
    module.extend_from_slice(body);
}

/// A NEAR contract whose `ft_on_transfer` chains `hops` failing calls and returns the last one, so the
/// token's resolver runs `hops` blocks later and sees a failure (the whole transfer is refunded).
/// Hand-assembled: imports `promise_create`, `promise_then`, `promise_return`; no other code.
fn delaying_receiver(hops: usize) -> Vec<u8> {
    const TARGET: &[u8] = b"nobody.test.near";
    const METHOD: &[u8] = b"m";
    const METHOD_AT: i64 = 32;
    const AMOUNT_AT: i64 = 64; // 16 zero bytes: a deposit of 0
    const HOP_GAS: i64 = 3_000_000_000_000;

    let mut m = b"\0asm\x01\0\0\0".to_vec();
    // Types: 0 () -> (), 1 promise_create, 2 promise_then, 3 promise_return.
    let mut types = vec![4u8];
    types.extend([0x60, 0, 0]);
    types.extend([
        0x60, 8, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 1, 0x7e,
    ]);
    types.extend([
        0x60, 9, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 0x7e, 1, 0x7e,
    ]);
    types.extend([0x60, 1, 0x7e, 0]);
    section(1, &types, &mut m);
    let mut imports = vec![3u8];
    for (name, ty) in [
        ("promise_create", 1u8),
        ("promise_then", 2),
        ("promise_return", 3),
    ] {
        imports.extend([3, b'e', b'n', b'v', name.len() as u8]);
        imports.extend(name.as_bytes());
        imports.extend([0, ty]);
    }
    section(2, &imports, &mut m);
    section(3, &[1, 0], &mut m);
    section(5, &[1, 0, 1], &mut m); // one memory of one page, defined here as NEAR contracts do
    let mut exports = vec![1u8, 14];
    exports.extend(b"ft_on_transfer");
    exports.extend([0, 3]);
    section(7, &exports, &mut m);

    let call_args = |out: &mut Vec<u8>| {
        for v in [
            TARGET.len() as i64,
            0,
            METHOD.len() as i64,
            METHOD_AT,
            0,
            0,
            AMOUNT_AT,
            HOP_GAS,
        ] {
            out.push(0x42);
            leb_s(v, out);
        }
    };
    let mut body = vec![1u8, 1, 0x7e]; // one local: i64
    call_args(&mut body);
    body.extend([0x10, 0, 0x21, 0]);
    for _ in 0..hops {
        body.extend([0x20, 0]);
        call_args(&mut body);
        body.extend([0x10, 1, 0x21, 0]);
    }
    body.extend([0x20, 0, 0x10, 2, 0x0b]);
    let mut code = vec![1u8];
    leb_u(body.len() as u64, &mut code);
    code.extend(body);
    section(10, &code, &mut m);

    let mut data = vec![1u8, 0, 0x41, 0, 0x0b];
    let mut bytes = TARGET.to_vec();
    bytes.resize(METHOD_AT as usize, 0);
    bytes.extend(METHOD);
    leb_u(bytes.len() as u64, &mut data);
    data.extend(bytes);
    section(11, &data, &mut m);
    m
}

/// Ten nominations with 64-character candidate ids, 54-character nominator names and 128-byte persona
/// hashes (the longest the sandbox and the contract allow), and a staker backing the first with 200 tokens.
/// Returns the nominators.
async fn full_candidate_list(t: &Chair) -> anyhow::Result<Vec<Account>> {
    let persona = "ab".repeat(64);
    let mut nominators = Vec::new();
    for i in 0..10 {
        let name = format!("{:x<54}", format!("nominator{i}"));
        let tokens = if i == 0 { 200 } else { 0 };
        let nominator = t.user(&name, tokens).await?;
        if i == 0 {
            ensure_success(&t.stake(&nominator, 200 * TOKEN).await?)?;
        }
        let candidate = format!("{:y<59}.near", format!("candidate{i}"));
        assert_eq!(candidate.len(), 64);
        ensure_success(
            &t.call(
                &nominator,
                "nominate",
                json!({ "candidate": candidate, "persona_hash": persona }),
                NOMINATE_BOND,
            )
            .await?,
        )?;
        nominators.push(nominator);
    }
    Ok(nominators)
}

/// Gas burnt by the receipt(s) the token itself executed for a call, per method, in execution order.
fn token_receipts(t: &Chair, result: &ExecutionFinalResult) -> Vec<u64> {
    result
        .outcomes()
        .into_iter()
        .filter(|o| o.executor_id == *t.token.id())
        .map(|o| o.gas_burnt.as_gas())
        .collect()
}

async fn block_ms(t: &Chair) -> anyhow::Result<u64> {
    Ok(t.worker.view_block().await?.timestamp() / 1_000_000)
}

/// Fast-forward until the next boundary is `LEAD_MS` away, within about a block. Jumps while the gap is more
/// than one jump can close, then waits: chain time follows the wall clock between jumps.
async fn approach_boundary(t: &Chair) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let ends = t.policy().await?.epoch_ends_ms;
            let gap = (ends as i64) - (block_ms(t).await? as i64) - LEAD_MS as i64;
            if gap.abs() < 400 {
                return anyhow::Ok(());
            }
            anyhow::ensure!(gap > 0, "overshot the boundary by {} ms", -gap);
            if gap > (JUMP_BLOCKS * 400) as i64 {
                t.jump().await?;
            } else {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("never got within a block of the boundary"))?
}

#[tokio::test]
async fn a_refund_across_an_impeaching_boundary_fits_the_resolvers_budget() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    // Epoch 0: the chair eases, so the boundary mints; nothing is nominated yet, so nothing impeaches.
    ensure_success(&t.set_policy(&chair, 50).await?)?;
    t.advance_to_epoch(1).await?;
    // Epoch 1: the chair is silent (a decay at the next boundary) and ten nominations are up, the
    // first with 200 tokens behind it (an impeachment at the next boundary, ten bond refunds).
    let nominators = full_candidate_list(&t).await?;
    assert_eq!(t.candidates().await?.len(), 10);

    let delay = t.user("delay", 0).await?;
    delay
        .deploy(&delaying_receiver(HOPS))
        .await?
        .into_result()?;
    let sender_before = t.balance(&t.alice).await?;
    let mut bonds_before = Vec::new();
    for nominator in &nominators {
        bonds_before.push(t.near_balance(nominator).await?);
    }

    approach_boundary(&t).await?;
    let result = t
        .call(
            &t.alice,
            "ft_transfer_call",
            json!({ "receiver_id": delay.id(), "amount": TOKEN.to_string(), "msg": "" }),
            1,
        )
        .await?;
    // The call ends well after the boundary: the resolver ran in the next epoch and rolled it.
    anyhow::ensure!(
        t.policy().await?.epoch >= 2,
        "the boundary did not fall inside the call"
    );
    let logged = events(&result);
    let rolled_in_resolver = logged
        .iter()
        .any(|e| e["standard"] == "chair" && e["event"] == "impeached");
    assert!(
        rolled_in_resolver,
        "the resolver did not apply the impeachment: {:?}",
        result.logs()
    );

    // The sender got everything back and the receiver kept nothing.
    assert_eq!(t.balance(&t.alice).await?, sender_before);
    assert_eq!(t.balance(&delay).await?, 0);
    for (nominator, before) in nominators.iter().zip(bonds_before) {
        let gained = t.near_balance(nominator).await? - before;
        assert_eq!(
            gained,
            NOMINATE_BOND,
            "{} got its bond back",
            nominator.id()
        );
    }
    assert!(t.candidates().await?.is_empty());

    // The resolver is the last receipt the token executed; it burnt less than half its budget.
    let receipts = token_receipts(&t, &result);
    let resolver = *receipts.last().unwrap();
    println!("resolver receipt burnt {} Tgas", resolver as f64 / 1e12);
    assert!(
        resolver < RESOLVER_BUDGET_TGAS * 1_000_000_000_000 / 2,
        "the resolver burnt {resolver} of {RESOLVER_BUDGET_TGAS} Tgas"
    );
    t.assert_supply_invariant(&[&t.alice, &chair, &delay]).await
}

#[tokio::test]
async fn the_worst_rollover_ever_possible_leaves_room_in_the_resolvers_budget() -> anyhow::Result<()>
{
    // The heaviest roll: rate +200, the chair silent for five epochs, so one call applies five mints, four
    // decays and an impeachment (which ends the vote) with ten bond refunds. A resolver that a receiver
    // delayed that long would run exactly this before refunding.
    let t = launch(EPOCH_MS).await?;
    let chair = t.scoped_chair().await?;
    let sender = t.user("sender", 10).await?;
    let receiver = t.user("receiver", 0).await?;
    for (epoch, rate) in [(0, 50), (1, 100), (2, 150), (3, 200)] {
        t.advance_to_epoch(epoch).await?;
        ensure_success(&t.set_policy(&chair, rate).await?)?;
    }
    full_candidate_list(&t).await?;
    let quiet = t.transfer(&sender, &receiver, TOKEN).await?;
    ensure_success(&quiet)?;
    let quiet = token_receipts(&t, &quiet)[0];

    // The resolver's own cost without any boundary: a refund of a failed call.
    let plain = t
        .call(
            &sender,
            "ft_transfer_call",
            json!({ "receiver_id": receiver.id(), "amount": TOKEN.to_string(), "msg": "" }),
            1,
        )
        .await?;
    let resolver_alone = *token_receipts(&t, &plain).last().unwrap();

    t.advance_to_epoch(8).await?;
    let worst = t.transfer(&sender, &receiver, TOKEN).await?;
    ensure_success(&worst)?;
    let logged = events(&worst);
    let count = |name: &str| {
        logged
            .iter()
            .filter(|e| e["standard"] == "chair" && e["event"] == name)
            .count()
    };
    assert_eq!(
        (
            count("epoch_minted"),
            count("rate_decayed"),
            count("impeached")
        ),
        (5, 4, 1)
    );
    assert_eq!(count("nomination_withdrawn"), 10);
    let roll = token_receipts(&t, &worst)[0] - quiet;
    println!(
        "worst-case roll {} Tgas, resolver alone {} Tgas",
        roll as f64 / 1e12,
        resolver_alone as f64 / 1e12
    );
    assert!(
        (roll + resolver_alone) * 2 <= RESOLVER_BUDGET_TGAS * 1_000_000_000_000,
        "roll {roll} + resolver {resolver_alone} is over half of {RESOLVER_BUDGET_TGAS} Tgas"
    );
    Ok(())
}

#[tokio::test]
async fn ft_transfer_call_needs_the_resolvers_reserve_or_fails_before_anything_moves()
-> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let receiver = t.user("receiver", 0).await?;
    let before = t.balance(&t.alice).await?;
    let call = |tgas: u64| {
        t.alice
            .call(t.token.id(), "ft_transfer_call")
            .args_json(
                json!({ "receiver_id": receiver.id(), "amount": TOKEN.to_string(), "msg": "" }),
            )
            .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
            .gas(near_workspaces::types::Gas::from_tgas(tgas))
            .transact()
    };
    let short = call(25).await?;
    assert!(
        short.is_failure(),
        "25 Tgas cannot reserve the resolver's 30"
    );
    assert_eq!(t.balance(&t.alice).await?, before);
    assert_eq!(t.balance(&receiver).await?, 0);

    // 35 Tgas is enough for the call, the reserve and a receiver that does nothing; the transfer is
    // refunded in full because the receiver (an account with no contract) fails.
    let enough = call(35).await?;
    assert!(enough.is_success(), "{}", failure_text(&enough));
    assert_eq!(t.balance(&t.alice).await?, before);
    assert_eq!(t.balance(&receiver).await?, 0);
    t.assert_supply_invariant(&[&t.alice, &receiver]).await
}
