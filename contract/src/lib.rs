//! $CHAIR: a NEP-141 token whose monetary policy is set each epoch by a chair on a short leash.
//! SPEC.md is the interface contract; this file holds the state, `new`, the chair's one call and the views.

mod events;
mod policy;
mod token;

use events::ChairEvent;
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};
use policy::{MAX_RATE_BPS, MAX_STEP_BPS, PolicyState, epoch_at};

/// Epochs shorter than a few blocks make the clock meaningless.
const MIN_EPOCH_MS: u64 = 1_000;
/// A year; keeps `start_ms + epochs * epoch_ms` far inside `u64`.
const MAX_EPOCH_MS: u64 = 365 * 24 * 3_600 * 1_000;
/// Keeps `total_supply * MAX_RATE_BPS` far inside `u128` for the mint math.
const MAX_TOTAL_SUPPLY: u128 = u128::MAX / 10_000;
const MAX_REASONING_HASH_LEN: usize = 128;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    FungibleToken,
}

/// Every launch parameter, as returned by `get_params`. Set once in `new`; no method changes them.
#[near(serializers = [json])]
pub struct Params {
    pub epoch_ms: u64,
    /// Block time at `new`; epoch 0 starts here.
    pub start_ms: u64,
    pub max_rate_bps: i32,
    pub max_step_bps: i32,
    pub impeach_threshold_bps: u32,
    pub nominate_bond: U128,
}

/// The policy as of the latest block, with any pending missed-epoch decay already applied.
#[near(serializers = [json])]
pub struct PolicyView {
    pub epoch: u64,
    pub rate_bps: i32,
    pub chair: AccountId,
    /// Complete epochs the sitting chair has survived.
    pub streak: u64,
    pub last_set_epoch: Option<u64>,
    /// When the current epoch ends and the next one may take a new `set_policy`.
    pub epoch_ends_ms: u64,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    pub(crate) token: FungibleToken,
    epoch_ms: u64,
    start_ms: u64,
    impeach_threshold_bps: u32,
    nominate_bond: U128,
    policy: PolicyState,
    chair: AccountId,
    /// Epoch in which the sitting chair took office; the streak is measured from here.
    chair_since_epoch: u64,
}

#[near]
impl Contract {
    /// Launch the token. `total_supply` goes to `owner_id`; `chair` is the first chair.
    /// There is no admin: nothing below can be changed after this call, and the contract has no upgrade path.
    #[init]
    pub fn new(
        owner_id: AccountId,
        total_supply: U128,
        chair: AccountId,
        epoch_ms: u64,
        impeach_threshold_bps: u32,
        nominate_bond: U128,
    ) -> Self {
        require!(
            total_supply.0 > 0 && total_supply.0 <= MAX_TOTAL_SUPPLY,
            "total_supply must be in 1..=u128::MAX/10000"
        );
        require!(
            (MIN_EPOCH_MS..=MAX_EPOCH_MS).contains(&epoch_ms),
            "epoch_ms must be in 1000..=31536000000"
        );
        require!(
            (1..=10_000).contains(&impeach_threshold_bps),
            "impeach_threshold_bps must be in 1..=10000"
        );
        require!(nominate_bond.0 > 0, "nominate_bond must be positive");

        let mut token = FungibleToken::new(StorageKey::FungibleToken);
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &owner_id,
            amount: total_supply,
            memo: Some("launch"),
        }
        .emit();

        Self {
            token,
            epoch_ms,
            start_ms: env::block_timestamp_ms(),
            impeach_threshold_bps,
            nominate_bond,
            policy: PolicyState::new(),
            chair,
            chair_since_epoch: 0,
        }
    }

    /// The chair's decision for the current epoch: a rate within the hard bounds, and the hash of the
    /// reasoning behind it. Panics unless the caller is the chair, the epoch has no decision yet, the
    /// rate is within `-200..=200` and within 50 bps of the rate in effect.
    pub fn set_policy(&mut self, rate_bps: i32, reasoning_hash: String) {
        let caller = env::predecessor_account_id();
        require!(caller == self.chair, "only the chair may set policy");
        require!(
            !reasoning_hash.is_empty() && reasoning_hash.len() <= MAX_REASONING_HASH_LEN,
            "reasoning_hash must be 1..=128 bytes"
        );

        // Validate on a copy and emit only once the call can no longer panic: a failed
        // receipt keeps its logs, and an indexer must never see an event for a decision that reverted.
        let epoch = self.current_epoch();
        let mut next = self.policy.clone();
        let decays = next.advance_to(epoch);
        let previous_rate_bps = next
            .set_rate(epoch, rate_bps)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        self.policy = next;

        for d in decays {
            ChairEvent::RateDecayed {
                epoch: d.epoch,
                previous_rate_bps: d.previous_rate_bps,
                rate_bps: d.rate_bps,
            }
            .emit();
        }
        ChairEvent::PolicySet {
            chair: caller,
            epoch,
            rate_bps,
            previous_rate_bps,
            reasoning_hash,
        }
        .emit();
    }

    pub fn get_params(&self) -> Params {
        Params {
            epoch_ms: self.epoch_ms,
            start_ms: self.start_ms,
            max_rate_bps: MAX_RATE_BPS,
            max_step_bps: MAX_STEP_BPS,
            impeach_threshold_bps: self.impeach_threshold_bps,
            nominate_bond: self.nominate_bond,
        }
    }

    pub fn get_policy(&self) -> PolicyView {
        let epoch = self.current_epoch();
        let mut policy = self.policy.clone();
        policy.advance_to(epoch);
        PolicyView {
            epoch,
            rate_bps: policy.rate_bps,
            chair: self.chair.clone(),
            streak: epoch - self.chair_since_epoch,
            last_set_epoch: policy.last_set_epoch,
            epoch_ends_ms: self.start_ms + (epoch + 1) * self.epoch_ms,
        }
    }
}

