//! Staking and the reward index (SPEC.md "Staking"). The index is the standard reward-per-share
//! accumulator, so every call costs O(1) however many stakers there are: an epoch's mint is added to one
//! number, and each staker's share is worked out from it when that staker next touches the contract.

use crate::events::ChairEvent;
use crate::{Contract, ContractExt};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, assert_one_yocto, env, near, require};
use std::fmt;

/// The one generated type. The allow is for third-party macro output (the `uint` crate's code trips
/// `assign_op_pattern` and `manual_div_ceil`); nothing hand-written lives in this module.
#[allow(clippy::assign_op_pattern, clippy::manual_div_ceil)]
mod wide {
    use uint::construct_uint;

    construct_uint! {
        /// 256 bits: `minted * REWARD_SCALE` alone overflows `u128`.
        pub struct U256(4);
    }
}
use wide::U256;

/// Fixed-point scale of the reward index: one staked yocto is owed `index / REWARD_SCALE` yocto per unit of index.
pub const REWARD_SCALE: u128 = 1_000_000_000_000_000_000_000_000;

/// Stake is locked for this many epochs, counting the one it was staked in: stake in epoch `e`, unstake
/// from epoch `e + 2`. A stake therefore sits through at least one whole epoch boundary after the first
/// one it earns on, so staking just before a rollover and leaving just after it earns nothing for free.
pub const STAKE_LOCK_EPOCHS: u64 = 2;

/// Cumulative reward per staked yocto, times `REWARD_SCALE`. Monotonic. Held as four limbs so it
/// borsh-serializes; the arithmetic is `U256`.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RewardIndex([u64; 4]);

impl RewardIndex {
    /// Add one epoch's mint, shared over the stake that was in place at the boundary. Rounded down:
    /// the remainder stays in the reward pool and is never paid out. Needs `total_staked > 0`.
    pub fn accrue(&mut self, minted: u128, total_staked: u128) {
        let delta = U256::from(minted) * U256::from(REWARD_SCALE) / U256::from(total_staked);
        self.0 = (U256(self.0) + delta).0;
    }

    /// What `staked` earned while the index moved from `paid` to `self`, rounded down. The index never
    /// decreases, and `staked` was constant over the interval (a stake change settles first), so the
    /// result is at most the staker's share of what was minted and fits `u128`.
    pub fn owed(self, staked: u128, paid: RewardIndex) -> u128 {
        let gained = U256(self.0) - U256(paid.0);
        u128::try_from(U256::from(staked) * gained / U256::from(REWARD_SCALE))
            .expect("reward fits in u128")
    }
}

impl fmt::Display for RewardIndex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        U256(self.0).fmt(f)
    }
}

/// One account's stake. Fixed size, so no later call can grow the storage the first stake paid for.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staker {
    pub staked: u128,
    /// The index when `accrued` was last brought up to date.
    pub paid_per_share: RewardIndex,
    /// Reward earned before `paid_per_share` and not yet claimed.
    pub accrued: u128,
    /// First epoch in which `unstake` is allowed.
    pub unlock_epoch: u64,
    /// `Candidate::id` this stake backs; 0 for none. Ids are never reused, so a backing whose candidate
    /// was withdrawn or cleared by an impeachment is simply a dead id, with no sweep over stakers.
    pub backing_id: u64,
}

impl Staker {
    pub fn new(index: RewardIndex) -> Self {
        Self {
            staked: 0,
            paid_per_share: index,
            accrued: 0,
            unlock_epoch: 0,
            backing_id: 0,
        }
    }

    /// Bring `accrued` up to `index`. Call before `staked` changes.
    pub fn settle(&mut self, index: RewardIndex) {
        self.accrued += index.owed(self.staked, self.paid_per_share);
        self.paid_per_share = index;
    }

    /// Claimable now, without writing.
    pub fn pending(&self, index: RewardIndex) -> u128 {
        self.accrued + index.owed(self.staked, self.paid_per_share)
    }
}

#[near(serializers = [json])]
pub struct StakingView {
    pub staked: U128,
    pub pending_reward: U128,
    /// The candidate this stake backs, if the nomination is still live.
    pub backing: Option<AccountId>,
    /// First epoch in which `unstake` is allowed.
    pub unlock_epoch: u64,
}

#[near(serializers = [json])]
pub struct RewardPoolView {
    pub total_staked: U128,
    /// Minted and not yet claimed, including the rounding remainder that is never paid out.
    pub reward_pool: U128,
    /// Decimal string: the index does not fit a JSON number.
    pub reward_per_share: String,
}

