//! NEP-297 events. Schemas are fixed in SPEC.md "Events"; changing one is a version bump.

use near_sdk::{AccountId, near};

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
}
