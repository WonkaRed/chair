//! Epoch rollover (SPEC.md "Epochs and rollover"): everything an epoch boundary reads or writes, as one
//! value with no host calls. The contract applies it (`Contract::roll`) and the views project it without
//! writing, so both see the same numbers by construction.

use crate::events::ChairEvent;
use crate::policy::{PolicyState, mint_amount};
use crate::staking::RewardIndex;
use crate::voting::Candidate;
use near_sdk::AccountId;

#[derive(Clone, Debug)]
pub struct EpochState {
    pub policy: PolicyState,
    pub chair: AccountId,
    /// Epoch in which the sitting chair took office; the streak is measured from here.
    pub chair_since_epoch: u64,
    /// Everything minted and not burned: liquid balances, stake and the reward pool.
    pub total_supply: u128,
    pub total_staked: u128,
    /// Minted for stakers and not yet claimed, rounding remainders included.
    pub reward_pool: u128,
    pub reward_per_share: RewardIndex,
}

/// What rolling forward did besides changing `EpochState`.
#[derive(Debug)]
pub struct Advance {
    /// In boundary order; within a boundary: mint, decay, impeachment.
    pub events: Vec<ChairEvent>,
    /// The candidates were cleared: the caller must end every nomination and refund its bond.
    pub impeached: bool,
}

/// A candidate must also be backed by more than this share of the whole supply (5%), however little is
/// staked, or a handful of yocto could seat a chair. Constant, and shown in `get_params`.
pub const QUORUM_BPS: u32 = 500;

/// The candidate whose backing exceeds both `threshold_bps` of `total_staked` and `QUORUM_BPS` of
/// `total_supply` (strictly each), the most backed first and the earliest nominated on a tie.
/// `backing <= total_staked <= total_supply <= MAX_TOTAL_SUPPLY` and both rates are at most 10_000, so
/// every product stays inside `u128`.
fn leading_candidate(
    candidates: &[Candidate],
    threshold_bps: u32,
    total_staked: u128,
    total_supply: u128,
) -> Option<&Candidate> {
    let limit =
        (u128::from(threshold_bps) * total_staked).max(u128::from(QUORUM_BPS) * total_supply);
    candidates
        .iter()
        .filter(|c| c.backing * 10_000 > limit)
        .max_by(|a, b| a.backing.cmp(&b.backing).then(b.id.cmp(&a.id)))
}

impl EpochState {
    /// Apply every boundary up to `target` in order. Per boundary closing epoch `e`: (1) mint at the rate
    /// in effect during `e`, (2) decay if the chair did not act in `e`, (3) impeach if a candidate is over
    /// the threshold and the quorum, counted on the stake and supply as they stood before the mint. Work is bounded however long the contract sat idle: once the rate is 0 and no
    /// candidate would win, no later boundary changes anything and the rest are skipped.
    pub fn advance_to(
        &mut self,
        target: u64,
        threshold_bps: u32,
        candidates: &[Candidate],
    ) -> Advance {
        let mut live = candidates;
        let mut advance = Advance {
            events: Vec::new(),
            impeached: false,
        };
        while self.policy.epoch < target {
            let closing = self.policy.epoch;
            let winner =
                leading_candidate(live, threshold_bps, self.total_staked, self.total_supply);
            if self.policy.is_quiescent() && winner.is_none() {
                self.policy.advance_to(target);
                break;
            }
            advance.events.extend(self.mint(closing));
            for d in self.policy.advance_to(closing + 1) {
                advance.events.push(ChairEvent::RateDecayed {
                    epoch: d.epoch,
                    previous_rate_bps: d.previous_rate_bps,
                    rate_bps: d.rate_bps,
                });
            }
            if let Some(winner) = winner {
                advance.events.push(self.impeach(closing, winner));
                advance.impeached = true;
                live = &[];
            }
        }
        advance
    }

    /// Step 1. Mints into the reward pool and the index; nothing is minted with no one staked, or for a
    /// mint that rounds to zero.
    fn mint(&mut self, closing: u64) -> Option<ChairEvent> {
        if self.total_staked == 0 {
            return None;
        }
        let rate_bps = self.policy.rate_bps;
        let amount = mint_amount(self.total_supply, rate_bps);
        if amount == 0 {
            return None;
        }
        self.total_supply += amount;
        self.reward_pool += amount;
        self.reward_per_share.accrue(amount, self.total_staked);
        Some(ChairEvent::EpochMinted {
            epoch: closing,
            rate_bps,
            amount: amount.into(),
            total_staked: self.total_staked.into(),
            reward_per_share: self.reward_per_share.to_string(),
        })
    }

