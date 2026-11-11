//! Nomination, backing and the data impeachment reads (SPEC.md "Impeachment"). The vote itself is
//! counted at the epoch boundary by `EpochState::advance_to`; nothing here can change the chair.

use crate::events::ChairEvent;
use crate::staking::Staker;
use crate::{Contract, ContractExt, MAX_PERSONA_HASH_LEN};
use near_sdk::json_types::U128;
use near_sdk::{AccountId, NearToken, Promise, assert_one_yocto, borsh, env, near, require};

/// Live nominations at once. Bounds the work at every rollover and the size of `get_candidates`.
pub const MAX_CANDIDATES: usize = 10;

/// A live nomination. Held in `Contract::candidates` in nomination order, oldest first.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Candidate {
    /// Never reused, starts at 1; breaks backing ties (lowest wins) and names the nomination in `Staker::backing_id`.
    pub id: u64,
    pub candidate: AccountId,
    pub nominator: AccountId,
    pub persona_hash: String,
    /// Escrowed yoctoNEAR, returned when the nomination ends by any route.
    pub bond: u128,
    /// Staked tokens backing this candidate right now.
    pub backing: u128,
}

#[near(serializers = [json])]
pub struct CandidateView {
    pub candidate: AccountId,
    pub nominator: AccountId,
    pub persona_hash: String,
    pub backing: U128,
    pub bond: U128,
}

#[near]
impl Contract {
    /// Put `candidate` up to replace the chair, with the hash of its persona. Attach at least
    /// `nominate_bond` and at least the cost of storing the nomination; the bond is escrowed, anything
    /// above it is refunded, and the bond comes back whenever the nomination ends (withdrawal, eviction,
    /// or an impeachment, whoever wins). The sitting chair cannot be nominated, a candidate has one live
    /// nomination, and at most `MAX_CANDIDATES` are live. The nominator's whole stake backs the new
    /// nomination at once, as if it had called `back`. A full list gives the slot of its least-backed
    /// nomination (the oldest on a tie) to a nominator whose stake is strictly greater than that backing,
    /// and refuses everyone else: a slot costs more stake than the one it takes, never only a bond.
    #[payable]
    pub fn nominate(&mut self, candidate: AccountId, persona_hash: String) {
        let mut events = self.roll();
        let nominator = env::predecessor_account_id();
        require!(
            !persona_hash.is_empty() && persona_hash.len() <= MAX_PERSONA_HASH_LEN,
            "persona_hash must be 1..=128 bytes"
        );
        require!(
            candidate != self.chair,
            "the sitting chair cannot be nominated"
        );
        require!(
            self.candidates.iter().all(|c| c.candidate != candidate),
            "candidate is already nominated"
        );

        let staker = self.stakers.get(&nominator).filter(|s| s.staked > 0);
        if self.candidates.len() >= MAX_CANDIDATES {
            let slot = self
                .candidates
                .iter()
                .enumerate()
                .min_by_key(|(_, c)| (c.backing, c.id))
                .map(|(slot, _)| slot)
                .unwrap_or_else(|| env::abort());
            let least = self.candidates[slot].backing;
            require!(
                staker.as_ref().is_some_and(|s| s.staked > least),
                format!(
                    "candidate list is full: stake more than {least} yoctoCHAIR to take the least-backed slot"
                )
            );
            let evicted = self.candidates.remove(slot);
            events.push(self.refund_bond(evicted));
        }

        let mut nominated = Candidate {
            id: self.next_candidate_id,
            candidate,
            nominator: nominator.clone(),
            persona_hash,
            bond: 0,
            backing: 0,
        };
        // The nomination lives in contract state, so its storage is the nominator's to pay: the escrow
        // must cover the serialized bytes at the current byte price.
        let stored = borsh::to_vec(&nominated)
            .unwrap_or_else(|_| env::abort())
            .len() as u128;
        let bond = self
            .nominate_bond
            .0
            .max(env::storage_byte_cost().as_yoctonear() * stored);
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= bond,
            format!(
                "attach at least {bond} yoctoNEAR: the bond, or the storage cost if that is higher"
            )
        );
        if deposit > bond {
            Promise::new(nominator.clone())
                .transfer(NearToken::from_yoctonear(deposit - bond))
                .detach();
        }
        nominated.bond = bond;
        self.next_candidate_id += 1;
        events.push(ChairEvent::Nominated {
            candidate: nominated.candidate.clone(),
            nominator: nominator.clone(),
            persona_hash: nominated.persona_hash.clone(),
            bond: bond.into(),
        });
        self.candidates.push(nominated);
        if let Some(staker) = staker {
            let target = self.candidates.len() - 1;
            self.move_backing(&nominator, staker, target, &mut events);
        }
        ChairEvent::emit_all(events);
    }

    /// Point the caller's whole stake at `candidate`, replacing any earlier backing. Stake added or
    /// removed later moves the backing with it. A no-op if it already backs that candidate. Attach 1
    /// yoctoNEAR: the vote decides who sets the monetary policy, so a function-call key cannot move it.
    #[payable]
    pub fn back(&mut self, candidate: AccountId) {
        assert_one_yocto();
        let mut events = self.roll();
        let account = env::predecessor_account_id();
        let staker = self
            .stakers
            .get(&account)
            .filter(|s| s.staked > 0)
            .unwrap_or_else(|| {
                env::panic_str("stake first: only staked tokens can back a candidate")
            });
        let target = self
            .candidates
            .iter()
            .position(|c| c.candidate == candidate)
            .unwrap_or_else(|| env::panic_str("no such candidate"));
        if self.candidates[target].id != staker.backing_id {
            self.move_backing(&account, staker, target, &mut events);
        }
        ChairEvent::emit_all(events);
    }

    /// Take the caller's stake off whichever candidate it backs. Attach 1 yoctoNEAR, like `back`.
    #[payable]
    pub fn unback(&mut self) {
        assert_one_yocto();
        let mut events = self.roll();
        let account = env::predecessor_account_id();
        let mut staker = self
            .stakers
            .get(&account)
            .unwrap_or_else(|| env::panic_str("not backing anyone"));
        let from = self
            .backing_index(staker.backing_id)
            .unwrap_or_else(|| env::panic_str("not backing anyone"));
        events.push(self.withdraw_backing(from, &account, staker.staked));
        staker.backing_id = 0;
        self.stakers.insert(&account, &staker);
        ChairEvent::emit_all(events);
    }

    /// End the caller's own nomination of `candidate` and return the bond. Attach 1 yoctoNEAR: this pays
    /// out NEAR. Refused while any account other than the nominator backs it: otherwise a nominator could
    /// wipe every backer at the last block before a boundary and re-nominate. The bond still returns when
    /// the nomination ends by eviction or impeachment.
    #[payable]
    pub fn withdraw_nomination(&mut self, candidate: AccountId) {
        assert_one_yocto();
        let mut events = self.roll();
        let slot = self
            .candidates
            .iter()
            .position(|c| c.candidate == candidate)
            .unwrap_or_else(|| env::panic_str("no such candidate"));
        require!(
            self.candidates[slot].nominator == env::predecessor_account_id(),
            "only the nominator may withdraw a nomination"
        );
        let nomination = &self.candidates[slot];
        // Backing is the sum of the backers' stakes, so it exceeds the nominator's own stake on this
        // nomination exactly when some other account with stake backs it.
        let own_backing = self
            .stakers
            .get(&nomination.nominator)
            .filter(|s| s.backing_id == nomination.id)
            .map_or(0, |s| s.staked);
        require!(
            nomination.backing == own_backing,
            "other accounts back this candidate: it can be withdrawn once their backing is gone"
        );
        let withdrawn = self.candidates.remove(slot);
        events.push(self.refund_bond(withdrawn));
        ChairEvent::emit_all(events);
    }

    pub fn get_candidates(&self) -> Vec<CandidateView> {
        let (_, advance) = self.project();
        if advance.impeached {
            return Vec::new();
        }
        self.candidates
            .iter()
            .map(|c| CandidateView {
                candidate: c.candidate.clone(),
                nominator: c.nominator.clone(),
                persona_hash: c.persona_hash.clone(),
                backing: c.backing.into(),
                bond: c.bond.into(),
            })
            .collect()
    }
}

