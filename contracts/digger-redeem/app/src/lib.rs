#![no_std]

use sails_rs::{cell::RefCell, collections::BTreeMap, gstd::msg, prelude::*};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rates {
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
}

impl Rates {
    fn new(scrst: u128, bcrst: u128, hcrst: u128) -> Self {
        Self {
            scrst,
            bcrst,
            hcrst,
        }
    }
}

pub struct RedeemState {
    admins: BTreeMap<ActorId, bool>,
    res_contract: ActorId,
    vara_unit: u128,
    rates: Rates,
    reserve_balance: u128,
    locked_balance: u128,
    total_paid: u128,
    total_redeemed_scrst: u128,
    total_redeemed_bcrst: u128,
    total_redeemed_hcrst: u128,
    next_redeem_id: u128,
    pending_redemptions: BTreeMap<u128, PendingRedeem>,
    paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PendingRedeem {
    beneficiary: ActorId,
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
    payout: u128,
}

impl RedeemState {
    fn new_with_rates(
        admin: ActorId,
        res_contract: ActorId,
        vara_unit: u128,
        rates: Rates,
    ) -> Self {
        let mut admins = BTreeMap::new();
        admins.insert(admin, true);

        Self {
            admins,
            res_contract,
            vara_unit,
            rates,
            reserve_balance: 0,
            locked_balance: 0,
            total_paid: 0,
            total_redeemed_scrst: 0,
            total_redeemed_bcrst: 0,
            total_redeemed_hcrst: 0,
            next_redeem_id: 1,
            pending_redemptions: BTreeMap::new(),
            paused: false,
        }
    }

    fn sync_reserve_balance(&mut self) -> u128 {
        let actual_balance = Syscall::value_available();
        let tracked_balance = self.reserve_balance.saturating_add(self.locked_balance);
        if actual_balance <= tracked_balance {
            return 0;
        }

        let synced = actual_balance - tracked_balance;
        self.reserve_balance += synced;
        synced
    }
}

fn ensure_admin(state: &RedeemState, caller: ActorId) -> Result<(), String> {
    if !state.admins.get(&caller).copied().unwrap_or(false) {
        return Err("caller is not admin".into());
    }

    Ok(())
}

fn active_admins(admins: &BTreeMap<ActorId, bool>) -> Vec<ActorId> {
    admins
        .iter()
        .filter_map(|(actor, active)| if *active { Some(*actor) } else { None })
        .collect()
}

fn ensure_res_contract(state: &RedeemState, caller: ActorId) -> Result<(), String> {
    if state.res_contract != caller {
        return Err("caller is not RES contract".into());
    }

    Ok(())
}

fn ensure_not_paused(state: &RedeemState) -> Result<(), String> {
    if state.paused {
        return Err("redeem is paused".into());
    }

    Ok(())
}

fn ensure_nonzero_rates(
    vara_unit: u128,
    scrst_rate: u128,
    bcrst_rate: u128,
    hcrst_rate: u128,
) -> Result<(), String> {
    if vara_unit == 0 {
        return Err("VARA unit must be greater than zero".into());
    }
    if scrst_rate == 0 || bcrst_rate == 0 || hcrst_rate == 0 {
        return Err("redeem rates must be greater than zero".into());
    }

    Ok(())
}

fn calculate_payout(
    vara_unit: u128,
    rates: &Rates,
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
) -> Result<u128, String> {
    if scrst == 0 && bcrst == 0 && hcrst == 0 {
        return Err("at least one RES amount must be greater than zero".into());
    }

    let scrst_value = scrst
        .checked_mul(rates.scrst)
        .and_then(|value| value.checked_mul(vara_unit))
        .ok_or_else(|| "SCRST payout overflow".to_string())?;
    let bcrst_value = bcrst
        .checked_mul(rates.bcrst)
        .and_then(|value| value.checked_mul(vara_unit))
        .ok_or_else(|| "BCRST payout overflow".to_string())?;
    let hcrst_value = hcrst
        .checked_mul(rates.hcrst)
        .and_then(|value| value.checked_mul(vara_unit))
        .ok_or_else(|| "HCRST payout overflow".to_string())?;

    scrst_value
        .checked_add(bcrst_value)
        .and_then(|value| value.checked_add(hcrst_value))
        .ok_or_else(|| "total payout overflow".into())
}

fn encode_burn_for_redeem_call(
    redeem_id: u128,
    owner: ActorId,
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
) -> Vec<u8> {
    res_vmt_wire::burn_for_redeem_call(redeem_id, owner, scrst, bcrst, hcrst)
}

mod res_vmt_wire {
    use super::*;
    use sails_rs::InterfaceId;

