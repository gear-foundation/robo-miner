#![no_std]

use digger_redeem_client::{
    DiggerRedeemClient as _, DiggerRedeemClientProgram, redeem::Redeem as _,
};
use sails_rs::{cell::RefCell, client::Program as _, collections::BTreeMap, prelude::*};

pub type TokenId = u128;
pub type TokenAmount = u128;

pub const SCRST_ID: TokenId = 0;
pub const BCRST_ID: TokenId = 1;
pub const HCRST_ID: TokenId = 2;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct VmtLedger {
    balances: BTreeMap<TokenId, BTreeMap<ActorId, TokenAmount>>,
    approvals: BTreeMap<ActorId, BTreeMap<ActorId, bool>>,
    total_supply: BTreeMap<TokenId, TokenAmount>,
}

impl VmtLedger {
    fn balance_of(&self, account: ActorId, id: TokenId) -> TokenAmount {
        self.balances
            .get(&id)
            .and_then(|balances| balances.get(&account))
            .copied()
            .unwrap_or(0)
    }

    fn is_approved(&self, account: ActorId, operator: ActorId) -> bool {
        self.approvals
            .get(&account)
            .and_then(|operators| operators.get(&operator))
            .copied()
            .unwrap_or(false)
    }

    fn approve(&mut self, owner: ActorId, operator: ActorId) -> Result<bool, String> {
        if operator == ActorId::zero() {
            return Err("operator cannot be zero address".into());
        }
        if owner == operator {
            return Ok(false);
        }

        self.approvals
            .entry(owner)
            .or_default()
            .insert(operator, true);

        Ok(true)
    }

    fn mint_batch(
        &mut self,
        to: ActorId,
        ids: &[TokenId],
        amounts: &[TokenAmount],
    ) -> Result<(), String> {
        if to == ActorId::zero() {
            return Err("recipient cannot be zero address".into());
        }
        ensure_batch_shape(ids, amounts)?;
        ensure_nonzero_batch(amounts)?;

        for (id, amount) in ids.iter().zip(amounts.iter()) {
            self.add_balance(to, *id, *amount)?;
            self.add_supply(*id, *amount)?;
        }

        Ok(())
    }

    fn burn_batch(
        &mut self,
        from: ActorId,
        ids: &[TokenId],
        amounts: &[TokenAmount],
    ) -> Result<(), String> {
        ensure_batch_shape(ids, amounts)?;
        ensure_nonzero_batch(amounts)?;

        for (id, amount) in ids.iter().zip(amounts.iter()) {
            if self.balance_of(from, *id) < *amount {
                return Err("insufficient VMT balance".into());
            }
        }

        for (id, amount) in ids.iter().zip(amounts.iter()) {
            self.sub_balance(from, *id, *amount)?;
            self.sub_supply(*id, *amount)?;
        }

        Ok(())
    }

    fn transfer_batch(
        &mut self,
        caller: ActorId,
        from: ActorId,
        to: ActorId,
        ids: &[TokenId],
        amounts: &[TokenAmount],
    ) -> Result<(), String> {
        if from == to {
            return Err("cannot transfer to self".into());
        }
        if to == ActorId::zero() {
            return Err("recipient cannot be zero address".into());
        }
        if caller != from && !self.is_approved(from, caller) {
            return Err("caller is not owner or approved".into());
        }

        ensure_batch_shape(ids, amounts)?;
        ensure_nonzero_batch(amounts)?;

        for (id, amount) in ids.iter().zip(amounts.iter()) {
            if self.balance_of(from, *id) < *amount {
                return Err("insufficient VMT balance".into());
            }
        }

        for (id, amount) in ids.iter().zip(amounts.iter()) {
            self.sub_balance(from, *id, *amount)?;
            self.add_balance(to, *id, *amount)?;
        }

        Ok(())
    }

