//! NEP-141 surface. Storage management, metadata and the resolver pass straight through to
//! `near-contract-standards`; `ft_transfer` and `ft_transfer_call` burn under a negative rate
//! (SPEC.md "Transfer burn") and `ft_total_supply` counts mints that are due but not yet applied.

use crate::events::ChairEvent;
use crate::policy::burn_amount;
use crate::{Contract, ContractExt};
use near_contract_standards::fungible_token::events::{FtBurn, FtTransfer};
use near_contract_standards::fungible_token::metadata::{
    FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider,
};
use near_contract_standards::fungible_token::receiver::ext_ft_receiver;
use near_contract_standards::fungible_token::resolver::ext_ft_resolver;
use near_contract_standards::fungible_token::{FungibleTokenCore, FungibleTokenResolver};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{
    AccountId, Gas, NearToken, PromiseOrValue, assert_one_yocto, env, log, near, require,
};

/// Reserved for `ft_resolve_transfer`, which rolls the epoch before it refunds, so a boundary that fell
/// during the call is applied there. Running out of gas would lose the sender's refund. Measured in
/// `sandbox-tests/tests/resolver_gas.rs`: the heaviest rollover (five mints, four decays, an impeachment
/// refunding ten bonds) burns about 5.3 Tgas and the resolver itself about 2.2; the library's 5 Tgas is
/// not enough.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(30);

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        self.transfer_burning(&receiver_id, amount.0, memo);
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        let sender_id = env::predecessor_account_id();
        let received = self.transfer_burning(&receiver_id, amount.0, memo);
        // The receiver is told, and the resolver settles, what actually arrived.
        ext_ft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .ft_on_transfer(sender_id.clone(), received.into(), msg)
            .then(
                ext_ft_resolver::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_resolve_transfer(sender_id, receiver_id, received.into()),
            )
            .into()
    }

    fn ft_total_supply(&self) -> U128 {
        self.project().0.total_supply.into()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

impl Contract {
    /// Move `amount` from the caller to `receiver_id`, burning `burn_amount(amount, rate)` on the way when
    /// the rate in effect is negative. Returns what the receiver got. Nothing is logged before the last
    /// check has passed.
    fn transfer_burning(
        &mut self,
        receiver_id: &AccountId,
        amount: u128,
        memo: Option<String>,
    ) -> u128 {
        let events = self.roll();
        let sender_id = env::predecessor_account_id();
        require!(
            &sender_id != receiver_id,
            "Sender and receiver should be different"
        );
        require!(amount > 0, "The amount should be a positive number");

        let (epoch, rate_bps) = (self.policy.epoch, self.policy.rate_bps);
        let burned = burn_amount(amount, rate_bps);
        let received = amount - burned;
        // `internal_withdraw` takes all of `amount` out of the supply and `internal_deposit` puts back
        // what arrives, so the supply falls by exactly `burned`.
        self.token.internal_withdraw(&sender_id, amount);
        self.token.internal_deposit(receiver_id, received);
        self.burned += burned;

        ChairEvent::emit_all(events);
        FtTransfer {
            old_owner_id: &sender_id,
            new_owner_id: receiver_id,
            amount: received.into(),
            memo: memo.as_deref(),
        }
        .emit();
        if burned > 0 {
            ChairEvent::emit_all(vec![ChairEvent::TransferBurned {
                epoch,
                rate_bps,
                account_id: sender_id,
                amount: amount.into(),
                burned: burned.into(),
            }]);
        }
        received
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let events = self.roll();
        let (used_amount, burned_amount) =
            self.token
                .internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        ChairEvent::emit_all(events);
        if burned_amount > 0 {
            self.burned += burned_amount;
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        // Closing an account changes the supply: a boundary already passed must see the supply as it was.
        let events = self.roll();
        let closed = self.token.internal_storage_unregister(force);
        ChairEvent::emit_all(events);
        match closed {
            Some((account_id, balance)) => {
                log!("Closed @{} with {}", account_id, balance);
                if balance > 0 {
                    // A forced close destroys the balance: the ledger and the event log both count it.
                    self.burned += balance;
                    FtBurn {
                        owner_id: &account_id,
                        amount: balance.into(),
                        memo: Some("storage_unregister"),
                    }
                    .emit();
                }
                true
            }
            None => false,
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "$CHAIR".to_string(),
            symbol: "CHAIR".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 24,
        }
    }
}
