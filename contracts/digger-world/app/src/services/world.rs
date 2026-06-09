use sails_rs::{cell::RefCell, gstd::msg, prelude::*};

use crate::{
    agent::{Agent, agent_view, inventory_view},
    constants::*,
    events::WorldEvents,
    map::{
        ensure_map_loaded, ensure_move_allowed, gravity_target, index_of, is_dug_tile,
        next_spawn_x, target_position, tile_at,
    },
    state::{WorldState, active_agent, ensure_session_active, next_action_seq},
};

const VMT_MINT_RESOURCES: [u8; 16] = [
    0x47, 0x4d, 0x01, 0x10, 0x4e, 0x01, 0xe4, 0xdd, 0x80, 0x6d, 0x52, 0xbb, 0x08, 0x00, 0x01, 0x00,
];

pub struct WorldService<'a> {
    state: &'a RefCell<WorldState>,
}

impl<'a> WorldService<'a> {
    pub fn new(state: &'a RefCell<WorldState>) -> Self {
        Self { state }
    }
}

#[service(events = WorldEvents)]
impl WorldService<'_> {
    #[export(unwrap_result)]
    pub fn register(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        if state.agents.contains_key(&caller) {
            return Err("agent is already registered".into());
        }

        let x = next_spawn_x(state.spawn_cursor);
        state.spawn_cursor = state.spawn_cursor.saturating_add(1);
        let agent = Agent::new(caller, x, &state.config);
        let view = agent_view(&agent);

        state.agents.insert(caller, agent);

        self.emit_event(WorldEvents::AgentRegistered(
            state.session.session_id,
            caller.into_bytes(),
        ))
        .expect("failed to emit agent registered event");
        self.emit_event(WorldEvents::AgentSpawned(
            state.session.session_id,
            caller.into_bytes(),
            x,
            0,
        ))
        .expect("failed to emit agent spawned event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn move_agent(&mut self, direction: u32) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        let agent_before = active_agent(&state, caller)?.clone();
        let (to_x, to_y) = target_position(agent_before.x, agent_before.y, direction)?;
        let current_tile = tile_at(&state.map, agent_before.x, agent_before.y)?;
        let target_tile = tile_at(&state.map, to_x, to_y)?;

        if target_tile == TILE_LAVA {
            let session_id = state.session.session_id;
            let action_seq = next_action_seq(&mut state);
            let agent = state
                .agents
                .get_mut(&caller)
                .expect("agent was checked before mutation");
            agent.x = to_x;
            agent.y = to_y;
            agent.hp = 0;
            agent.status = AGENT_DEAD;
            agent.last_action_seq = action_seq;

            self.emit_event(WorldEvents::AgentDied(
                session_id,
                caller.into_bytes(),
                to_x,
                to_y,
                TILE_LAVA as u32,
            ))
            .expect("failed to emit agent died event");

            return Ok(agent_view(agent));
        }

        ensure_move_allowed(direction, current_tile, target_tile)?;
        let (final_x, final_y) = gravity_target(&state.map, to_x, to_y)?;

        let session_id = state.session.session_id;
        let action_seq = next_action_seq(&mut state);
        let agent = state
            .agents
            .get_mut(&caller)
            .expect("agent was checked before mutation");
        let from_x = agent.x;
        let from_y = agent.y;
        agent.x = final_x;
        agent.y = final_y;
        agent.last_action_seq = action_seq;

        let view = agent_view(agent);
        self.emit_event(WorldEvents::AgentMoved(
            session_id,
            caller.into_bytes(),
            from_x,
            from_y,
            final_x,
            final_y,
        ))
        .expect("failed to emit agent moved event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn drill(&mut self, direction: u32) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        let agent_before = active_agent(&state, caller)?.clone();
        let (x, y) = target_position(agent_before.x, agent_before.y, direction)?;
        let index = index_of(x, y)?;
        let old_tile = tile_at(&state.map, x, y)?;

        match old_tile {
            TILE_DIRT | TILE_STONE => {
                state.map[index] = TILE_EMPTY;
            }
            TILE_RESOURCE_SCRST | TILE_RESOURCE_BCRST | TILE_RESOURCE_HCRST => {
                if agent_before.carried_total() >= agent_before.backpack_capacity {
                    return Err("backpack is full".into());
                }
                state.map[index] = TILE_EMPTY;
            }
            TILE_LAVA => return Err("lava cannot be drilled".into()),
            TILE_EMPTY | TILE_SURFACE | TILE_LADDER => return Err("tile is already open".into()),
            _ => return Err("unknown tile kind".into()),
        }

        let (gravity_x, gravity_y) = gravity_target(&state.map, agent_before.x, agent_before.y)?;
        let session_id = state.session.session_id;
        let action_seq = next_action_seq(&mut state);
        let mut resource_event: Option<(u32, u32)> = None;
        let agent = state
            .agents
            .get_mut(&caller)
            .expect("agent was checked before mutation");
        let from_x = agent.x;
        let from_y = agent.y;

        match old_tile {
            TILE_RESOURCE_SCRST => {
                agent.inventory_scrst = agent.inventory_scrst.saturating_add(1);
                resource_event = Some((RESOURCE_SCRST, agent.carried_total()));
            }
            TILE_RESOURCE_BCRST => {
                agent.inventory_bcrst = agent.inventory_bcrst.saturating_add(1);
                resource_event = Some((RESOURCE_BCRST, agent.carried_total()));
            }
            TILE_RESOURCE_HCRST => {
                agent.inventory_hcrst = agent.inventory_hcrst.saturating_add(1);
                resource_event = Some((RESOURCE_HCRST, agent.carried_total()));
            }
            _ => {}
        }

        if gravity_x != from_x || gravity_y != from_y {
            agent.x = gravity_x;
            agent.y = gravity_y;
        }
        agent.last_action_seq = action_seq;
        let view = agent_view(agent);
        let gravity_event = if gravity_x != from_x || gravity_y != from_y {
            Some((from_x, from_y, gravity_x, gravity_y))
        } else {
            None
        };

        self.emit_event(WorldEvents::TileDrilled(
            session_id,
            caller.into_bytes(),
            x,
            y,
            old_tile as u32,
            TILE_EMPTY as u32,
        ))
        .expect("failed to emit tile drilled event");

        if let Some((resource_kind, carried_total)) = resource_event {
            self.emit_event(WorldEvents::ResourceExtracted(
                session_id,
                caller.into_bytes(),
                x,
                y,
                resource_kind,
                carried_total,
            ))
            .expect("failed to emit resource extracted event");
        }

        if let Some((from_x, from_y, to_x, to_y)) = gravity_event {
            self.emit_event(WorldEvents::AgentMoved(
                session_id,
                caller.into_bytes(),
                from_x,
                from_y,
                to_x,
                to_y,
            ))
            .expect("failed to emit gravity moved event");
        }

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn place_ladder(&mut self, direction: u32) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        let agent_before = active_agent(&state, caller)?.clone();
        if agent_before.ladders_remaining == 0 {
            return Err("no ladders remaining".into());
        }

        ensure_map_loaded(&state.map)?;
        let (x, y) = target_position(agent_before.x, agent_before.y, direction)?;
        let index = index_of(x, y)?;
        if state.map[index] != TILE_EMPTY {
            return Err("ladder can only be placed on empty tile".into());
        }

        state.map[index] = TILE_LADDER;
        let session_id = state.session.session_id;
        let action_seq = next_action_seq(&mut state);
        let agent = state
            .agents
            .get_mut(&caller)
            .expect("agent was checked before mutation");
        agent.ladders_remaining = agent.ladders_remaining.saturating_sub(1);
        agent.last_action_seq = action_seq;

        let view = agent_view(agent);
        self.emit_event(WorldEvents::LadderPlaced(
            session_id,
            caller.into_bytes(),
            x,
            y,
            agent.ladders_remaining,
        ))
        .expect("failed to emit ladder placed event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn surface(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        let agent_before = active_agent(&state, caller)?.clone();
        if agent_before.y != 0 {
            return Err("agent is not on the surface".into());
        }

        let session_id = state.session.session_id;
        let action_seq = next_action_seq(&mut state);
        let agent = state
            .agents
            .get_mut(&caller)
            .expect("agent was checked before mutation");
        agent.bank_inventory();
        agent.last_action_seq = action_seq;

        let view = agent_view(agent);
        self.emit_event(WorldEvents::AgentSurfaced(
            session_id,
            caller.into_bytes(),
            agent.banked_scrst,
            agent.banked_bcrst,
            agent.banked_hcrst,
        ))
        .expect("failed to emit agent surfaced event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn exit(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_session_active(&state)?;
        let agent_before = state
            .agents
            .get(&caller)
            .ok_or_else(|| "agent is not registered".to_string())?
            .clone();
        if agent_before.status != AGENT_ACTIVE && agent_before.status != AGENT_SURFACED {
            return Err("agent cannot exit from current status".into());
        }

        let session_id = state.session.session_id;
        let action_seq = next_action_seq(&mut state);
        let agent = state
            .agents
            .get_mut(&caller)
            .expect("agent was checked before mutation");
        if agent.y == 0 {
            agent.bank_inventory();
        }
        agent.status = AGENT_EXITED;
        agent.last_action_seq = action_seq;

        let view = agent_view(agent);
        self.emit_event(WorldEvents::AgentExited(session_id, caller.into_bytes()))
            .expect("failed to emit agent exited event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub async fn mint_resources(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let (resource_vmt, scrst, bcrst, hcrst) = {
            let state = self.state.borrow();

            ensure_session_active(&state)?;
            if state.resource_vmt == ActorId::zero() {
                return Err("resource VMT is not configured".into());
            }

            let agent = active_agent(&state, caller)?;
            if agent.banked_scrst == 0 && agent.banked_bcrst == 0 && agent.banked_hcrst == 0 {
                return Err("no banked resources to mint".into());
            }

            (
                state.resource_vmt,
                agent.banked_scrst,
                agent.banked_bcrst,
                agent.banked_hcrst,
            )
        };

        let payload = encode_vmt_mint_resources(caller, scrst, bcrst, hcrst);
        let reply = msg::send_bytes_for_reply(resource_vmt, payload, 0)
            .map_err(|_| "failed to send MintResources to VMT".to_string())?;

        {
            let mut state = self.state.borrow_mut();
            let action_seq = next_action_seq(&mut state);
            let agent = state
                .agents
                .get_mut(&caller)
                .expect("agent was checked before mint staging");
            agent.banked_scrst = agent.banked_scrst.saturating_sub(scrst);
            agent.banked_bcrst = agent.banked_bcrst.saturating_sub(bcrst);
            agent.banked_hcrst = agent.banked_hcrst.saturating_sub(hcrst);
            agent.last_action_seq = action_seq;
        }

        if reply.await.is_err() {
            let mut state = self.state.borrow_mut();
            if let Some(agent) = state.agents.get_mut(&caller) {
                agent.banked_scrst = agent.banked_scrst.saturating_add(scrst);
                agent.banked_bcrst = agent.banked_bcrst.saturating_add(bcrst);
                agent.banked_hcrst = agent.banked_hcrst.saturating_add(hcrst);
            }
            return Err("VMT MintResources reply failed".into());
        }

        let state = self.state.borrow();
        let agent = state
            .agents
            .get(&caller)
            .ok_or_else(|| "agent is not registered".to_string())?;
        let view = agent_view(agent);

        self.emit_event(WorldEvents::ResourcesMinted(
            state.session.session_id,
            caller.into_bytes(),
            scrst,
            bcrst,
            hcrst,
        ))
        .expect("failed to emit resources minted event");

        Ok(view)
    }

    #[export(unwrap_result)]
    pub fn config(&self) -> Result<Vec<u32>, String> {
        Ok(crate::config::config_view(&self.state.borrow().config))
    }

    #[export(unwrap_result)]
    pub fn session(&self) -> Result<Vec<u128>, String> {
        Ok(crate::state::session_view(&self.state.borrow().session))
    }

    #[export(unwrap_result)]
    pub fn tile_at(&self, x: u32, y: u32) -> Result<u32, String> {
        Ok(tile_at(&self.state.borrow().map, x, y)? as u32)
    }

    #[export(unwrap_result)]
    pub fn is_dug(&self, x: u32, y: u32) -> Result<bool, String> {
        Ok(is_dug_tile(tile_at(&self.state.borrow().map, x, y)?))
    }

    #[export(unwrap_result)]
    pub fn map_snapshot(&self) -> Result<Vec<u32>, String> {
        let state = self.state.borrow();
        ensure_map_loaded(&state.map)?;
        Ok(state.map.iter().map(|tile| *tile as u32).collect())
    }

    #[export(unwrap_result)]
    pub fn agent_of(&self, owner: ActorId) -> Result<Vec<u128>, String> {
        Ok(agent_view(
            self.state
                .borrow()
                .agents
                .get(&owner)
                .ok_or_else(|| "agent is not registered".to_string())?,
        ))
    }

    #[export(unwrap_result)]
    pub fn agents(&self) -> Result<Vec<ActorId>, String> {
        Ok(self.state.borrow().agents.keys().copied().collect())
    }

    #[export(unwrap_result)]
    pub fn inventory_of(&self, owner: ActorId) -> Result<Vec<u32>, String> {
        Ok(inventory_view(
            self.state
                .borrow()
                .agents
                .get(&owner)
                .ok_or_else(|| "agent is not registered".to_string())?,
        ))
    }
}

fn encode_vmt_mint_resources(to: ActorId, scrst: u32, bcrst: u32, hcrst: u32) -> Vec<u8> {
    let mut payload = VMT_MINT_RESOURCES.to_vec();
    payload.extend(to.encode());
    payload.extend((scrst as u128).encode());
    payload.extend((bcrst as u128).encode());
    payload.extend((hcrst as u128).encode());
    payload
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vmt_mint_resources_payload_uses_vmt_route_and_u128_amounts() {
        let to = ActorId::new([7; 32]);
        let payload = encode_vmt_mint_resources(to, 1, 2, 3);

        assert_eq!(&payload[..16], &VMT_MINT_RESOURCES);
        assert_eq!(payload.len(), 16 + 32 + 16 + 16 + 16);
        assert_eq!(&payload[16..48], &to.encode());
        assert_eq!(&payload[48..64], &(1_u128).encode());
        assert_eq!(&payload[64..80], &(2_u128).encode());
        assert_eq!(&payload[80..96], &(3_u128).encode());
    }
}