    fn add_balance(
        &mut self,
        account: ActorId,
        id: TokenId,
        amount: TokenAmount,
    ) -> Result<(), String> {
        let balance = self
            .balances
            .entry(id)
            .or_default()
            .entry(account)
            .or_insert(0);
        *balance = balance
            .checked_add(amount)
            .ok_or_else(|| "VMT balance overflow".to_string())?;
        Ok(())
    }

    fn sub_balance(
        &mut self,
        account: ActorId,
        id: TokenId,
        amount: TokenAmount,
    ) -> Result<(), String> {
        let balance = self
            .balances
            .entry(id)
            .or_default()
            .entry(account)
            .or_insert(0);
        *balance = balance
            .checked_sub(amount)
            .ok_or_else(|| "VMT balance underflow".to_string())?;
        Ok(())
    }

    fn add_supply(&mut self, id: TokenId, amount: TokenAmount) -> Result<(), String> {
        let supply = self.total_supply.entry(id).or_insert(0);
        *supply = supply
            .checked_add(amount)
            .ok_or_else(|| "VMT total supply overflow".to_string())?;
        Ok(())
    }

    fn sub_supply(&mut self, id: TokenId, amount: TokenAmount) -> Result<(), String> {
        let supply = self.total_supply.entry(id).or_insert(0);
        *supply = supply
            .checked_sub(amount)
            .ok_or_else(|| "VMT total supply underflow".to_string())?;
        Ok(())
    }
}

pub struct ResVmtState {
    admins: BTreeMap<ActorId, bool>,
    minters: BTreeMap<ActorId, bool>,
    redeem_contract: ActorId,
    ledger: VmtLedger,
    paused: bool,
}

impl ResVmtState {
    fn new(admin: ActorId, redeem_contract: ActorId, minter: ActorId) -> Self {
        let mut admins = BTreeMap::new();
        admins.insert(admin, true);
        let mut minters = BTreeMap::new();
        minters.insert(minter, true);

        Self {
            admins,
            minters,
            redeem_contract,
            ledger: VmtLedger::default(),
            paused: false,
        }
    }
}

fn ensure_admin(state: &ResVmtState, caller: ActorId) -> Result<(), String> {
    if !state.admins.get(&caller).copied().unwrap_or(false) {
        return Err("caller is not admin".into());
    }

    Ok(())
}

fn ensure_minter(state: &ResVmtState, caller: ActorId) -> Result<(), String> {
    if !state.minters.get(&caller).copied().unwrap_or(false) {
        return Err("caller is not minter".into());
    }

    Ok(())
}

fn active_role_members(members: &BTreeMap<ActorId, bool>) -> Vec<ActorId> {
    members
        .iter()
        .filter_map(|(actor, active)| if *active { Some(*actor) } else { None })
        .collect()
}

fn ensure_redeem_contract(state: &ResVmtState, caller: ActorId) -> Result<(), String> {
    if state.redeem_contract != caller {
        return Err("caller is not redeem contract".into());
    }

    Ok(())
}

fn ensure_not_paused(state: &ResVmtState) -> Result<(), String> {
    if state.paused {
        return Err("RES VMT is paused".into());
    }

    Ok(())
}

fn ensure_batch_shape(ids: &[TokenId], amounts: &[TokenAmount]) -> Result<(), String> {
    if ids.len() != amounts.len() {
        return Err("token ids and amounts length mismatch".into());
    }
    if ids.is_empty() {
        return Err("at least one token amount must be provided".into());
    }

    Ok(())
}

fn ensure_nonzero_batch(amounts: &[TokenAmount]) -> Result<(), String> {
    if amounts.iter().all(|amount| *amount == 0) {
        return Err("at least one VMT amount must be greater than zero".into());
    }

    Ok(())
}

