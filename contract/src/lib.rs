//! $CHAIR: a NEP-141 token whose monetary policy is set each epoch by a chair on a short leash.
//! SPEC.md is the interface contract; this file holds the state, `new`, the chair's one call, the
//! rollover entry points and the policy views. Staking, voting and the transfer burn have their own modules.

mod events;
mod policy;
mod rollover;
mod staking;
mod token;
mod voting;

use events::ChairEvent;
use near_contract_standards::fungible_token::FungibleToken;
use near_sdk::collections::LookupMap;
use near_sdk::json_types::U128;
use near_sdk::{AccountId, BorshStorageKey, PanicOnDefault, env, near, require};
use policy::{MAX_RATE_BPS, MAX_STEP_BPS, PolicyState, epoch_at, is_sha256_hex, meetings_per_day};
use rollover::{Advance, EpochState, QUORUM_BPS};
use staking::{RewardIndex, Staker};
use voting::Candidate;

/// Epochs shorter than a few blocks make the clock meaningless.
const MIN_EPOCH_MS: u64 = 1_000;
/// A year; keeps `start_ms + epochs * epoch_ms` far inside `u64`.
const MAX_EPOCH_MS: u64 = 365 * 24 * 3_600 * 1_000;
/// Keeps `total_supply * MAX_RATE_BPS` far inside `u128` for the mint math.
const MAX_TOTAL_SUPPLY: u128 = u128::MAX / 10_000;
/// Above half of the stake a majority could not remove the chair, and at 10_000 no one could: the vote
/// must always be able to remove a chair, so `new` refuses it.
const MAX_IMPEACH_THRESHOLD_BPS: u32 = 5_000;
/// 100 NEAR in yoctoNEAR. A bond no one can afford would close the candidate list to everyone.
const MAX_NOMINATE_BOND: u128 = 100_000_000_000_000_000_000_000_000;
/// Longest `persona_hash` a nomination may carry; the format is the nominator's to choose.
const MAX_PERSONA_HASH_LEN: usize = 128;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    FungibleToken,
    Stakers,
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
    /// A candidate also needs backing over this share of the whole supply (not only of the stake).
    pub quorum_bps: u32,
    pub nominate_bond: U128,
    /// Epochs in a day, derived from `epoch_ms` (960 at 90 s): an easing rate is per day, spread over this many epochs.
    pub meetings_per_day: u64,
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

/// Every token ever created or destroyed, with the supply they leave, as of the latest block.
/// `total_supply == launch_supply + minted - burned` always. The per-event log is in the `epoch_minted`
/// and `transfer_burned` events (SPEC.md "Events").
#[near(serializers = [json])]
pub struct SupplyLedger {
    pub epoch: u64,
    /// Minted to the owner by `new`.
    pub launch_supply: U128,
    /// Minted by easing epochs, including mints that are due but not yet applied.
    pub minted: U128,
    /// Destroyed by the transfer burn, by a forced `storage_unregister`, and by a `ft_transfer_call`
    /// refund whose sender unregistered mid-call.
    pub burned: U128,
    pub total_supply: U128,
    pub total_staked: U128,
    /// Minted for stakers and not yet claimed.
    pub reward_pool: U128,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    /// Its `total_supply` is the whole supply: liquid balances, stake and the reward pool together.
    /// Staking and claiming move tokens between those without touching it; only the mint and the burn do.
    pub(crate) token: FungibleToken,
    launch_supply: u128,
    /// Everything destroyed since launch.
    pub(crate) burned: u128,
    epoch_ms: u64,
    start_ms: u64,
    impeach_threshold_bps: u32,
    nominate_bond: U128,
    policy: PolicyState,
    chair: AccountId,
    /// Epoch in which the sitting chair took office; the streak is measured from here.
    chair_since_epoch: u64,
    stakers: LookupMap<AccountId, Staker>,
    total_staked: u128,
    /// Minted for stakers and not yet claimed.
    reward_pool: u128,
    reward_per_share: RewardIndex,
    /// Live nominations, oldest first, at most `MAX_CANDIDATES`.
    candidates: Vec<Candidate>,
    /// Id of the next nomination; starts at 1 so that 0 can mean "none" in `Staker::backing_id`.
    next_candidate_id: u64,
}

