//! Policy math with no NEAR host calls, so every rule below runs under plain `cargo test`.
//! SPEC.md "Epochs and rollover" is the written contract for this file.

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

    /// Nothing changes at further boundaries. Extension point: staking and impeachment lanes
    /// extend this test so their per-boundary work is never skipped (SPEC.md "Extension points").
    fn is_quiescent(&self) -> bool {
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
}