    const SERVICE_ROUTE_ID: u8 = 1;
    const BURN_FOR_REDEEM_ENTRY_ID: u16 = 4;
    // Wire ID from the generated digger-res-vmt VMT service. A shared interface crate
    // would be preferable, but importing digger-res-vmt-client here would create a cycle.
    const SERVICE_INTERFACE_ID: InterfaceId =
        InterfaceId::from_bytes_8([78, 1, 228, 221, 128, 109, 82, 187]);

    pub fn burn_for_redeem_call(
        redeem_id: u128,
        owner: ActorId,
        scrst: u128,
        bcrst: u128,
        hcrst: u128,
    ) -> Vec<u8> {
        BurnForRedeem::encode_call(SERVICE_ROUTE_ID, redeem_id, owner, scrst, bcrst, hcrst)
    }

    sails_rs::io_struct_impl!(
        BurnForRedeem(
            redeem_id: u128,
            owner: ActorId,
            scrst: u128,
            bcrst: u128,
            hcrst: u128
        ) -> () | String,
        BURN_FOR_REDEEM_ENTRY_ID,
        SERVICE_INTERFACE_ID
    );
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum RedeemEvents {
    ReserveDeposited([u8; 32], u128, u128),
    ReserveSynced(u128, u128),
    Redeemed([u8; 32], u128, u128, u128, u128),
    RedeemRequested(u128, [u8; 32], u128, u128, u128, u128),
    RedeemCanceled(u128, [u8; 32], u128, u128, u128, u128),
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum AdminEvents {
    AdminAdded([u8; 32]),
    AdminRemoved([u8; 32]),
    ResContractUpdated([u8; 32], [u8; 32]),
    RatesUpdated(u128, u128, u128),
    RateConfigUpdated(u128, u128, u128, u128),
    Paused([u8; 32]),
    Unpaused([u8; 32]),
    FundsWithdrawn([u8; 32], u128, u128),
    PendingRedeemForceCanceled(u128, [u8; 32], u128, u128, u128, u128),
    PendingRedeemForcePaid(u128, [u8; 32], u128, u128, u128, u128),
}

pub struct RedeemService<'a> {
    state: &'a RefCell<RedeemState>,
}

impl<'a> RedeemService<'a> {
    pub fn new(state: &'a RefCell<RedeemState>) -> Self {
        Self { state }
    }
}

#[service(events = RedeemEvents)]
impl RedeemService<'_> {
    #[export(payable, unwrap_result)]
    pub fn deposit_reserve(&mut self) -> Result<u128, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        let deposited = state.sync_reserve_balance();

        self.emit_event(RedeemEvents::ReserveDeposited(
            caller.into_bytes(),
            deposited,
            state.reserve_balance,
        ))
        .expect("failed to emit reserve deposit event");

        Ok(state.reserve_balance)
    }