impl Contract {
    /// Index in `candidates` of the live nomination with this id; `None` for 0 and for dead ids.
    pub(crate) fn backing_index(&self, id: u64) -> Option<usize> {
        self.candidates.iter().position(|c| c.id == id)
    }

    /// Point `account`'s whole stake at `candidates[target]`, off whichever candidate it backed before.
    fn move_backing(
        &mut self,
        account: &AccountId,
        mut staker: Staker,
        target: usize,
        events: &mut Vec<ChairEvent>,
    ) {
        if let Some(from) = self.backing_index(staker.backing_id) {
            events.push(self.withdraw_backing(from, account, staker.staked));
        }
        self.candidates[target].backing += staker.staked;
        staker.backing_id = self.candidates[target].id;
        self.stakers.insert(account, &staker);
        events.push(ChairEvent::Backed {
            account_id: account.clone(),
            candidate: self.candidates[target].candidate.clone(),
            amount: staker.staked.into(),
        });
    }

    /// Remove `amount` of backing from `candidates[from]`.
    fn withdraw_backing(&mut self, from: usize, account: &AccountId, amount: u128) -> ChairEvent {
        self.candidates[from].backing -= amount;
        ChairEvent::Unbacked {
            account_id: account.clone(),
            candidate: self.candidates[from].candidate.clone(),
            amount: amount.into(),
        }
    }

    /// Schedule the escrowed bond back to its nominator. State is already updated; a refund to an
    /// account that no longer exists bounces back to this contract.
    pub(crate) fn refund_bond(&self, nomination: Candidate) -> ChairEvent {
        Promise::new(nomination.nominator.clone())
            .transfer(NearToken::from_yoctonear(nomination.bond))
            .detach();
        ChairEvent::NominationWithdrawn {
            candidate: nomination.candidate,
            nominator: nomination.nominator,
            bond: nomination.bond.into(),
        }
    }
}
