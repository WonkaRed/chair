//! Policy math with no NEAR host calls, so every rule below runs under plain `cargo test`.
//! SPEC.md "Epochs and rollover" is the written contract for this file.

use crate::MAX_TOTAL_SUPPLY;
use near_sdk::near;
use std::fmt;

/// The chair may set any rate in `-MAX_RATE_BPS..=MAX_RATE_BPS`. Hard-coded: no state can change it.
pub const MAX_RATE_BPS: i32 = 200;
/// The chair may move the rate by at most this much per epoch; a missed epoch decays by the same amount.
pub const MAX_STEP_BPS: i32 = 50;

/// Which epoch a timestamp falls in. Epoch 0 starts at `start_ms`; times before it count as epoch 0.
pub fn epoch_at(now_ms: u64, start_ms: u64, epoch_ms: u64) -> u64 {
    now_ms.saturating_sub(start_ms) / epoch_ms
}

/// A SHA-256 digest as the chair publishes it: exactly 64 lowercase hex characters. One canonical
/// form, so two accounts hashing the same reasoning always produce the same string.
pub fn is_sha256_hex(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What an easing epoch mints: `supply * rate / 10_000`, rounded down so the contract never mints more
/// than the formula's exact value, and clipped so the supply never passes `MAX_TOTAL_SUPPLY`.
/// Zero unless the rate is positive. `supply <= MAX_TOTAL_SUPPLY` keeps the product inside `u128`.
pub fn mint_amount(supply: u128, rate_bps: i32) -> u128 {
    let Ok(rate) = u128::try_from(rate_bps) else {
        return 0;
    };
    (supply * rate / 10_000).min(MAX_TOTAL_SUPPLY.saturating_sub(supply))
}

/// What a transfer burns while the rate is negative: `amount * |rate| / 10_000`, rounded down, so a
/// transfer smaller than `10_000 / |rate|` burns nothing. Zero unless the rate is negative. The result is
/// strictly below `amount` because `|rate| <= MAX_RATE_BPS < 10_000`. A product that overflows `u128`
/// is split so the burn is still exact: `(a / 10_000) * r + (a % 10_000) * r / 10_000`.
pub fn burn_amount(amount: u128, rate_bps: i32) -> u128 {
    if rate_bps >= 0 {
        return 0;
    }
    let rate = u128::from(rate_bps.unsigned_abs());
    amount / 10_000 * rate + amount % 10_000 * rate / 10_000
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyError {
    AlreadySet,
    OutOfBounds,
    StepTooLarge,
}

impl fmt::Display for PolicyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadySet => write!(f, "policy already set this epoch"),
            Self::OutOfBounds => {
                write!(
                    f,
                    "rate_bps out of bounds: must be within {}..={}",
                    -MAX_RATE_BPS, MAX_RATE_BPS
                )
            }
            Self::StepTooLarge => {
                write!(
                    f,
                    "rate step too large: must move at most {MAX_STEP_BPS} bps from the current rate"
                )
            }
        }
    }
}

/// One missed-epoch decay, reported so the caller can emit it as an event.
#[derive(Debug, PartialEq, Eq)]
pub struct Decay {
    pub epoch: u64,
    pub previous_rate_bps: i32,
    pub rate_bps: i32,
}

/// The rate in effect and how far rollover has been applied.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyState {
    /// Rate in effect during `epoch`: positive eases, negative tightens.
    pub rate_bps: i32,
    /// Every boundary before this epoch has been applied; this epoch is still open.
    pub epoch: u64,
    /// Epoch of the last `set_policy`, `None` until the chair first acts.
    pub last_set_epoch: Option<u64>,
}

impl PolicyState {
    pub fn new() -> Self {
        Self {
            rate_bps: 0,
            epoch: 0,
            last_set_epoch: None,
        }
    }

    /// The policy alone changes at no further boundary. `EpochState::advance_to` adds the other half:
    /// a candidate over the impeachment threshold keeps the next boundary from being skipped.
    pub fn is_quiescent(&self) -> bool {
        self.rate_bps == 0
    }

    /// Apply every epoch boundary up to `target`, in order. A boundary closing an epoch in which
    /// the chair did not act moves the rate `MAX_STEP_BPS` toward zero. Quiescence caps the work
    /// at `MAX_RATE_BPS / MAX_STEP_BPS` iterations however long the contract sat idle.
    pub fn advance_to(&mut self, target: u64) -> Vec<Decay> {
        let mut decays = Vec::new();
        while self.epoch < target {
            if self.is_quiescent() {
                self.epoch = target;
                break;
            }
            let closing = self.epoch;
            if self.last_set_epoch != Some(closing) {
                let rate_bps =
                    self.rate_bps - self.rate_bps.signum() * self.rate_bps.abs().min(MAX_STEP_BPS);
                decays.push(Decay {
                    epoch: closing,
                    previous_rate_bps: self.rate_bps,
                    rate_bps,
                });
                self.rate_bps = rate_bps;
            }
            self.epoch += 1;
        }
        decays
    }