    #[export(unwrap_result)]
    pub fn redeem(&mut self, scrst: u128, bcrst: u128, hcrst: u128) -> Result<u128, String> {
        let caller = Syscall::message_source();
        let (redeem_id, res_contract, payout) = {
            let mut state = self.state.borrow_mut();

            ensure_not_paused(&state)?;
            state.sync_reserve_balance();

            let payout = calculate_payout(state.vara_unit, &state.rates, scrst, bcrst, hcrst)?;
            if payout > state.reserve_balance {
                return Err("insufficient reserve".into());
            }

            state.reserve_balance -= payout;
            state.locked_balance = state
                .locked_balance
                .checked_add(payout)
                .ok_or_else(|| "locked balance overflow".to_string())?;
            let redeem_id = state.next_redeem_id;
            state.next_redeem_id = state
                .next_redeem_id
                .checked_add(1)
                .ok_or_else(|| "redeem id overflow".to_string())?;
            state.pending_redemptions.insert(
                redeem_id,
                PendingRedeem {
                    beneficiary: caller,
                    scrst,
                    bcrst,
                    hcrst,
                    payout,
                },
            );

            (redeem_id, state.res_contract, payout)
        };

        self.emit_event(RedeemEvents::RedeemRequested(
            redeem_id,
            caller.into_bytes(),
            scrst,
            bcrst,
            hcrst,
            payout,
        ))
        .expect("failed to emit redeem request event");

        let payload = encode_burn_for_redeem_call(redeem_id, caller, scrst, bcrst, hcrst);
        if let Err(_error) = msg::send_bytes(res_contract, payload, 0) {
            self.restore_pending_redeem(redeem_id)?;
            return Err("failed to send RES burn request".into());
        }

        Ok(payout)
    }

    #[export(unwrap_result)]
    pub fn confirm_redeem(&mut self, redeem_id: u128) -> Result<u128, String> {
        let caller = Syscall::message_source();
        let (pending, synced) = {
            let mut state = self.state.borrow_mut();

            ensure_res_contract(&state, caller)?;
            let synced = state.sync_reserve_balance();
            let pending = state
                .pending_redemptions
                .remove(&redeem_id)
                .ok_or_else(|| "redeem request not found".to_string())?;

            (pending, synced)
        };

        if let Err(_error) = msg::send(pending.beneficiary, (), pending.payout) {
            let mut state = self.state.borrow_mut();
            state.pending_redemptions.insert(redeem_id, pending.clone());
            return Err("failed to send payout".into());
        }

        {
            let mut state = self.state.borrow_mut();
            state.locked_balance -= pending.payout;
            state.total_paid = state
                .total_paid
                .checked_add(pending.payout)
                .ok_or_else(|| "total paid overflow".to_string())?;
            state.total_redeemed_scrst = state
                .total_redeemed_scrst
                .checked_add(pending.scrst)
                .ok_or_else(|| "total redeemed SCRST overflow".to_string())?;
            state.total_redeemed_bcrst = state
                .total_redeemed_bcrst
                .checked_add(pending.bcrst)
                .ok_or_else(|| "total redeemed BCRST overflow".to_string())?;
            state.total_redeemed_hcrst = state
                .total_redeemed_hcrst
                .checked_add(pending.hcrst)
                .ok_or_else(|| "total redeemed HCRST overflow".to_string())?;
        }

        if synced > 0 {
            self.emit_event(RedeemEvents::ReserveSynced(
                synced,
                self.state.borrow().reserve_balance,
            ))
            .expect("failed to emit reserve sync event");
        }

        self.emit_event(RedeemEvents::Redeemed(
            pending.beneficiary.into_bytes(),
            pending.scrst,
            pending.bcrst,
            pending.hcrst,
            pending.payout,
        ))
        .expect("failed to emit redeem event");

        Ok(pending.payout)
    }

