#![no_std]

use sails_rs::{cell::RefCell, collections::BTreeMap, prelude::*};

const MAX_RECORDS: u128 = 1024;
const MAX_RECENT_QUERY: u32 = 50;
const MAX_KIND_LEN: usize = 64;
const MAX_EXTERNAL_REF_LEN: usize = 160;
const MAX_SUMMARY_LEN: usize = 512;
const HEX_HASH_LEN: usize = 66;

#[derive(Clone, Debug, PartialEq, Eq, Encode, Decode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
#[reflect_hash(crate = sails_rs)]
pub struct ProofReceipt {
    pub id: u128,
    pub submitter: ActorId,
    pub subject_app: ActorId,
    pub target_app: ActorId,
    pub proof_kind: String,
    pub proof_tx_hash: String,
    pub evidence_hash: String,
    pub external_ref: String,
    pub summary: String,
}

pub struct ProofPackState {
    owner: ActorId,
    paused: bool,
    next_id: u128,
    receipts: BTreeMap<u128, ProofReceipt>,
    by_subject: BTreeMap<ActorId, Vec<u128>>,
    by_target: BTreeMap<ActorId, Vec<u128>>,
    by_proof_tx_hash: BTreeMap<String, u128>,
}

impl ProofPackState {
    fn new(owner: ActorId) -> Self {
        Self {
            owner,
            paused: false,
            next_id: 1,
            receipts: BTreeMap::new(),
            by_subject: BTreeMap::new(),
            by_target: BTreeMap::new(),
            by_proof_tx_hash: BTreeMap::new(),
        }
    }
}

fn ensure_owner(state: &ProofPackState, caller: ActorId) -> Result<(), String> {
    if state.owner != caller {
        return Err("caller is not owner".into());
    }

    Ok(())
}

fn ensure_not_paused(state: &ProofPackState) -> Result<(), String> {
    if state.paused {
        return Err("proof pack is paused".into());
    }

    Ok(())
}

fn ensure_nonzero(actor: ActorId, label: &str) -> Result<(), String> {
    if actor == ActorId::zero() {
        return Err(format!("{label} cannot be zero"));
    }

    Ok(())
}

fn ensure_bounded(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max_len {
        return Err(format!("{label} is too long"));
    }

    Ok(())
}

fn ensure_optional_bounded(value: &str, label: &str, max_len: usize) -> Result<(), String> {
    if value.len() > max_len {
        return Err(format!("{label} is too long"));
    }

    Ok(())
}

fn ensure_hex_hash(value: &str, label: &str) -> Result<(), String> {
    if value.len() != HEX_HASH_LEN || !value.starts_with("0x") {
        return Err(format!("{label} must be a 32-byte 0x hex hash"));
    }
    if !value.as_bytes()[2..]
        .iter()
        .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!("{label} must be a 32-byte 0x hex hash"));
    }

    Ok(())
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
#[reflect_hash(crate = sails_rs)]
pub enum ProofPackEvents {
    ReceiptSubmitted(u128, [u8; 32], [u8; 32], [u8; 32], String, String, String),
    Paused([u8; 32]),
    Unpaused([u8; 32]),
}

pub struct ProofPackService<'a> {
    state: &'a RefCell<ProofPackState>,
}

impl<'a> ProofPackService<'a> {
    pub fn new(state: &'a RefCell<ProofPackState>) -> Self {
        Self { state }
    }
}