impl Contract {
    fn current_epoch(&self) -> u64 {
        epoch_at(env::block_timestamp_ms(), self.start_ms, self.epoch_ms)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::FungibleTokenCore;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    const EPOCH_MS: u64 = 60_000;
    const T0_MS: u64 = 1_700_000_000_000;

    fn at_ms(ms: u64) {
        testing_env!(
            VMContextBuilder::new()
                .block_timestamp(ms * 1_000_000)
                .build()
        );
    }

    fn launch(total_supply: u128, epoch_ms: u64, threshold_bps: u32, bond: u128) -> Contract {
        at_ms(T0_MS);
        Contract::new(
            accounts(0),
            total_supply.into(),
            accounts(1),
            epoch_ms,
            threshold_bps,
            bond.into(),
        )
    }

    #[test]
    fn launch_parameters_are_recorded_and_the_supply_goes_to_the_owner() {
        let c = launch(1_000, EPOCH_MS, 3_000, 7);
        let params = c.get_params();
        assert_eq!((params.epoch_ms, params.start_ms), (EPOCH_MS, T0_MS));
        assert_eq!((params.max_rate_bps, params.max_step_bps), (200, 50));
        assert_eq!(
            (params.impeach_threshold_bps, params.nominate_bond.0),
            (3_000, 7)
        );
        assert_eq!(c.token.ft_balance_of(accounts(0)).0, 1_000);
    }

    #[test]
    #[should_panic(expected = "total_supply must be in")]
    fn zero_supply_is_rejected() {
        launch(0, EPOCH_MS, 3_000, 1);
    }

    #[test]
    #[should_panic(expected = "total_supply must be in")]
    fn a_supply_that_could_overflow_the_mint_math_is_rejected() {
        launch(MAX_TOTAL_SUPPLY + 1, EPOCH_MS, 3_000, 1);
    }

    #[test]
    #[should_panic(expected = "epoch_ms must be in")]
    fn an_epoch_shorter_than_a_second_is_rejected() {
        launch(1_000, MIN_EPOCH_MS - 1, 3_000, 1);
    }

    #[test]
    #[should_panic(expected = "epoch_ms must be in")]
    fn an_epoch_longer_than_a_year_is_rejected() {
        launch(1_000, MAX_EPOCH_MS + 1, 3_000, 1);
    }

    #[test]
    #[should_panic(expected = "impeach_threshold_bps must be in")]
    fn a_threshold_above_100_percent_is_rejected() {
        launch(1_000, EPOCH_MS, 10_001, 1);
    }

    #[test]
    #[should_panic(expected = "nominate_bond must be positive")]
    fn a_free_nomination_is_rejected() {
        launch(1_000, EPOCH_MS, 3_000, 0);
    }

    #[test]
    fn policy_view_follows_the_clock_and_streak_counts_complete_epochs() {
        let c = launch(1_000, EPOCH_MS, 3_000, 1);
        for (now_ms, epoch) in [
            (T0_MS, 0),
            (T0_MS + EPOCH_MS - 1, 0),
            (T0_MS + EPOCH_MS, 1),
            (T0_MS + 3 * EPOCH_MS + 5, 3),
        ] {
            at_ms(now_ms);
            let view = c.get_policy();
            assert_eq!((view.epoch, view.streak), (epoch, epoch));
            assert_eq!(view.epoch_ends_ms, T0_MS + (epoch + 1) * EPOCH_MS);
            assert_eq!((view.rate_bps, view.chair.clone()), (0, accounts(1)));
        }
    }
}
