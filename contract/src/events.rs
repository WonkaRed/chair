//! NEP-297 events. Schemas are fixed in SPEC.md "Events"; changing one is a version bump.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint, FtTransfer};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, env, near};

#[derive(Clone, Debug, PartialEq, Eq)]
#[near(event_json(standard = "chair"))]
pub enum ChairEvent {
    /// The chair's decision for an epoch.
    #[event_version("1.0.0")]
    PolicySet {
        chair: AccountId,
        epoch: u64,
        rate_bps: i32,
        previous_rate_bps: i32,
        reasoning_hash: String,
    },
    /// The contract's decision for an epoch the chair missed.
    #[event_version("1.0.0")]
    RateDecayed {
        epoch: u64,
        previous_rate_bps: i32,
        rate_bps: i32,
    },
    /// An easing epoch closed and its mint went into the reward pool.
    #[event_version("1.0.0")]
    EpochMinted {
        epoch: u64,
        rate_bps: i32,
        amount: U128,
        total_staked: U128,
        /// Decimal string of the new reward index.
        reward_per_share: String,
    },
    /// A transfer under a negative rate; `burned` left the supply, `amount` is what the sender spent.
    #[event_version("1.0.0")]
    TransferBurned {
        epoch: u64,
        rate_bps: i32,
        account_id: AccountId,
        amount: U128,
        burned: U128,
    },
    #[event_version("1.0.0")]
    Staked {
        account_id: AccountId,
        amount: U128,
        total_staked: U128,
    },
    #[event_version("1.0.0")]
    Unstaked {
        account_id: AccountId,
        amount: U128,
        total_staked: U128,
    },
    #[event_version("1.0.0")]
    Claimed { account_id: AccountId, amount: U128 },
    #[event_version("1.0.0")]
    Nominated {
        candidate: AccountId,
        nominator: AccountId,
        persona_hash: String,
        bond: U128,
    },
    /// `amount` of stake now backs `candidate`; also logged when a backer's stake grows.
    #[event_version("1.0.0")]
    Backed {
        account_id: AccountId,
        candidate: AccountId,
        amount: U128,
    },
    /// `amount` of stake no longer backs `candidate`; also logged when a backer's stake shrinks.
    #[event_version("1.0.0")]
    Unbacked {
        account_id: AccountId,
        candidate: AccountId,
        amount: U128,
    },
    /// A nomination ended without winning (withdrawn, evicted, or cleared by someone else's impeachment)
    /// and its bond was refunded.
    #[event_version("1.0.0")]
    NominationWithdrawn {
        candidate: AccountId,
        nominator: AccountId,
        bond: U128,
    },
    /// The vote removed the chair at the end of `epoch`; `new_chair` may act from the next epoch.
    #[event_version("1.0.0")]
    Impeached {
        epoch: u64,
        previous_chair: AccountId,
        new_chair: AccountId,
        persona_hash: String,
        backing: U128,
        total_staked: U128,
        /// Complete epochs the removed chair held office, counting `epoch`.
        streak_ended: u64,
    },
}

impl ChairEvent {
    /// Log events in order, each followed by the NEP-141 event that lets a generic indexer follow supply
    /// and balances. The contract account holds every staked and unclaimed-reward token as far as
    /// those events go. Call this only once nothing in the call can still panic.
    pub fn emit_all(events: Vec<ChairEvent>) {
        let contract = env::current_account_id();
        for event in events {
            event.emit();
            match event {
                Self::EpochMinted { amount, .. } => FtMint {
                    owner_id: &contract,
                    amount,
                    memo: Some("chair:easing"),
                }
                .emit(),
                Self::TransferBurned {
                    account_id, burned, ..
                } => FtBurn {
                    owner_id: &account_id,
                    amount: burned,
                    memo: Some("chair:tightening"),
                }
                .emit(),
                Self::Staked {
                    account_id, amount, ..
                } => FtTransfer {
                    old_owner_id: &account_id,
                    new_owner_id: &contract,
                    amount,
                    memo: Some("chair:stake"),
                }
                .emit(),
                Self::Unstaked {
                    account_id, amount, ..
                } => FtTransfer {
                    old_owner_id: &contract,
                    new_owner_id: &account_id,
                    amount,
                    memo: Some("chair:unstake"),
                }
                .emit(),
                Self::Claimed { account_id, amount } => FtTransfer {
                    old_owner_id: &contract,
                    new_owner_id: &account_id,
                    amount,
                    memo: Some("chair:claim"),
                }
                .emit(),
                _ => {}
            }
        }
    }
}
