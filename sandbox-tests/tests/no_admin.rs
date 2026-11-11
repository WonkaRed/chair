//! The chair seat belongs to the holders and nothing else: after `new` nobody, the deployer included,
//! can set, replace or remove the chair or change a parameter. Proven against the deployed wasm.

use near_workspaces::Account;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use sandbox_tests::{Chair, NOMINATE_BOND, exported_methods, failure_text, launch};
use serde_json::{Value, json};

const EPOCH_MS: u64 = 120_000;

/// Every function the contract exports, by what it is. A new export fails the first test until it is
/// classified here, which is the point: nothing gets added to the surface unseen.
const VIEWS: &[&str] = &[
    "contract_source_metadata",
    "ft_balance_of",
    "ft_metadata",
    "ft_total_supply",
    "get_candidates",
    "get_params",
    "get_policy",
    "get_reward_pool",
    "get_staking",
    "get_supply",
    "storage_balance_bounds",
    "storage_balance_of",
];
/// Open to everyone and acting only on the caller's own tokens, stake, vote or nomination.
const CALLER_ONLY: &[&str] = &[
    "back",
    "claim",
    "ft_transfer",
    "ft_transfer_call",
    "nominate",
    "stake",
    "storage_deposit",
    "storage_unregister",
    "storage_withdraw",
    "unback",
    "unstake",
    "withdraw_nomination",
];
/// `set_policy` is the chair's one call; `new` is the initializer; the resolver is private.
const GATED: &[&str] = &["ft_resolve_transfer", "new", "set_policy"];

/// Names an admin interface would use. None is exported.
const ADMIN_NAMES: &[&str] = &[
    "set_chair",
    "replace_chair",
    "remove_chair",
    "impeach",
    "set_owner",
    "transfer_ownership",
    "set_params",
    "update_params",
    "set_epoch_ms",
    "set_max_rate_bps",
    "set_threshold",
    "set_rate",
    "mint",
    "burn",
    "withdraw",
    "pause",
    "unpause",
    "upgrade",
    "update_contract",
    "migrate",
    "add_admin",
    "set_metadata",
];

async fn snapshot(t: &Chair) -> anyhow::Result<[Value; 3]> {
    Ok([
        t.token.view("get_params").await?.json()?,
        t.token.view("get_policy").await?.json()?,
        t.token.view("get_supply").await?.json()?,
    ])
}

async fn probe(
    who: &Account,
    t: &Chair,
    method: &str,
    args: Value,
    deposit_yocto: u128,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(who
        .call(t.token.id(), method)
        .args_json(args)
        .deposit(NearToken::from_yoctonear(deposit_yocto))
        .max_gas()
        .transact()
        .await?)
}

#[tokio::test]
async fn the_exported_surface_has_no_admin_and_nothing_the_deployer_can_use() -> anyhow::Result<()>
{
    let t = launch(EPOCH_MS).await?;
    let root = t.worker.root_account()?;
    let code = t.token.view_code().await?;

    // The surface is closed and fully classified.
    let mut expected: Vec<&str> = [VIEWS, CALLER_ONLY, GATED].concat();
    expected.sort_unstable();
    let mut exported = exported_methods(&code)?;
    exported.sort_unstable();
    assert_eq!(
        exported, expected,
        "the deployed wasm exports a method the test does not know"
    );

    // Every name an admin interface would use is absent, for the owner and the deployer alike.
    let before = snapshot(&t).await?;
    for who in [&root, &t.alice] {
        for name in ADMIN_NAMES {
            assert!(!exported.iter().any(|m| m == name), "{name} is exported");
            let result = probe(who, &t, name, json!({}), 1).await?;
            assert!(
                result.is_failure() && failure_text(&result).contains("MethodNotFound"),
                "{name} as {}: {}",
                who.id(),
                failure_text(&result)
            );
        }
    }

    // The three gated methods refuse the owner and the deployer.
    for who in [&root, &t.alice] {
        let relaunch = probe(
            who,
            &t,
            "new",
            json!({
                "owner_id": who.id(), "total_supply": "1", "chair": who.id(), "epoch_ms": 1_000,
                "impeach_threshold_bps": 1, "nominate_bond": "1",
            }),
            0,
        )
        .await?;
        assert!(
            failure_text(&relaunch).contains("already been initialized"),
            "{}",
            failure_text(&relaunch)
        );
        let seize = probe(
            who,
            &t,
            "set_policy",
            json!({ "rate_bps": 50, "reasoning_hash": "ab".repeat(32) }),
            0,
        )
        .await?;
        assert!(
            failure_text(&seize).contains("only the chair may set policy"),
            "{}",
            failure_text(&seize)
        );
        let resolver = probe(
            who,
            &t,
            "ft_resolve_transfer",
            json!({ "sender_id": who.id(), "receiver_id": t.chair.id(), "amount": "1" }),
            0,
        )
        .await?;
        assert!(
            failure_text(&resolver).contains("is private"),
            "{}",
            failure_text(&resolver)
        );
    }

    // Anyone can nominate, but a non-holder cannot turn that into a vote: only staked tokens back.
    let nominated = t.nominate(&root, &root, NOMINATE_BOND).await?;
    assert!(
        nominated.is_success(),
        "nominating is open: {}",
        failure_text(&nominated)
    );
    let backed = t.back(&root, &root).await?;
    assert!(
        failure_text(&backed).contains("stake first"),
        "{}",
        failure_text(&backed)
    );

    let after = snapshot(&t).await?;
    assert_eq!(before, after, "parameters, chair, rate or supply moved");
    t.assert_supply_invariant(&[&t.alice, &t.chair]).await
}

#[tokio::test]
async fn the_token_account_never_had_a_key_so_no_key_signs_for_it() -> anyhow::Result<()> {
    let t = launch(EPOCH_MS).await?;
    let root = t.worker.root_account()?;
    assert!(
        t.token.view_access_keys().await?.is_empty(),
        "the token account still has an access key"
    );

    // Any key claiming to be the account is refused by the chain for every kind of action.
    let old = Account::from_secret_key(
        t.token.id().clone(),
        SecretKey::from_random(KeyType::ED25519),
        &t.worker,
    );
    let code_before = t.token.view_code().await?;
    let balance_before = t.near_balance(t.token.as_account()).await?;
    let attempts = [
        (
            "redeploy",
            old.batch(old.id())
                .deploy(&[0x00, 0x61, 0x73, 0x6d])
                .transact()
                .await,
        ),
        (
            "add a key",
            old.batch(old.id())
                .add_key(root.secret_key().public_key(), AccessKey::full_access())
                .transact()
                .await,
        ),
        (
            "move its NEAR",
            old.transfer_near(root.id(), NearToken::from_near(1)).await,
        ),
        (
            "set the chair's policy",
            old.call(old.id(), "set_policy")
                .args_json(json!({ "rate_bps": 50, "reasoning_hash": "ab".repeat(32) }))
                .transact()
                .await,
        ),
    ];
    for (what, outcome) in attempts {
        let error = match outcome {
            Err(e) => format!("{e:?}"),
            Ok(result) => {
                assert!(result.is_failure(), "{what} was accepted");
                failure_text(&result)
            }
        };
        assert!(
            error.contains("AccessKeyNotFound") || error.contains("access key"),
            "{what}: {error}"
        );
    }
    assert_eq!(t.token.view_code().await?, code_before);
    // Late refunds can only add to the balance; a moved NEAR would subtract.
    assert!(t.near_balance(t.token.as_account()).await? >= balance_before);
    Ok(())
}