fn resource_ids_and_amounts(
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
) -> (Vec<TokenId>, Vec<TokenAmount>) {
    (
        vec![SCRST_ID, BCRST_ID, HCRST_ID],
        vec![scrst, bcrst, hcrst],
    )
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum VmtEvents {
    Approval([u8; 32], [u8; 32]),
    Transfer([u8; 32], [u8; 32], TokenId, TokenAmount),
    BatchTransfer([u8; 32], [u8; 32]),
    Minted([u8; 32], u128, u128, u128),
    Burned([u8; 32], u128, u128, u128),
    RedeemBurnRejected(u128, [u8; 32], u128, u128, u128),
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum AdminEvents {
    AdminAdded([u8; 32]),
    AdminRemoved([u8; 32]),
    MinterAdded([u8; 32]),
    MinterRemoved([u8; 32]),
    RedeemContractUpdated([u8; 32], [u8; 32]),
    Paused([u8; 32]),
    Unpaused([u8; 32]),
}

pub struct VmtService<'a> {
    state: &'a RefCell<ResVmtState>,
}

impl<'a> VmtService<'a> {
    pub fn new(state: &'a RefCell<ResVmtState>) -> Self {
        Self { state }
    }
}

#[service(events = VmtEvents)]
impl VmtService<'_> {
    #[export(unwrap_result)]
    pub fn approve(&mut self, operator: ActorId) -> Result<bool, String> {
        let owner = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_not_paused(&state)?;
        let approved = state.ledger.approve(owner, operator)?;
        if approved {
            self.emit_event(VmtEvents::Approval(
                owner.into_bytes(),
                operator.into_bytes(),
            ))
            .expect("failed to emit approval event");
        }

        Ok(approved)
    }

    #[export(unwrap_result)]
    pub fn transfer_from(
        &mut self,
        from: ActorId,
        to: ActorId,
        id: TokenId,
        amount: TokenAmount,
    ) -> Result<(), String> {
        self.batch_transfer_from(from, to, vec![id], vec![amount])
    }

    #[export(unwrap_result)]
    pub fn batch_transfer_from(
        &mut self,
        from: ActorId,
        to: ActorId,
        ids: Vec<TokenId>,
        amounts: Vec<TokenAmount>,
    ) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_not_paused(&state)?;
        state
            .ledger
            .transfer_batch(caller, from, to, &ids, &amounts)?;

        if ids.len() == 1 {
            self.emit_event(VmtEvents::Transfer(
                from.into_bytes(),
                to.into_bytes(),
                ids[0],
                amounts[0],
            ))
            .expect("failed to emit transfer event");
        } else {
            self.emit_event(VmtEvents::BatchTransfer(from.into_bytes(), to.into_bytes()))
                .expect("failed to emit batch transfer event");
        }

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn mint_resources(
        &mut self,
        to: ActorId,
        scrst: u128,
        bcrst: u128,
        hcrst: u128,
    ) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_not_paused(&state)?;
        ensure_minter(&state, caller)?;
        let (ids, amounts) = resource_ids_and_amounts(scrst, bcrst, hcrst);
        state.ledger.mint_batch(to, &ids, &amounts)?;

        self.emit_event(VmtEvents::Minted(to.into_bytes(), scrst, bcrst, hcrst))
            .expect("failed to emit mint event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn burn_for_redeem(
        &mut self,
        redeem_id: u128,
        owner: ActorId,
        scrst: u128,
        bcrst: u128,
        hcrst: u128,
    ) -> Result<(), String> {
        let caller = Syscall::message_source();
        let (ids, amounts) = resource_ids_and_amounts(scrst, bcrst, hcrst);
        let mut state = self.state.borrow_mut();

        ensure_redeem_contract(&state, caller)?;
        if state.paused {
            drop(state);
            let redeem_program = DiggerRedeemClientProgram::client(caller);
            let mut redeem = redeem_program.redeem();
            redeem
                .cancel_redeem(redeem_id)
                .send_one_way()
                .map_err(|_| "failed to send redeem cancel".to_string())?;
            self.emit_event(VmtEvents::RedeemBurnRejected(
                redeem_id,
                owner.into_bytes(),
                scrst,
                bcrst,
                hcrst,
            ))
            .expect("failed to emit burn reject event");
            return Ok(());
        }
        if state.ledger.burn_batch(owner, &ids, &amounts).is_err() {
            drop(state);
            let redeem_program = DiggerRedeemClientProgram::client(caller);
            let mut redeem = redeem_program.redeem();
            redeem
                .cancel_redeem(redeem_id)
                .send_one_way()
                .map_err(|_| "failed to send redeem cancel".to_string())?;
            self.emit_event(VmtEvents::RedeemBurnRejected(
                redeem_id,
                owner.into_bytes(),
                scrst,
                bcrst,
                hcrst,
            ))
            .expect("failed to emit burn reject event");
            return Ok(());
        }
        drop(state);

        let redeem_program = DiggerRedeemClientProgram::client(caller);
        let mut redeem = redeem_program.redeem();
        redeem
            .confirm_redeem(redeem_id)
            .send_one_way()
            .map_err(|_| "failed to send redeem confirmation".to_string())?;

        self.emit_event(VmtEvents::Burned(owner.into_bytes(), scrst, bcrst, hcrst))
            .expect("failed to emit burn event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn balance_of(&self, account: ActorId, id: TokenId) -> Result<TokenAmount, String> {
        Ok(self.state.borrow().ledger.balance_of(account, id))
    }

    #[export(unwrap_result)]
    pub fn is_approved(&self, account: ActorId, operator: ActorId) -> Result<bool, String> {
        Ok(self.state.borrow().ledger.is_approved(account, operator))
    }

    #[export(unwrap_result)]
    pub fn total_supply_of(&self, id: TokenId) -> Result<TokenAmount, String> {
        Ok(self
            .state
            .borrow()
            .ledger
            .total_supply
            .get(&id)
            .copied()
            .unwrap_or(0))
    }

    #[export(unwrap_result)]
    pub fn name(&self) -> Result<String, String> {
        Ok("Digger Resources".into())
    }

    #[export(unwrap_result)]
    pub fn symbol(&self) -> Result<String, String> {
        Ok("DRES".into())
    }

    #[export(unwrap_result)]
    pub fn decimals(&self) -> Result<u128, String> {
        Ok(0)
    }

    #[export(unwrap_result)]
    pub fn scrst_token_id(&self) -> Result<TokenId, String> {
        Ok(SCRST_ID)
    }

    #[export(unwrap_result)]
    pub fn bcrst_token_id(&self) -> Result<TokenId, String> {
        Ok(BCRST_ID)
    }

    #[export(unwrap_result)]
    pub fn hcrst_token_id(&self) -> Result<TokenId, String> {
        Ok(HCRST_ID)
    }
}

pub struct AdminService<'a> {
    state: &'a RefCell<ResVmtState>,
}