#[near]
impl Contract {
    /// Launch the token. `total_supply` goes to `owner_id`; `chair` is the first chair.
    /// There is no admin: nothing below can be changed after this call, and the contract has no upgrade path.
    /// Anyone can call this on a deployed, uninitialized contract, so deploy and `new` must be one
    /// transaction (SPEC.md "Deploying").
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
            (1..=MAX_IMPEACH_THRESHOLD_BPS).contains(&impeach_threshold_bps),
            "impeach_threshold_bps must be in 1..=5000"
        );
        require!(
            (1..=MAX_NOMINATE_BOND).contains(&nominate_bond.0),
            "nominate_bond must be in 1..=100 NEAR (10^26 yoctoNEAR)"
        );
        // The token account has no key and no method moves tokens out of it, so a supply launched there
        // could never be staked or voted with.
        require!(
            owner_id != env::current_account_id(),
            "owner_id must not be the token account itself: nobody could ever move the supply"
        );

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
            launch_supply: total_supply.0,
            burned: 0,
            epoch_ms,
            start_ms: env::block_timestamp_ms(),
            impeach_threshold_bps,
            nominate_bond,
            policy: PolicyState::new(),
            chair,
            chair_since_epoch: 0,
            stakers: LookupMap::new(StorageKey::Stakers),
            total_staked: 0,
            reward_pool: 0,
            reward_per_share: RewardIndex::default(),
            candidates: Vec::new(),
            next_candidate_id: 1,
        }
    }

    /// The chair's decision for the current epoch: a rate within the hard bounds, and the hash of the
    /// reasoning behind it (lowercase SHA-256 hex). Panics unless the caller is the chair, the epoch has no decision yet, the
    /// rate is within `-200..=200` and within 50 bps of the rate in effect. Rolls the epoch first, so
    /// a chair impeached at the last boundary is refused and the new chair is accepted.
    pub fn set_policy(&mut self, rate_bps: i32, reasoning_hash: String) {
        // A panic reverts the state this changes; events are only logged once no panic is left, so a
        // reverted call never leaves one in the logs.
        let mut events = self.roll();
        let caller = env::predecessor_account_id();
        require!(caller == self.chair, "only the chair may set policy");
        require!(
            is_sha256_hex(&reasoning_hash),
            "reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters"
        );

        let epoch = self.policy.epoch;
        let previous_rate_bps = self
            .policy
            .set_rate(epoch, rate_bps)
            .unwrap_or_else(|e| env::panic_str(&e.to_string()));
        events.push(ChairEvent::PolicySet {
            chair: caller,
            epoch,
            rate_bps,
            previous_rate_bps,
            reasoning_hash,
        });
        ChairEvent::emit_all(events);
    }

    pub fn get_params(&self) -> Params {
        Params {
            epoch_ms: self.epoch_ms,
            start_ms: self.start_ms,
            max_rate_bps: MAX_RATE_BPS,
            max_step_bps: MAX_STEP_BPS,
            impeach_threshold_bps: self.impeach_threshold_bps,
            quorum_bps: QUORUM_BPS,
            nominate_bond: self.nominate_bond,
            meetings_per_day: meetings_per_day(self.epoch_ms),
        }
    }

    pub fn get_supply(&self) -> SupplyLedger {
        let (state, _) = self.project();
        SupplyLedger {
            epoch: state.policy.epoch,
            launch_supply: self.launch_supply.into(),
            minted: (state.total_supply + self.burned - self.launch_supply).into(),
            burned: self.burned.into(),
            total_supply: state.total_supply.into(),
            total_staked: state.total_staked.into(),
            reward_pool: state.reward_pool.into(),
        }
    }

    pub fn get_policy(&self) -> PolicyView {
        let (state, _) = self.project();
        let epoch = state.policy.epoch;
        PolicyView {
            epoch,
            rate_bps: state.policy.rate_bps,
            chair: state.chair,
            streak: epoch - state.chair_since_epoch,
            last_set_epoch: state.policy.last_set_epoch,
            epoch_ends_ms: self.start_ms + (epoch + 1) * self.epoch_ms,
        }
    }
}