#[service(events = ProofPackEvents)]
impl ProofPackService<'_> {
    #[export(unwrap_result)]
    pub fn submit_receipt(
        &mut self,
        subject_app: ActorId,
        target_app: ActorId,
        proof_kind: String,
        proof_tx_hash: String,
        evidence_hash: String,
        external_ref: String,
        summary: String,
    ) -> Result<ProofReceipt, String> {
        let submitter = Syscall::message_source();
        ensure_nonzero(subject_app, "subject app")?;
        ensure_nonzero(target_app, "target app")?;
        ensure_bounded(&proof_kind, "proof kind", MAX_KIND_LEN)?;
        ensure_hex_hash(&proof_tx_hash, "proof tx hash")?;
        ensure_hex_hash(&evidence_hash, "evidence hash")?;
        ensure_optional_bounded(&external_ref, "external ref", MAX_EXTERNAL_REF_LEN)?;
        ensure_bounded(&summary, "summary", MAX_SUMMARY_LEN)?;

        let receipt = {
            let mut state = self.state.borrow_mut();
            ensure_not_paused(&state)?;
            if state.receipts.len() as u128 >= MAX_RECORDS {
                return Err("receipt storage is full".into());
            }
            if state.by_proof_tx_hash.contains_key(&proof_tx_hash) {
                return Err("proof tx hash already exists".into());
            }

            let id = state.next_id;
            state.next_id = state
                .next_id
                .checked_add(1)
                .ok_or_else(|| "receipt id overflow".to_string())?;
            let receipt = ProofReceipt {
                id,
                submitter,
                subject_app,
                target_app,
                proof_kind,
                proof_tx_hash,
                evidence_hash,
                external_ref,
                summary,
            };
            state.receipts.insert(id, receipt.clone());
            state.by_subject.entry(subject_app).or_default().push(id);
            state.by_target.entry(target_app).or_default().push(id);
            state
                .by_proof_tx_hash
                .insert(receipt.proof_tx_hash.clone(), id);
            receipt
        };

        self.emit_event(ProofPackEvents::ReceiptSubmitted(
            receipt.id,
            receipt.submitter.into_bytes(),
            receipt.subject_app.into_bytes(),
            receipt.target_app.into_bytes(),
            receipt.proof_kind.clone(),
            receipt.proof_tx_hash.clone(),
            receipt.evidence_hash.clone(),
        ))
        .expect("failed to emit receipt submitted event");

        Ok(receipt)
    }

    #[export]
    pub fn get_receipt(&self, id: u128) -> Option<ProofReceipt> {
        self.state.borrow().receipts.get(&id).cloned()
    }

    #[export]
    pub fn receipts_for_subject(&self, subject_app: ActorId) -> Vec<u128> {
        self.state
            .borrow()
            .by_subject
            .get(&subject_app)
            .cloned()
            .unwrap_or_default()
    }

    #[export]
    pub fn receipts_for_target(&self, target_app: ActorId) -> Vec<u128> {
        self.state
            .borrow()
            .by_target
            .get(&target_app)
            .cloned()
            .unwrap_or_default()
    }

    #[export]
    pub fn recent_receipts(&self, limit: u32) -> Vec<ProofReceipt> {
        let limit = limit.min(MAX_RECENT_QUERY) as usize;
        if limit == 0 {
            return Vec::new();
        }

        self.state
            .borrow()
            .receipts
            .iter()
            .rev()
            .take(limit)
            .map(|(_, receipt)| receipt.clone())
            .collect()
    }

    #[export]
    pub fn receipt_count(&self) -> u128 {
        self.state.borrow().receipts.len() as u128
    }

    #[export]
    pub fn owner(&self) -> ActorId {
        self.state.borrow().owner
    }

    #[export]
    pub fn is_paused(&self) -> bool {
        self.state.borrow().paused
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();
        ensure_owner(&state, caller)?;
        state.paused = true;

        self.emit_event(ProofPackEvents::Paused(caller.into_bytes()))
            .expect("failed to emit paused event");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn unpause(&mut self) -> Result<(), String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();
        ensure_owner(&state, caller)?;
        state.paused = false;

        self.emit_event(ProofPackEvents::Unpaused(caller.into_bytes()))
            .expect("failed to emit unpaused event");

        Ok(())
    }
}

pub struct Program {
    state: RefCell<ProofPackState>,
}

#[sails_rs::program]
impl Program {
    pub fn create() -> Self {
        Self {
            state: RefCell::new(ProofPackState::new(Syscall::message_source())),
        }
    }

    pub fn proof_pack(&self) -> ProofPackService<'_> {
        ProofPackService::new(&self.state)
    }
}