impl<'a> AdminService<'a> {
    pub fn new(state: &'a RefCell<ResVmtState>) -> Self {
        Self { state }
    }
}

#[service(events = AdminEvents)]
impl AdminService<'_> {
    #[export(unwrap_result)]
    pub fn admins(&self) -> Result<Vec<ActorId>, String> {
        Ok(active_role_members(&self.state.borrow().admins))
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
    pub fn minters(&self) -> Result<Vec<ActorId>, String> {
        Ok(active_role_members(&self.state.borrow().minters))
    }

    #[export(unwrap_result)]
    pub fn is_minter(&self, account: ActorId) -> Result<bool, String> {
        Ok(self
            .state
            .borrow()
            .minters
            .get(&account)
            .copied()
            .unwrap_or(false))
    }

    #[export(unwrap_result)]
    pub fn redeem_contract(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().redeem_contract)
    }

    #[export(unwrap_result)]
    pub fn is_paused(&self) -> Result<bool, String> {
        Ok(self.state.borrow().paused)
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
    pub fn add_minter(&mut self, minter: ActorId) -> Result<bool, String> {
        if minter == ActorId::zero() {
            return Err("minter cannot be zero address".into());
        }

        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if state.minters.get(&minter).copied().unwrap_or(false) {
            return Ok(false);
        }

        state.minters.insert(minter, true);
        self.emit_event(AdminEvents::MinterAdded(minter.into_bytes()))
            .expect("failed to emit minter add event");

        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn remove_minter(&mut self, minter: ActorId) -> Result<bool, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if !state.minters.get(&minter).copied().unwrap_or(false) {
            return Ok(false);
        }
        if state.minters.len() == 1 {
            return Err("cannot remove the last minter".into());
        }

        state.minters.remove(&minter);
        self.emit_event(AdminEvents::MinterRemoved(minter.into_bytes()))
            .expect("failed to emit minter remove event");

        Ok(true)
    }

    #[export(unwrap_result)]
    pub fn set_redeem_contract(&mut self, redeem_contract: ActorId) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        state.redeem_contract = redeem_contract;

        self.emit_event(AdminEvents::RedeemContractUpdated(
            caller.into_bytes(),
            redeem_contract.into_bytes(),
        ))
        .expect("failed to emit redeem contract update event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if state.paused {
            return Err("RES VMT is already paused".into());
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
            return Err("RES VMT is not paused".into());
        }

        state.paused = false;

        self.emit_event(AdminEvents::Unpaused(caller.into_bytes()))
            .expect("failed to emit unpause event");

        Ok(())
    }
}