    /// Record the chair's rate for `epoch`, which must already be the open epoch (`advance_to` first).
    /// Returns the rate it replaced.
    pub fn set_rate(&mut self, epoch: u64, rate_bps: i32) -> Result<i32, PolicyError> {
        assert_eq!(self.epoch, epoch, "set_rate before advance_to");
        if self.last_set_epoch == Some(epoch) {
            return Err(PolicyError::AlreadySet);
        }
        if !(-MAX_RATE_BPS..=MAX_RATE_BPS).contains(&rate_bps) {
            return Err(PolicyError::OutOfBounds);
        }
        // Both operands are within +-MAX_RATE_BPS here, so the subtraction cannot overflow.
        if (rate_bps - self.rate_bps).abs() > MAX_STEP_BPS {
            return Err(PolicyError::StepTooLarge);
        }
        let previous = self.rate_bps;
        self.rate_bps = rate_bps;
        self.last_set_epoch = Some(epoch);
        Ok(previous)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(rate_bps: i32, epoch: u64, last_set_epoch: Option<u64>) -> PolicyState {
        PolicyState {
            rate_bps,
            epoch,
            last_set_epoch,
        }
    }

    #[test]
    fn a_reasoning_hash_is_exactly_64_lowercase_hex_characters() {
        let valid = "0123456789abcdef".repeat(4);
        assert!(is_sha256_hex(&valid));
        assert!(is_sha256_hex(&"0".repeat(64)));
        for (what, bad) in [
            ("empty", String::new()),
            ("63 characters", valid[..63].to_string()),
            ("65 characters", format!("{valid}a")),
            ("uppercase", valid.to_uppercase()),
            ("mixed case", format!("A{}", &valid[1..])),
            ("non-hex letter", format!("g{}", &valid[1..])),
            ("0x prefix", format!("0x{}", &valid[2..])),
            ("padded with a space", format!(" {}", &valid[1..])),
            ("multibyte, 64 bytes", "é".repeat(32)),
        ] {
            assert!(!is_sha256_hex(&bad), "{what} was accepted");
        }
    }

    #[test]
    fn epoch_at_floors_and_clamps_before_start() {
        assert_eq!(epoch_at(1_000, 1_000, 60_000), 0);
        assert_eq!(epoch_at(60_999, 1_000, 60_000), 0);
        assert_eq!(epoch_at(61_000, 1_000, 60_000), 1);
        assert_eq!(epoch_at(500, 1_000, 60_000), 0);
    }

    #[test]
    fn rate_bounds_are_inclusive_at_both_ends() {
        for (from, to) in [(150, 200), (-150, -200)] {
            let mut s = state(from, 3, None);
            assert_eq!(s.set_rate(3, to), Ok(from));
        }
        for (from, to) in [(200, 201), (-200, -201), (200, i32::MAX), (-200, i32::MIN)] {
            let mut s = state(from, 3, None);
            assert_eq!(s.set_rate(3, to), Err(PolicyError::OutOfBounds));
            assert_eq!(
                s,
                state(from, 3, None),
                "a rejected call leaves state untouched"
            );
        }
    }

    #[test]
    fn step_limit_is_inclusive_and_applies_across_zero() {
        let mut s = state(0, 0, None);
        assert_eq!(s.set_rate(0, 51), Err(PolicyError::StepTooLarge));
        assert_eq!(s.set_rate(0, -51), Err(PolicyError::StepTooLarge));
        assert_eq!(s.set_rate(0, -50), Ok(0));
        let mut s = state(-10, 0, None);
        assert_eq!(s.set_rate(0, 40), Ok(-10));
        let mut s = state(-10, 0, None);
        assert_eq!(s.set_rate(0, 41), Err(PolicyError::StepTooLarge));
    }

    #[test]
    fn second_set_in_one_epoch_is_rejected_even_if_identical() {
        let mut s = state(0, 5, None);
        assert_eq!(s.set_rate(5, 10), Ok(0));
        assert_eq!(s.set_rate(5, 10), Err(PolicyError::AlreadySet));
        assert_eq!(s.set_rate(5, 20), Err(PolicyError::AlreadySet));
        assert_eq!(s.rate_bps, 10);
    }

    #[test]
    fn staying_put_is_a_valid_decision() {
        let mut s = state(100, 2, Some(1));
        assert_eq!(s.set_rate(2, 100), Ok(100));
        assert_eq!(s.last_set_epoch, Some(2));
    }

    #[test]
    fn missed_epochs_decay_toward_zero_from_either_side() {
        let mut s = state(120, 0, Some(0));
        let decays = s.advance_to(3);
        assert_eq!(
            decays,
            vec![
                Decay {
                    epoch: 1,
                    previous_rate_bps: 120,
                    rate_bps: 70
                },
                Decay {
                    epoch: 2,
                    previous_rate_bps: 70,
                    rate_bps: 20
                },
            ]
        );
        assert_eq!(s, state(20, 3, Some(0)));

        let mut s = state(-120, 0, Some(0));
        s.advance_to(3);
        assert_eq!(s.rate_bps, -20);
    }

    #[test]
    fn the_epoch_the_chair_acted_in_does_not_decay() {
        let mut s = state(60, 4, Some(4));
        assert!(s.advance_to(5).is_empty());
        assert_eq!(s, state(60, 5, Some(4)));
    }

    #[test]
    fn decay_never_overshoots_zero() {
        let mut s = state(30, 0, Some(0));
        assert_eq!(
            s.advance_to(2),
            vec![Decay {
                epoch: 1,
                previous_rate_bps: 30,
                rate_bps: 0
            }]
        );
        assert_eq!(s.rate_bps, 0);
    }

    #[test]
    fn a_huge_idle_gap_costs_a_handful_of_steps_not_billions() {
        let mut s = state(200, 0, Some(0));
        let decays = s.advance_to(u64::MAX);
        assert_eq!(decays.len(), 4);
        assert_eq!(s, state(0, u64::MAX, Some(0)));
    }

    #[test]
    fn advance_is_idempotent_and_never_goes_back() {
        let mut s = state(100, 0, Some(0));
        s.advance_to(5);
        let snapshot = s.clone();
        assert!(s.advance_to(5).is_empty());
        assert!(s.advance_to(2).is_empty());
        assert_eq!(s, snapshot);
    }

    #[test]
    #[should_panic(expected = "set_rate before advance_to")]
    fn set_rate_on_a_stale_state_is_a_programming_error() {
        state(0, 1, None).set_rate(2, 10).ok();
    }

    #[test]
    fn worked_vector_mint_floors() {
        // SPEC.md worked vector: supply 1_000_001 at 33 bps is 3300.0033, minted as 3300.
        assert_eq!(mint_amount(1_000_001, 33), 3300);
    }

    #[test]
    fn worked_vector_burn_floors() {
        // SPEC.md worked vector: 12_345 at -75 bps is 92.5875, burned as 92.
        assert_eq!(burn_amount(12_345, -75), 92);
    }

    #[test]
    fn mint_is_zero_unless_the_rate_is_positive() {
        assert_eq!(mint_amount(1_000_000, 0), 0);
        assert_eq!(mint_amount(1_000_000, -200), 0);
        assert_eq!(mint_amount(1_000_000, 1), 100);
        assert_eq!(
            mint_amount(9_999, 1),
            0,
            "a mint under one unit rounds to nothing"
        );
    }

    #[test]
    fn mint_stops_at_the_supply_cap_and_cannot_overflow() {
        assert_eq!(mint_amount(MAX_TOTAL_SUPPLY, 200), 0);
        assert_eq!(mint_amount(MAX_TOTAL_SUPPLY - 7, 200), 7);
        let just_under = MAX_TOTAL_SUPPLY - 1_000_000_000_000;
        assert_eq!(
            mint_amount(just_under, 200),
            1_000_000_000_000,
            "2% of the supply would pass the cap, so the cap wins"
        );
        // 2% of a near-max supply is below the cap headroom of an emptier supply: the formula decides.
        assert_eq!(
            mint_amount(MAX_TOTAL_SUPPLY / 2, 200),
            MAX_TOTAL_SUPPLY / 2 / 50
        );
    }

    #[test]
    fn burn_is_zero_unless_the_rate_is_negative_and_never_reaches_the_amount() {
        assert_eq!(burn_amount(1_000_000, 0), 0);
        assert_eq!(burn_amount(1_000_000, 200), 0);
        assert_eq!(burn_amount(1_000_000, -200), 20_000);
        assert_eq!(
            burn_amount(49, -200),
            0,
            "dust below 10_000 / |rate| burns nothing"
        );
        assert_eq!(burn_amount(50, -200), 1);
        for amount in [1, 2, 49, 50, 9_999, 10_000, u128::MAX] {
            assert!(burn_amount(amount, -200) < amount);
        }
    }

    #[test]
    fn burn_is_exact_for_the_largest_amounts() {
        // At 200 bps the burn is floor(amount / 50) and at 50 bps floor(amount / 200), for every amount,
        // including the ones where `amount * rate` would overflow `u128`.
        for amount in [u128::MAX, u128::MAX - 1, u128::MAX / 3, 10u128.pow(36) + 49] {
            assert_eq!(burn_amount(amount, -200), amount / 50);
            assert_eq!(burn_amount(amount, -50), amount / 200);
        }
    }
}