    #[export(unwrap_result)]
    pub fn cancel_redeem(&mut self, redeem_id: u128) -> Result<(), String> {
        let caller = Syscall::message_source();
        let pending = {
            let mut state = self.state.borrow_mut();

            ensure_res_contract(&state, caller)?;
            state
                .pending_redemptions
                .remove(&redeem_id)
                .ok_or_else(|| "redeem request not found".to_string())?
        };

        {
            let mut state = self.state.borrow_mut();
            state.locked_balance -= pending.payout;
            state.reserve_balance = state
                .reserve_balance
                .checked_add(pending.payout)
                .ok_or_else(|| "reserve balance overflow".to_string())?;
        }

        self.emit_event(RedeemEvents::RedeemCanceled(
            redeem_id,
            pending.beneficiary.into_bytes(),
            pending.scrst,
            pending.bcrst,
            pending.hcrst,
            pending.payout,
        ))
        .expect("failed to emit redeem cancel event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn reserve_balance(&self) -> Result<u128, String> {
        Ok(self.state.borrow().reserve_balance)
    }

    #[export(unwrap_result)]
    pub fn available_reserve(&self) -> Result<u128, String> {
        Ok(self.state.borrow().reserve_balance)
    }

    #[export(unwrap_result)]
    pub fn total_paid(&self) -> Result<u128, String> {
        Ok(self.state.borrow().total_paid)
    }

    #[export(unwrap_result)]
    pub fn locked_balance(&self) -> Result<u128, String> {
        Ok(self.state.borrow().locked_balance)
    }

    #[export(unwrap_result)]
    pub fn pending_redeem_count(&self) -> Result<u128, String> {
        Ok(self.state.borrow().pending_redemptions.len() as u128)
    }

    #[export(unwrap_result)]
    pub fn total_redeemed_scrst(&self) -> Result<u128, String> {
        Ok(self.state.borrow().total_redeemed_scrst)
    }

    #[export(unwrap_result)]
    pub fn total_redeemed_bcrst(&self) -> Result<u128, String> {
        Ok(self.state.borrow().total_redeemed_bcrst)
    }

    #[export(unwrap_result)]
    pub fn total_redeemed_hcrst(&self) -> Result<u128, String> {
        Ok(self.state.borrow().total_redeemed_hcrst)
    }

    #[export(unwrap_result)]
    pub fn scrst_rate(&self) -> Result<u128, String> {
        Ok(self.state.borrow().rates.scrst)
    }

    #[export(unwrap_result)]
    pub fn bcrst_rate(&self) -> Result<u128, String> {
        Ok(self.state.borrow().rates.bcrst)
    }

    #[export(unwrap_result)]
    pub fn hcrst_rate(&self) -> Result<u128, String> {
        Ok(self.state.borrow().rates.hcrst)
    }

    #[export(unwrap_result)]
    pub fn vara_unit(&self) -> Result<u128, String> {
        Ok(self.state.borrow().vara_unit)
    }
}

impl RedeemService<'_> {
    fn restore_pending_redeem(&mut self, redeem_id: u128) -> Result<(), String> {
        let pending = {
            let mut state = self.state.borrow_mut();
            state
                .pending_redemptions
                .remove(&redeem_id)
                .ok_or_else(|| "redeem request not found".to_string())?
        };

        let mut state = self.state.borrow_mut();
        state.locked_balance -= pending.payout;
        state.reserve_balance = state
            .reserve_balance
            .checked_add(pending.payout)
            .ok_or_else(|| "reserve balance overflow".to_string())?;

        Ok(())
    }
}

pub struct AdminService<'a> {
    state: &'a RefCell<RedeemState>,
}

impl<'a> AdminService<'a> {
    pub fn new(state: &'a RefCell<RedeemState>) -> Self {
        Self { state }
    }
}