impl Contract {
    fn current_epoch(&self) -> u64 {
        epoch_at(env::block_timestamp_ms(), self.start_ms, self.epoch_ms)
    }

    /// The state as it would stand after every boundary up to the latest block time, without writing.
    /// Views read this; `roll` applies it.
    pub(crate) fn project(&self) -> (EpochState, Advance) {
        let mut state = EpochState {
            policy: self.policy.clone(),
            chair: self.chair.clone(),
            chair_since_epoch: self.chair_since_epoch,
            total_supply: self.token.total_supply,
            total_staked: self.total_staked,
            reward_pool: self.reward_pool,
            reward_per_share: self.reward_per_share,
            meetings_per_day: meetings_per_day(self.epoch_ms),
        };
        let advance = state.advance_to(
            self.current_epoch(),
            self.impeach_threshold_bps,
            &self.candidates,
        );
        (state, advance)
    }

    /// Apply every pending epoch boundary (SPEC.md "Epochs and rollover"). Every method that reads or
    /// changes the rate, the stake, the backing or the chair calls this first, so a boundary always sees
    /// the state as it stood at that boundary. Returns the events to log once the call cannot panic.
    pub(crate) fn roll(&mut self) -> Vec<ChairEvent> {
        let (state, mut advance) = self.project();
        self.policy = state.policy;
        self.chair = state.chair;
        self.chair_since_epoch = state.chair_since_epoch;
        self.token.total_supply = state.total_supply;
        self.reward_pool = state.reward_pool;
        self.reward_per_share = state.reward_per_share;
        if advance.impeached {
            // Backings die with their ids; only the bonds need returning.
            for nomination in std::mem::take(&mut self.candidates) {
                advance.events.push(self.refund_bond(nomination));
            }
        }
        advance.events
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use near_contract_standards::fungible_token::FungibleTokenCore;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::{NearToken, testing_env};

    const EPOCH_MS: u64 = 60_000;
    const T0_MS: u64 = 1_700_000_000_000;
    const TOKEN_ACCOUNT: &str = "token.near";

    fn at_ms(ms: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(TOKEN_ACCOUNT.parse().unwrap())
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
            (
                params.impeach_threshold_bps,
                params.quorum_bps,
                params.nominate_bond.0
            ),
            (3_000, 500, 7)
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
    #[should_panic(expected = "impeach_threshold_bps must be in 1..=5000")]
    fn a_threshold_above_half_the_stake_is_rejected() {
        launch(1_000, EPOCH_MS, MAX_IMPEACH_THRESHOLD_BPS + 1, 1);
    }

    #[test]
    #[should_panic(expected = "impeach_threshold_bps must be in 1..=5000")]
    fn a_zero_threshold_is_rejected() {
        launch(1_000, EPOCH_MS, 0, 1);
    }

    #[test]
    fn a_threshold_of_exactly_half_the_stake_is_accepted() {
        let c = launch(1_000, EPOCH_MS, MAX_IMPEACH_THRESHOLD_BPS, 1);
        assert_eq!(c.get_params().impeach_threshold_bps, 5_000);
    }

    #[test]
    #[should_panic(expected = "nominate_bond must be in 1..=100 NEAR")]
    fn a_free_nomination_is_rejected() {
        launch(1_000, EPOCH_MS, 3_000, 0);
    }

    #[test]
    #[should_panic(expected = "nominate_bond must be in 1..=100 NEAR")]
    fn a_bond_above_100_near_is_rejected() {
        launch(1_000, EPOCH_MS, 3_000, MAX_NOMINATE_BOND + 1);
    }

    #[test]
    #[should_panic(expected = "owner_id must not be the token account itself")]
    fn a_supply_launched_to_the_token_account_itself_is_rejected() {
        at_ms(T0_MS);
        Contract::new(
            TOKEN_ACCOUNT.parse().unwrap(),
            1_000.into(),
            accounts(1),
            EPOCH_MS,
            3_000,
            1.into(),
        );
    }

    #[test]
    fn a_bond_of_exactly_100_near_is_accepted() {
        let c = launch(1_000, EPOCH_MS, 3_000, MAX_NOMINATE_BOND);
        assert_eq!(c.get_params().nominate_bond.0, MAX_NOMINATE_BOND);
    }

    /// A contract with one live nomination (id 7) of `accounts(4)` by `accounts(2)`, and `backers` staking
    /// and backing it; the candidate's backing is their total. Returns it, ready to be called as `caller`.
    fn nominated_and_backed_by(backers: &[(AccountId, u128)], caller: AccountId) -> Contract {
        let mut c = launch(1_000, EPOCH_MS, 3_000, 1);
        let mut backing = 0;
        for (account, staked) in backers {
            let mut staker = Staker::new(c.reward_per_share);
            (staker.staked, staker.backing_id) = (*staked, 7);
            c.stakers.insert(account, &staker);
            c.total_staked += staked;
            backing += staked;
        }
        c.candidates.push(Candidate {
            id: 7,
            candidate: accounts(4),
            nominator: accounts(2),
            persona_hash: "ab".repeat(32),
            bond: 1,
            backing,
        });
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(TOKEN_ACCOUNT.parse().unwrap())
                .predecessor_account_id(caller)
                .attached_deposit(NearToken::from_yoctonear(1))
                .block_timestamp(T0_MS * 1_000_000)
                .build()
        );
        c
    }

    #[test]
    #[should_panic(expected = "other accounts back this candidate")]
    fn a_nomination_cannot_be_withdrawn_while_another_account_backs_it() {
        let mut c = nominated_and_backed_by(&[(accounts(2), 100), (accounts(3), 1)], accounts(2));
        c.withdraw_nomination(accounts(4));
    }

    #[test]
    #[should_panic(expected = "other accounts back this candidate")]
    fn a_nominator_whose_own_stake_backs_something_else_cannot_withdraw_a_backed_nomination() {
        let mut c = nominated_and_backed_by(&[(accounts(3), 50)], accounts(2));
        let mut staker = Staker::new(c.reward_per_share);
        (staker.staked, staker.backing_id) = (100, 3);
        c.stakers.insert(&accounts(2), &staker);
        c.withdraw_nomination(accounts(4));
    }

    #[test]
    #[should_panic(expected = "only the nominator may withdraw")]
    fn only_the_nominator_can_withdraw_a_nomination() {
        let mut c = nominated_and_backed_by(&[], accounts(3));
        c.withdraw_nomination(accounts(4));
    }

    #[test]
    fn an_unbacked_nomination_can_be_withdrawn() {
        let mut c = nominated_and_backed_by(&[], accounts(2));
        c.withdraw_nomination(accounts(4));
        assert!(c.candidates.is_empty());
    }

    #[test]
    fn a_nomination_backed_only_by_its_nominator_can_be_withdrawn() {
        let mut c = nominated_and_backed_by(&[(accounts(2), 100)], accounts(2));
        c.withdraw_nomination(accounts(4));
        assert!(c.candidates.is_empty());
    }

    #[test]
    fn a_zero_stake_backer_does_not_block_a_withdrawal() {
        let mut c = nominated_and_backed_by(&[(accounts(2), 100), (accounts(3), 0)], accounts(2));
        c.withdraw_nomination(accounts(4));
        assert!(c.candidates.is_empty());
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

    #[test]
    fn the_params_show_the_meetings_a_day_derived_from_the_epoch_length() {
        // 90 s epochs, the launch length, are exactly 960 a day (the rule for every length is in policy.rs).
        let c = launch(1_000, 90_000, 3_000, 1);
        assert_eq!(c.get_params().meetings_per_day, 960);
    }

    #[test]
    fn the_supply_ledger_starts_at_the_launch_supply_with_nothing_minted_or_burned() {
        let c = launch(1_000, EPOCH_MS, 3_000, 1);
        at_ms(T0_MS + 5 * EPOCH_MS);
        let ledger = c.get_supply();
        assert_eq!(ledger.epoch, 5);
        assert_eq!(
            (
                ledger.launch_supply.0,
                ledger.minted.0,
                ledger.burned.0,
                ledger.total_supply.0
            ),
            (1_000, 0, 0, 1_000)
        );
        assert_eq!((ledger.total_staked.0, ledger.reward_pool.0), (0, 0));
    }
}