#[near]
impl Contract {
    /// Move `amount` of the caller's liquid balance into stake. Attach 1 yoctoNEAR; the first stake of an
    /// account also pays for its stake record, and anything above that is refunded. Restarts the lock
    /// on the caller's whole stake. If the caller backs a candidate, the backing grows with the stake.
    #[payable]
    pub fn stake(&mut self, amount: U128) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= 1,
            "Requires attached deposit of at least 1 yoctoNEAR"
        );
        require!(amount.0 > 0, "amount must be positive");
        let mut events = self.roll();
        let account = env::predecessor_account_id();

        self.debit_liquid(&account, amount.0);
        let mut staker = self
            .stakers
            .get(&account)
            .unwrap_or_else(|| Staker::new(self.reward_per_share));
        staker.settle(self.reward_per_share);
        staker.staked += amount.0;
        staker.unlock_epoch = self.policy.epoch + STAKE_LOCK_EPOCHS;
        self.total_staked += amount.0;
        if let Some(backed) = self.backing_index(staker.backing_id) {
            self.candidates[backed].backing += amount.0;
            events.push(ChairEvent::Backed {
                account_id: account.clone(),
                candidate: self.candidates[backed].candidate.clone(),
                amount,
            });
        }

        // Storage growth is the caller's to pay: measure what the insert added and charge for it.
        let before = env::storage_usage();
        self.stakers.insert(&account, &staker);
        let grown = env::storage_usage().saturating_sub(before);
        let storage_cost = env::storage_byte_cost().as_yoctonear() * u128::from(grown);
        require!(
            deposit > storage_cost,
            format!(
                "First stake: attach {} yoctoNEAR to pay for the stake record",
                storage_cost + 1
            )
        );
        let refund = deposit - storage_cost - 1;
        if refund > 0 {
            Promise::new(account.clone())
                .transfer(NearToken::from_yoctonear(refund))
                .detach();
        }

        events.push(ChairEvent::Staked {
            account_id: account,
            amount,
            total_staked: self.total_staked.into(),
        });
        ChairEvent::emit_all(events);
    }

    /// Move `amount` of the caller's stake back to its liquid balance. Attach 1 yoctoNEAR. Allowed from
    /// the epoch `unlock_epoch` in `get_staking`. Pending reward stays claimable. If the caller backs a
    /// candidate, the backing shrinks with the stake, immediately.
    #[payable]
    pub fn unstake(&mut self, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "amount must be positive");
        let mut events = self.roll();
        let account = env::predecessor_account_id();

        let mut staker = self
            .stakers
            .get(&account)
            .unwrap_or_else(|| env::panic_str("no stake"));
        require!(
            amount.0 <= staker.staked,
            "amount exceeds the staked balance"
        );
        require!(
            self.policy.epoch >= staker.unlock_epoch,
            format!("stake is locked until epoch {}", staker.unlock_epoch)
        );
        staker.settle(self.reward_per_share);
        staker.staked -= amount.0;
        self.total_staked -= amount.0;
        if let Some(backed) = self.backing_index(staker.backing_id) {
            self.candidates[backed].backing -= amount.0;
            events.push(ChairEvent::Unbacked {
                account_id: account.clone(),
                candidate: self.candidates[backed].candidate.clone(),
                amount,
            });
        }
        self.stakers.insert(&account, &staker);
        self.credit_liquid(&account, amount.0);

        events.push(ChairEvent::Unstaked {
            account_id: account,
            amount,
            total_staked: self.total_staked.into(),
        });
        ChairEvent::emit_all(events);
    }

    /// Pay the caller's pending reward into its liquid balance and return the amount. Attach 1 yoctoNEAR.
    /// An internal move, not a transfer: the burn does not touch it.
    #[payable]
    pub fn claim(&mut self) -> U128 {
        assert_one_yocto();
        let mut events = self.roll();
        let account = env::predecessor_account_id();

        let mut staker = self
            .stakers
            .get(&account)
            .unwrap_or_else(|| env::panic_str("nothing to claim"));
        staker.settle(self.reward_per_share);
        let amount = std::mem::take(&mut staker.accrued);
        require!(amount > 0, "nothing to claim");
        self.reward_pool -= amount;
        self.stakers.insert(&account, &staker);
        self.credit_liquid(&account, amount);

        events.push(ChairEvent::Claimed {
            account_id: account,
            amount: amount.into(),
        });
        ChairEvent::emit_all(events);
        amount.into()
    }

    pub fn get_staking(&self, account_id: AccountId) -> StakingView {
        let (state, advance) = self.project();
        let Some(staker) = self.stakers.get(&account_id) else {
            return StakingView {
                staked: 0.into(),
                pending_reward: 0.into(),
                backing: None,
                unlock_epoch: 0,
            };
        };
        let backing = if advance.impeached {
            None
        } else {
            self.backing_index(staker.backing_id)
                .map(|i| self.candidates[i].candidate.clone())
        };
        StakingView {
            staked: staker.staked.into(),
            pending_reward: staker.pending(state.reward_per_share).into(),
            backing,
            unlock_epoch: staker.unlock_epoch,
        }
    }

    pub fn get_reward_pool(&self) -> RewardPoolView {
        let (state, _) = self.project();
        RewardPoolView {
            total_staked: state.total_staked.into(),
            reward_pool: state.reward_pool.into(),
            reward_per_share: state.reward_per_share.to_string(),
        }
    }
}

impl Contract {
    /// Take `amount` out of an account's liquid balance. Total supply is unchanged: the tokens are still
    /// in `ft_total_supply`, now as stake or as reward-pool balance.
    pub(crate) fn debit_liquid(&mut self, account: &AccountId, amount: u128) {
        let balance = self.token.internal_unwrap_balance_of(account);
        let balance = balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("The account doesn't have enough balance"));
        self.token.accounts.insert(account, &balance);
    }

    /// Put `amount` into an account's liquid balance; the account must be registered. Total supply is unchanged.
    pub(crate) fn credit_liquid(&mut self, account: &AccountId, amount: u128) {
        let balance = self.token.internal_unwrap_balance_of(account);
        let balance = balance
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Balance overflow"));
        self.token.accounts.insert(account, &balance);
    }
}
