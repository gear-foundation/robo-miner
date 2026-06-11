#![no_std]

#[cfg(test)]
extern crate std;

use sails_rs::{
    cell::RefCell,
    gstd::{exec, msg},
    prelude::*,
};

const ACTION_REGISTER: u32 = 1;
const ACTION_DRILL: u32 = 2;
const ACTION_MOVE_AGENT: u32 = 3;
const ACTION_PLACE_LADDER: u32 = 4;
const ACTION_SURFACE: u32 = 5;
const ACTION_EXIT: u32 = 6;
const ACTION_MINT_RESOURCES: u32 = 7;

const WORLD_REGISTER: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x0c, 0x00, 0x01, 0x00,
];
const WORLD_DRILL: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x03, 0x00, 0x01, 0x00,
];
const WORLD_MOVE_AGENT: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x09, 0x00, 0x01, 0x00,
];
const WORLD_PLACE_LADDER: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x0b, 0x00, 0x01, 0x00,
];
const WORLD_SURFACE: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x0e, 0x00, 0x01, 0x00,
];
const WORLD_EXIT: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x04, 0x00, 0x01, 0x00,
];
const WORLD_MINT_RESOURCES: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x08, 0x00, 0x01, 0x00,
];

#[derive(Clone, Debug)]
struct DiggerState {
    owner: ActorId,
    world: ActorId,
    action_seq: u64,
    last_action: u32,
    last_message_id: [u8; 32],
}

impl DiggerState {
    fn new(owner: ActorId, world: ActorId) -> Self {
        Self {
            owner,
            world,
            action_seq: 0,
            last_action: 0,
            last_message_id: [0; 32],
        }
    }
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum DiggerEvents {
    Forwarded(u64, u32, [u8; 32]),
    Killed([u8; 32]),
    WorldUpdated([u8; 32], [u8; 32]),
}

pub struct Program {
    state: RefCell<DiggerState>,
}

#[program]
impl Program {
    pub fn create(owner: ActorId, world: ActorId) -> Self {
        Self {
            state: RefCell::new(DiggerState::new(owner, world)),
        }
    }

    pub fn digger(&self) -> DiggerService<'_> {
        DiggerService::new(&self.state)
    }
}

pub struct DiggerService<'a> {
    state: &'a RefCell<DiggerState>,
}

impl<'a> DiggerService<'a> {
    fn new(state: &'a RefCell<DiggerState>) -> Self {
        Self { state }
    }
}