#[service(events = AdminEvents)]
impl AdminService<'_> {
    #[export(unwrap_result)]
    pub fn admins(&self) -> Result<Vec<ActorId>, String> {
        Ok(active_admins(&self.state.borrow().admins))
    }

    #[export(unwrap_result)]
    pub fn is_admin(&self, account: ActorId) -> Result<bool, String> {
        Ok(self
            .state
            .borrow()
            .admins
            .get(&account)
            .copied()
            .unwrap_or(false))
    }

    #[export(unwrap_result)]
    pub fn res_contract(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().res_contract)
    }

    #[export(unwrap_result)]
    pub fn is_paused(&self) -> Result<bool, String> {
        Ok(self.state.borrow().paused)
    }

    #[export(unwrap_result)]
    pub fn set_res_contract(&mut self, res_contract: ActorId) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        state.res_contract = res_contract;

        self.emit_event(AdminEvents::ResContractUpdated(
            caller.into_bytes(),
            res_contract.into_bytes(),
        ))
        .expect("failed to emit RES contract update event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn add_admin(&mut self, admin: ActorId) -> Result<bool, String> {
        if admin == ActorId::zero() {
            return Err("admin cannot be zero address".into());
        }

        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if state.admins.get(&admin).copied().unwrap_or(false) {
            return Ok(false);
        }

        state.admins.insert(admin, true);
        self.emit_event(AdminEvents::AdminAdded(admin.into_bytes()))
            .expect("failed to emit admin add event");

        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn remove_admin(&mut self, admin: ActorId) -> Result<bool, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if !state.admins.get(&admin).copied().unwrap_or(false) {
            return Ok(false);
        }
        if state.admins.len() == 1 {
            return Err("cannot remove the last admin".into());
        }

        state.admins.remove(&admin);
        self.emit_event(AdminEvents::AdminRemoved(admin.into_bytes()))
            .expect("failed to emit admin remove event");

        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn set_rates(
        &mut self,
        scrst_rate: u128,
        bcrst_rate: u128,
        hcrst_rate: u128,
    ) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        ensure_nonzero_rates(state.vara_unit, scrst_rate, bcrst_rate, hcrst_rate)?;
        state.rates = Rates::new(scrst_rate, bcrst_rate, hcrst_rate);

        self.emit_event(AdminEvents::RatesUpdated(
            scrst_rate, bcrst_rate, hcrst_rate,
        ))
        .expect("failed to emit rates update event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_rate_config(
        &mut self,
        vara_unit: u128,
        scrst_rate: u128,
        bcrst_rate: u128,
        hcrst_rate: u128,
    ) -> Result<(), String> {
        ensure_nonzero_rates(vara_unit, scrst_rate, bcrst_rate, hcrst_rate)?;

        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        state.vara_unit = vara_unit;
        state.rates = Rates::new(scrst_rate, bcrst_rate, hcrst_rate);

        self.emit_event(AdminEvents::RateConfigUpdated(
            vara_unit, scrst_rate, bcrst_rate, hcrst_rate,
        ))
        .expect("failed to emit rate config update event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if state.paused {
            return Err("redeem is already paused".into());
        }

        state.paused = true;

        self.emit_event(AdminEvents::Paused(caller.into_bytes()))
            .expect("failed to emit pause event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn unpause(&mut self) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if !state.paused {
            return Err("redeem is not paused".into());
        }

        state.paused = false;

        self.emit_event(AdminEvents::Unpaused(caller.into_bytes()))
            .expect("failed to emit unpause event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn withdraw_funds(&mut self, amount: u128) -> Result<CommandReply<()>, String> {
        if amount == 0 {
            return Err("withdraw amount must be greater than zero".into());
        }

        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        state.sync_reserve_balance();

        if amount > state.reserve_balance {
            return Err("insufficient reserve".into());
        }

        state.reserve_balance -= amount;

        self.emit_event(AdminEvents::FundsWithdrawn(
            caller.into_bytes(),
            amount,
            state.reserve_balance,
        ))
        .expect("failed to emit funds withdrawal event");

        Ok(CommandReply::new(()).with_value(amount))
    }

    #[export(unwrap_result)]
    pub fn force_cancel_redeem(&mut self, redeem_id: u128) -> Result<(), String> {
        let caller = Syscall::message_source();
        let pending = {
            let mut state = self.state.borrow_mut();

            ensure_admin(&state, caller)?;
            state
                .pending_redemptions
                .remove(&redeem_id)
                .ok_or_else(|| "redeem request not found".to_string())?
        };

        {
            let mut state = self.state.borrow_mut();
            state.locked_balance -= pending.payout;
            state.reserve_balance = state
                .reserve_balance
                .checked_add(pending.payout)
                .ok_or_else(|| "reserve balance overflow".to_string())?;
        }

        self.emit_event(AdminEvents::PendingRedeemForceCanceled(
            redeem_id,
            pending.beneficiary.into_bytes(),
            pending.scrst,
            pending.bcrst,
            pending.hcrst,
            pending.payout,
        ))
        .expect("failed to emit pending redeem force cancel event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn force_pay_redeem(&mut self, redeem_id: u128) -> Result<CommandReply<()>, String> {
        let caller = Syscall::message_source();
        let pending = {
            let mut state = self.state.borrow_mut();

            ensure_admin(&state, caller)?;
            state
                .pending_redemptions
                .remove(&redeem_id)
                .ok_or_else(|| "redeem request not found".to_string())?
        };

        {
            let mut state = self.state.borrow_mut();
            state.locked_balance -= pending.payout;
            state.total_paid = state
                .total_paid
                .checked_add(pending.payout)
                .ok_or_else(|| "total paid overflow".to_string())?;
            state.total_redeemed_scrst = state
                .total_redeemed_scrst
                .checked_add(pending.scrst)
                .ok_or_else(|| "total redeemed SCRST overflow".to_string())?;
            state.total_redeemed_bcrst = state
                .total_redeemed_bcrst
                .checked_add(pending.bcrst)
                .ok_or_else(|| "total redeemed BCRST overflow".to_string())?;
            state.total_redeemed_hcrst = state
                .total_redeemed_hcrst
                .checked_add(pending.hcrst)
                .ok_or_else(|| "total redeemed HCRST overflow".to_string())?;
        }

        self.emit_event(AdminEvents::PendingRedeemForcePaid(
            redeem_id,
            pending.beneficiary.into_bytes(),
            pending.scrst,
            pending.bcrst,
            pending.hcrst,
            pending.payout,
        ))
        .expect("failed to emit pending redeem force paid event");

        Ok(CommandReply::new(()).with_value(pending.payout))
    }
}

pub struct Program {
    state: RefCell<RedeemState>,
}

#[program]
impl Program {
    pub fn create(
        res_contract: ActorId,
        vara_unit: u128,
        scrst_rate: u128,
        bcrst_rate: u128,
        hcrst_rate: u128,
    ) -> Self {
        ensure_nonzero_rates(vara_unit, scrst_rate, bcrst_rate, hcrst_rate)
            .expect("invalid redeem rate config");

        let admin = Syscall::message_source();
        Self {
            state: RefCell::new(RedeemState::new_with_rates(
                admin,
                res_contract,
                vara_unit,
                Rates::new(scrst_rate, bcrst_rate, hcrst_rate),
            )),
        }
    }

    pub fn redeem(&self) -> RedeemService<'_> {
        RedeemService::new(&self.state)
    }

    pub fn admin(&self) -> AdminService<'_> {
        AdminService::new(&self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VARA_UNIT: u128 = 1_000_000_000_000;
    const SCRST_RATE: u128 = 6;
    const BCRST_RATE: u128 = 30;
    const HCRST_RATE: u128 = 150;

    #[test]
    fn calculates_configured_resource_payout() {
        let payout = calculate_payout(
            VARA_UNIT,
            &Rates::new(SCRST_RATE, BCRST_RATE, HCRST_RATE),
            2,
            3,
            1,
        )
        .expect("payout");

        assert_eq!(payout, (2 * SCRST_RATE + 3 * BCRST_RATE + HCRST_RATE) * VARA_UNIT);
    }

    #[test]
    fn rejects_empty_redeem() {
        let error = calculate_payout(
            VARA_UNIT,
            &Rates::new(SCRST_RATE, BCRST_RATE, HCRST_RATE),
            0,
            0,
            0,
        )
        .expect_err("must fail");

        assert_eq!(error, "at least one RES amount must be greater than zero");
    }

    #[test]
    fn detects_payout_overflow() {
        let error = calculate_payout(VARA_UNIT, &Rates::new(SCRST_RATE, BCRST_RATE, HCRST_RATE), u128::MAX, 0, 0)
            .expect_err("must fail");

        assert_eq!(error, "SCRST payout overflow");
    }

    #[test]
    fn burn_for_redeem_wire_payload_matches_res_vmt_client() {
        let redeem_id = 7;
        let owner = ActorId::new([9; 32]);
        let scrst = 2;
        let bcrst = 3;
        let hcrst = 1;

        let actual = res_vmt_wire::burn_for_redeem_call(redeem_id, owner, scrst, bcrst, hcrst);
        let expected = digger_res_vmt_client::vmt::io::BurnForRedeem::encode_call(
            digger_res_vmt_client::DiggerResVmtClientProgram::ROUTE_ID_VMT,
            redeem_id,
            owner,
            scrst,
            bcrst,
            hcrst,
        );

        assert_eq!(actual, expected);
    }
}