pub struct Program {
    state: RefCell<ResVmtState>,
}

#[program]
impl Program {
    pub fn create(redeem_contract: ActorId, minter: ActorId) -> Self {
        let admin = Syscall::message_source();
        Self {
            state: RefCell::new(ResVmtState::new(admin, redeem_contract, minter)),
        }
    }

    pub fn vmt(&self) -> VmtService<'_> {
        VmtService::new(&self.state)
    }

    pub fn admin(&self) -> AdminService<'_> {
        AdminService::new(&self.state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALICE: ActorId = ActorId::new([1; 32]);
    const BOB: ActorId = ActorId::new([2; 32]);

    #[test]
    fn transfers_vmt_resource_token_ids() {
        let mut ledger = VmtLedger::default();
        let ids = vec![SCRST_ID, BCRST_ID, HCRST_ID];
        let amounts = vec![10, 2, 1];

        ledger.mint_batch(ALICE, &ids, &amounts).expect("mint");
        ledger
            .transfer_batch(ALICE, ALICE, BOB, &[SCRST_ID, BCRST_ID], &[4, 1])
            .expect("transfer");

        assert_eq!(ledger.balance_of(ALICE, SCRST_ID), 6);
        assert_eq!(ledger.balance_of(ALICE, BCRST_ID), 1);
        assert_eq!(ledger.balance_of(BOB, SCRST_ID), 4);
        assert_eq!(ledger.balance_of(BOB, BCRST_ID), 1);
        assert_eq!(ledger.balance_of(BOB, HCRST_ID), 0);
    }

    #[test]
    fn rejects_empty_vmt_resource_amount() {
        let mut ledger = VmtLedger::default();
        let (ids, amounts) = resource_ids_and_amounts(0, 0, 0);
        let error = ledger
            .mint_batch(ALICE, &ids, &amounts)
            .expect_err("must fail");

        assert_eq!(error, "at least one VMT amount must be greater than zero");
    }

    #[test]
    fn approved_operator_can_transfer_vmt_resources() {
        let mut ledger = VmtLedger::default();
        ledger.mint_batch(ALICE, &[SCRST_ID], &[5]).expect("mint");
        ledger.approve(ALICE, BOB).expect("approve");
        ledger
            .transfer_batch(BOB, ALICE, BOB, &[SCRST_ID], &[2])
            .expect("operator transfer");

        assert_eq!(ledger.balance_of(ALICE, SCRST_ID), 3);
        assert_eq!(ledger.balance_of(BOB, SCRST_ID), 2);
    }
}