#[service(events = DiggerEvents)]
impl DiggerService<'_> {
    #[export(unwrap_result)]
    pub fn register(&mut self) -> Result<[u8; 32], String> {
        let owner = {
            let state = self.state.borrow();
            ensure_owner(&state)?;
            state.owner
        };

        self.forward(ACTION_REGISTER, encode_world_register(owner))
    }

    #[export(unwrap_result)]
    pub fn drill(&mut self, direction: u32) -> Result<[u8; 32], String> {
        self.forward_u32(ACTION_DRILL, WORLD_DRILL, direction)
    }

    #[export(unwrap_result)]
    pub fn move_agent(&mut self, direction: u32) -> Result<[u8; 32], String> {
        self.forward_u32(ACTION_MOVE_AGENT, WORLD_MOVE_AGENT, direction)
    }

    #[export(unwrap_result)]
    pub fn place_ladder(&mut self, direction: u32) -> Result<[u8; 32], String> {
        self.forward_u32(ACTION_PLACE_LADDER, WORLD_PLACE_LADDER, direction)
    }

    #[export(unwrap_result)]
    pub fn surface(&mut self) -> Result<[u8; 32], String> {
        self.forward_no_args(ACTION_SURFACE, WORLD_SURFACE)
    }

    #[export(unwrap_result)]
    pub fn exit(&mut self) -> Result<[u8; 32], String> {
        self.forward_no_args(ACTION_EXIT, WORLD_EXIT)
    }

    #[export(unwrap_result)]
    pub fn mint_resources(&mut self) -> Result<[u8; 32], String> {
        self.forward_no_args(ACTION_MINT_RESOURCES, WORLD_MINT_RESOURCES)
    }

    #[export(unwrap_result)]
    pub fn kill(&mut self, inheritor: ActorId) -> Result<(), String> {
        {
            let state = self.state.borrow();
            ensure_owner(&state)?;
        }

        if inheritor == ActorId::zero() {
            return Err("inheritor cannot be zero".into());
        }

        self.emit_event(DiggerEvents::Killed(inheritor.into_bytes()))
            .expect("failed to emit killed event");

        exec::exit(inheritor);
    }

    #[export(unwrap_result)]
    pub fn set_world(&mut self, world: ActorId) -> Result<ActorId, String> {
        if world == ActorId::zero() {
            return Err("world cannot be zero".into());
        }

        let previous = {
            let mut state = self.state.borrow_mut();
            ensure_owner(&state)?;
            let previous = state.world;
            state.world = world;
            previous
        };

        self.emit_event(DiggerEvents::WorldUpdated(
            previous.into_bytes(),
            world.into_bytes(),
        ))
        .expect("failed to emit world updated event");

        Ok(world)
    }

    #[export(unwrap_result)]
    pub fn owner(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().owner)
    }

    #[export(unwrap_result)]
    pub fn world(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().world)
    }

    #[export(unwrap_result)]
    pub fn status(&self) -> Result<Vec<u128>, String> {
        let state = self.state.borrow();
        Ok(vec![state.action_seq as u128, state.last_action as u128])
    }

    #[export(unwrap_result)]
    pub fn last_message_id(&self) -> Result<[u8; 32], String> {
        Ok(self.state.borrow().last_message_id)
    }

    fn forward_no_args(&mut self, action: u32, header: [u8; 16]) -> Result<[u8; 32], String> {
        self.forward(action, header.to_vec())
    }

    fn forward_u32(
        &mut self,
        action: u32,
        header: [u8; 16],
        value: u32,
    ) -> Result<[u8; 32], String> {
        let mut payload = header.to_vec();
        payload.extend_from_slice(&value.to_le_bytes());
        self.forward(action, payload)
    }

    fn forward(&mut self, action: u32, payload: Vec<u8>) -> Result<[u8; 32], String> {
        let mut state = self.state.borrow_mut();
        ensure_owner(&state)?;

        let message_id = msg::send_bytes(state.world, payload, 0)
            .map_err(|_| "failed to send message to world".to_string())?
            .into_bytes();

        state.action_seq = state.action_seq.saturating_add(1);
        state.last_action = action;
        state.last_message_id = message_id;
        let action_seq = state.action_seq;

        self.emit_event(DiggerEvents::Forwarded(action_seq, action, message_id))
            .expect("failed to emit forwarded event");

        Ok(message_id)
    }
}

fn ensure_owner(state: &DiggerState) -> Result<(), String> {
    if Syscall::message_source() != state.owner {
        return Err("caller is not owner".into());
    }
    Ok(())
}

fn encode_world_register(owner: ActorId) -> Vec<u8> {
    let mut payload = WORLD_REGISTER.to_vec();
    payload.extend(owner.encode());
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_action_headers_use_current_world_service_hash() {
        assert_eq!(
            WORLD_REGISTER,
            [
                0x47, 0x4d, 0x01, 0x10, 0xc9, 0x47, 0xeb, 0xa8, 0xa4, 0x99, 0xd9, 0xa7, 0x0c, 0x00,
                0x01, 0x00,
            ]
        );
        assert_eq!(WORLD_DRILL[12], 0x03);
        assert_eq!(WORLD_EXIT[12], 0x04);
        assert_eq!(WORLD_MINT_RESOURCES[12], 0x08);
        assert_eq!(WORLD_MOVE_AGENT[12], 0x09);
        assert_eq!(WORLD_PLACE_LADDER[12], 0x0b);
        assert_eq!(WORLD_REGISTER[12], 0x0c);
        assert_eq!(WORLD_SURFACE[12], 0x0e);
    }

    #[test]
    fn register_payload_forwards_owner_to_world() {
        let owner = ActorId::new([9; 32]);
        let payload = encode_world_register(owner);

        assert_eq!(&payload[..16], &WORLD_REGISTER);
        assert_eq!(payload.len(), 16 + 32);
        assert_eq!(&payload[16..48], &owner.encode());
    }
}