    /// Step 3. The winner takes office from the next epoch with a fresh streak.
    fn impeach(&mut self, closing: u64, winner: &Candidate) -> ChairEvent {
        let previous_chair = std::mem::replace(&mut self.chair, winner.candidate.clone());
        let streak_ended = closing + 1 - self.chair_since_epoch;
        self.chair_since_epoch = closing + 1;
        ChairEvent::Impeached {
            epoch: closing,
            previous_chair,
            new_chair: winner.candidate.clone(),
            persona_hash: winner.persona_hash.clone(),
            backing: winner.backing.into(),
            total_staked: self.total_staked.into(),
            streak_ended,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MAX_TOTAL_SUPPLY;
    use crate::staking::{REWARD_SCALE, Staker};

    fn acct(name: &str) -> AccountId {
        name.parse().unwrap()
    }

    fn state(rate_bps: i32, epoch: u64, last_set_epoch: Option<u64>, staked: u128) -> EpochState {
        EpochState {
            policy: PolicyState {
                rate_bps,
                epoch,
                last_set_epoch,
            },
            chair: acct("chair.test"),
            chair_since_epoch: 0,
            total_supply: 1_000_001,
            total_staked: staked,
            reward_pool: 0,
            reward_per_share: RewardIndex::default(),
        }
    }

    /// Everything is staked, so the quorum (5% of the supply) is 5% of `staked` and the threshold decides.
    fn all_staked(
        rate_bps: i32,
        epoch: u64,
        last_set_epoch: Option<u64>,
        staked: u128,
    ) -> EpochState {
        let mut s = state(rate_bps, epoch, last_set_epoch, staked);
        s.total_supply = staked;
        s
    }

    fn candidate(id: u64, name: &str, backing: u128) -> Candidate {
        Candidate {
            id,
            candidate: acct(name),
            nominator: acct("nominator.test"),
            persona_hash: format!("persona-{id}"),
            bond: 1,
            backing,
        }
    }

    fn minted(events: &[ChairEvent]) -> Vec<(u64, u128)> {
        events
            .iter()
            .filter_map(|e| match e {
                ChairEvent::EpochMinted { epoch, amount, .. } => Some((*epoch, amount.0)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn worked_vector_a_mint_is_floored_and_shared_over_the_stake() {
        let mut s = state(33, 0, Some(0), 500);
        let advance = s.advance_to(1, 3_000, &[]);
        // SPEC.md: supply 1_000_001, rate 33, staked 500 -> minted 3300 (3300.0033 floored).
        assert_eq!(minted(&advance.events), [(0, 3300)]);
        assert_eq!(s.total_supply, 1_003_301);
        assert_eq!(s.reward_pool, 3300);
        assert_eq!(
            s.reward_per_share.to_string(),
            (3300 * REWARD_SCALE / 500).to_string()
        );
        // A staker holding all 500 is owed the whole mint; one holding 200 is owed 1320.
        assert_eq!(s.reward_per_share.owed(500, RewardIndex::default()), 3300);
        assert_eq!(s.reward_per_share.owed(200, RewardIndex::default()), 1320);
    }

    #[test]
    fn nothing_is_minted_while_nobody_is_staked() {
        let mut s = state(200, 0, Some(0), 0);
        let advance = s.advance_to(1, 3_000, &[]);
        assert!(minted(&advance.events).is_empty());
        assert_eq!((s.total_supply, s.reward_pool), (1_000_001, 0));
    }

    #[test]
    fn nothing_is_minted_at_zero_or_negative_rates() {
        for rate in [0, -1, -200] {
            let mut s = state(rate, 0, Some(0), 500);
            assert!(minted(&s.advance_to(1, 3_000, &[]).events).is_empty());
            assert_eq!(s.total_supply, 1_000_001);
        }
    }

    #[test]
    fn a_mint_that_rounds_to_zero_logs_nothing() {
        let mut s = state(1, 0, Some(0), 500);
        s.total_supply = 9_999;
        assert!(s.advance_to(1, 3_000, &[]).events.is_empty());
        assert_eq!(s.reward_pool, 0);
    }

    #[test]
    fn worked_vector_a_silent_chair_mints_at_the_old_rate_then_decays() {
        // Chair set 120 in epoch 0 and went silent. In effect: 120 (the epoch it acted, and the one
        // after), then 70, 20, 0. A boundary mints at the pre-decay rate of the epoch it closes.
        let mut s = state(120, 0, Some(0), 1_000);
        s.total_supply = 10_000_000;
        let advance = s.advance_to(10, 3_000, &[]);
        let decays: Vec<_> = advance
            .events
            .iter()
            .filter_map(|e| match e {
                ChairEvent::RateDecayed {
                    epoch, rate_bps, ..
                } => Some((*epoch, *rate_bps)),
                _ => None,
            })
            .collect();
        assert_eq!(decays, [(1, 70), (2, 20), (3, 0)]);
        let mints = minted(&advance.events);
        let mut supply = 10_000_000u128;
        let mut expected = Vec::new();
        for (epoch, rate) in [(0, 120u128), (1, 120), (2, 70), (3, 20)] {
            let amount = supply * rate / 10_000;
            expected.push((epoch, amount));
            supply += amount;
        }
        assert_eq!(mints, expected);
        assert_eq!(
            (s.policy.rate_bps, s.policy.epoch, s.total_supply),
            (0, 10, supply)
        );
    }

    #[test]
    fn negative_decay_vector_never_mints() {
        let mut s = state(-120, 0, Some(0), 1_000);
        let advance = s.advance_to(10, 3_000, &[]);
        assert!(minted(&advance.events).is_empty());
        assert_eq!(s.policy.rate_bps, 0);
        assert_eq!(advance.events.len(), 3);
    }

    #[test]
    fn mint_is_clipped_at_the_supply_cap_and_survives_a_one_yocto_stake() {
        let mut s = state(200, 0, Some(0), 1);
        s.total_supply = MAX_TOTAL_SUPPLY - 5;
        let advance = s.advance_to(1, 3_000, &[]);
        assert_eq!(minted(&advance.events), [(0, 5)]);
        assert_eq!(s.total_supply, MAX_TOTAL_SUPPLY);
        // The whole mint lands on the one staked yocto: the index is huge but exact, and nothing overflows.
        assert_eq!(s.reward_per_share.owed(1, RewardIndex::default()), 5);

        // At the cap there is nothing left to mint.
        assert!(minted(&s.advance_to(3, 3_000, &[]).events).is_empty());
        assert_eq!(s.total_supply, MAX_TOTAL_SUPPLY);
    }

    #[test]
    fn the_index_holds_a_huge_mint_over_a_tiny_stake_for_many_epochs() {
        // 2% of near-max supply per epoch onto 1 staked yocto, a thousand times: the cumulative index
        // exceeds u128 by far (the reason it is 256 bits) yet the staker is owed exactly what was minted.
        let mut s = state(200, 0, Some(0), 1);
        s.total_supply = MAX_TOTAL_SUPPLY / 2;
        let before = s.total_supply;
        for epoch in 0..1_000u64 {
            s.policy.last_set_epoch = Some(epoch);
            s.policy.rate_bps = 200;
            s.advance_to(epoch + 1, 3_000, &[]);
            // Put the supply back so the cap never clips the mint under test.
            s.total_supply = before;
        }
        assert_eq!(s.reward_pool, 1_000 * (before / 50));
        assert_eq!(
            s.reward_per_share.owed(1, RewardIndex::default()),
            s.reward_pool
        );
    }

    #[test]
    fn a_thousand_epochs_never_pay_out_more_than_was_minted() {
        // Three stakers who never move, 1000 easing epochs at 200 bps. Everything minted is in the pool;
        // what stakers can claim is the pool minus floor remainders, never more.
        let mut s = state(200, 0, Some(0), 0);
        s.total_supply = 3_000_000_000_000_000_000_000_000_007;
        let sizes = [
            123_456_789_012_345_678_901_234_567u128,
            1,
            999_999_999_999_999_999_999_997,
        ];
        s.total_staked = sizes.iter().sum();
        let supply_before = s.total_supply;
        for epoch in 0..1_000u64 {
            s.policy.last_set_epoch = Some(epoch);
            s.policy.rate_bps = 200;
            s.advance_to(epoch + 1, 3_000, &[]);
        }
        assert_eq!(s.total_supply - supply_before, s.reward_pool);
        let owed: u128 = sizes
            .iter()
            .map(|&x| s.reward_per_share.owed(x, RewardIndex::default()))
            .sum();
        assert!(
            owed <= s.reward_pool,
            "stakers are owed {owed} of a pool of {}",
            s.reward_pool
        );
        let dust = s.reward_pool - owed;
        let bound = 1_000 * (s.total_staked / REWARD_SCALE + 1) + sizes.len() as u128;
        assert!(dust <= bound, "dust {dust} exceeds {bound}");
    }

    #[test]
    fn a_new_staker_earns_nothing_from_before_it_staked() {
        let mut s = state(100, 0, Some(0), 1_000);
        s.advance_to(1, 3_000, &[]);
        assert_eq!(s.reward_pool, 10_000);

        // A second staker joins with 1000 after the first boundary, so it shares only the second mint.
        let mut late = Staker::new(s.reward_per_share);
        late.staked = 1_000;
        s.total_staked = 2_000;
        assert_eq!(late.pending(s.reward_per_share), 0);

        s.policy.last_set_epoch = Some(1);
        s.advance_to(2, 3_000, &[]);
        assert_eq!(s.reward_pool, 10_000 + 10_100);
        assert_eq!(late.pending(s.reward_per_share), 5_050);
        let early = s.reward_per_share.owed(1_000, RewardIndex::default());
        assert_eq!(early, 10_000 + 5_050);
    }

    #[test]
    fn settling_before_a_stake_change_keeps_what_was_earned() {
        let mut s = state(100, 0, Some(0), 1_000);
        let mut staker = Staker::new(RewardIndex::default());
        staker.staked = 1_000;
        s.advance_to(1, 3_000, &[]);
        staker.settle(s.reward_per_share);
        assert_eq!(
            (staker.accrued, staker.paid_per_share),
            (10_000, s.reward_per_share)
        );
        staker.staked = 1;
        assert_eq!(
            staker.pending(s.reward_per_share),
            10_000,
            "a smaller stake keeps the settled reward"
        );
    }

    #[test]
    fn impeachment_needs_backing_strictly_over_the_threshold() {
        // threshold 30% of 1000 staked: 300 is not enough, 301 is.
        let mut s = all_staked(0, 0, None, 1_000);
        let at = [candidate(1, "a.test", 300)];
        let advance = s.advance_to(1, 3_000, &at);
        assert!(!advance.impeached && advance.events.is_empty());
        assert_eq!((s.chair.as_str(), s.chair_since_epoch), ("chair.test", 0));

        let over = [candidate(1, "a.test", 301)];
        let advance = s.advance_to(2, 3_000, &over);
        assert!(advance.impeached);
        assert_eq!((s.chair.as_str(), s.chair_since_epoch), ("a.test", 2));
    }

    #[test]
    fn impeachment_also_needs_backing_strictly_over_the_quorum_of_the_supply() {
        // 5% of a supply of 10_000 is 500. 1_000 are staked, so 500 is 50% of the stake, far over the
        // 30% threshold, yet only 501 seats a candidate.
        let mut s = state(0, 0, None, 1_000);
        s.total_supply = 10_000;
        let advance = s.advance_to(1, 3_000, &[candidate(1, "a.test", 500)]);
        assert!(!advance.impeached, "exactly the quorum is not enough");
        let advance = s.advance_to(2, 3_000, &[candidate(1, "a.test", 501)]);
        assert!(advance.impeached, "one yocto above the quorum is");
        assert_eq!(s.chair.as_str(), "a.test");
    }

    #[test]
    fn the_quorum_is_counted_on_the_supply_before_the_boundarys_mint() {
        // Supply 10_000 and rate +200: the boundary mints 200, so the quorum is 500 before the mint and
        // 510 after it. A candidate with 505 is over the first line and under the second, and is seated.
        let mut s = state(200, 0, Some(0), 1_000);
        s.total_supply = 10_000;
        let backing = 505;
        assert!(backing * 10_000 <= u128::from(QUORUM_BPS) * (s.total_supply + 200));
        let advance = s.advance_to(1, 3_000, &[candidate(1, "a.test", backing)]);
        assert_eq!(minted(&advance.events), [(0, 200)]);
        assert!(
            advance.impeached,
            "counted before the mint, 505 is over the quorum"
        );
        assert_eq!(s.chair.as_str(), "a.test");
        // Exactly the pre-mint line (500) is still not enough.
        let mut s = state(200, 0, Some(0), 1_000);
        s.total_supply = 10_000;
        assert!(
            !s.advance_to(1, 3_000, &[candidate(1, "a.test", 500)])
                .impeached
        );
    }

    #[test]
    fn all_of_a_tiny_stake_never_seats_a_chair() {
        // The whole stake is 1 yocto of a supply of a million: 100% of the stake, 0.0001% of the supply.
        let mut s = state(0, 0, None, 1);
        let advance = s.advance_to(1_000, 3_000, &[candidate(1, "sock.test", 1)]);
        assert!(!advance.impeached);
        assert_eq!(s.chair.as_str(), "chair.test");
    }

    #[test]
    fn the_vote_arithmetic_holds_at_the_supply_cap() {
        let mut s = all_staked(0, 0, None, MAX_TOTAL_SUPPLY);
        let advance = s.advance_to(1, 5_000, &[candidate(1, "a.test", MAX_TOTAL_SUPPLY)]);
        assert!(advance.impeached);
    }

    #[test]
    fn the_most_backed_candidate_wins_and_ties_go_to_the_earliest_nomination() {
        let mut s = all_staked(0, 0, None, 1_000);
        let field = [
            candidate(1, "low.test", 400),
            candidate(2, "high.test", 600),
            candidate(3, "tied.test", 600),
        ];
        s.advance_to(1, 3_000, &field);
        assert_eq!(
            s.chair.as_str(),
            "high.test",
            "ties go to the lower id, never to list order alone"
        );

        let mut s = all_staked(0, 0, None, 1_000);
        let reversed = [
            candidate(5, "late.test", 700),
            candidate(4, "early.test", 700),
        ];
        s.advance_to(1, 3_000, &reversed);
        assert_eq!(s.chair.as_str(), "early.test");
    }

    #[test]
    fn impeachment_logs_the_ended_streak_and_resets_it() {
        let mut s = all_staked(0, 7, None, 1_000);
        s.chair_since_epoch = 2;
        let advance = s.advance_to(8, 3_000, &[candidate(9, "new.test", 900)]);
        assert_eq!(
            advance.events,
            [ChairEvent::Impeached {
                epoch: 7,
                previous_chair: acct("chair.test"),
                new_chair: acct("new.test"),
                persona_hash: "persona-9".into(),
                backing: 900.into(),
                total_staked: 1_000.into(),
                streak_ended: 6,
            }]
        );
        assert_eq!(
            s.chair_since_epoch, 8,
            "the new chair's streak starts at 0 in epoch 8"
        );
    }

    #[test]
    fn the_first_boundary_after_a_long_quiet_stretch_still_impeaches() {
        // Rate 0, so the policy alone would skip every boundary; a candidate over the threshold must not be skipped.
        let mut s = all_staked(0, 0, None, 1_000);
        let advance = s.advance_to(1_000_000_000, 3_000, &[candidate(1, "a.test", 800)]);
        assert!(advance.impeached);
        assert_eq!(
            (s.chair.as_str(), s.chair_since_epoch, s.policy.epoch),
            ("a.test", 1, 1_000_000_000)
        );
        assert_eq!(
            advance.events.len(),
            1,
            "one impeachment, and the later boundaries are no-ops"
        );
    }

    #[test]
    fn an_impeachment_and_a_mint_share_a_boundary_in_the_documented_order() {
        let mut s = all_staked(100, 0, Some(0), 1_000);
        let advance = s.advance_to(1, 3_000, &[candidate(1, "a.test", 800)]);
        let names: Vec<_> = advance
            .events
            .iter()
            .map(|e| match e {
                ChairEvent::EpochMinted { .. } => "mint",
                ChairEvent::RateDecayed { .. } => "decay",
                ChairEvent::Impeached { .. } => "impeach",
                _ => "other",
            })
            .collect();
        assert_eq!(
            names,
            ["mint", "impeach"],
            "the chair acted in epoch 0, so no decay"
        );
        let mut s = all_staked(100, 0, None, 1_000);
        let advance = s.advance_to(1, 3_000, &[candidate(1, "a.test", 800)]);
        assert_eq!(advance.events.len(), 3, "mint, decay, impeach");
    }

    #[test]
    fn the_chair_who_acted_in_the_impeachment_epoch_leaves_the_next_epoch_to_the_new_chair() {
        let mut s = all_staked(40, 3, None, 1_000);
        s.policy.set_rate(3, 80).unwrap();
        s.advance_to(4, 3_000, &[candidate(1, "a.test", 900)]);
        assert_eq!(s.chair.as_str(), "a.test");
        assert_eq!(
            s.policy.set_rate(4, 130),
            Ok(80),
            "no `already set` for the new chair, step measured from 80"
        );
    }

    #[test]
    fn stake_that_is_not_backed_enough_never_blocks_the_idle_skip() {
        let mut s = state(0, 0, None, 1_000);
        let advance = s.advance_to(u64::MAX, 3_000, &[candidate(1, "a.test", 100)]);
        assert!(advance.events.is_empty() && !advance.impeached);
        assert_eq!(s.policy.epoch, u64::MAX);
    }

    #[test]
    fn nothing_is_impeached_with_no_stake() {
        let mut s = state(0, 0, None, 0);
        assert!(!s.advance_to(5, 1, &[candidate(1, "a.test", 0)]).impeached);
    }
}
