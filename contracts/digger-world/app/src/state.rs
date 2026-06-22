use sails_rs::prelude::*;

use crate::{
    agent::Agent,
    config::WorldConfig,
    constants::{
        AGENT_ACTIVE, AUTO_START_SESSION_PARTICIPANTS, MIN_SESSION_PARTICIPANTS, SESSION_ACTIVE,
        SESSION_CREATED, SESSION_FINISHED,
    },
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SessionInfo {
    pub(crate) session_id: u64,
    pub(crate) seed: u64,
    pub(crate) status: u32,
    pub(crate) action_seq: u64,
}

pub struct WorldState {
    pub(crate) admin: ActorId,
    pub(crate) resource_vmt: ActorId,
    pub(crate) config: WorldConfig,
    pub(crate) session: SessionInfo,
    pub(crate) map: Vec<u8>,
    pub(crate) agents: collections::HashMap<ActorId, Agent>,
    pub(crate) spawn_cursor: u32,
}

impl WorldState {
    pub(crate) fn new(admin: ActorId, config: WorldConfig) -> Self {
        Self {
            admin,
            resource_vmt: ActorId::zero(),
            config,
            session: SessionInfo {
                session_id: 0,
                seed: 0,
                status: SESSION_CREATED,
                action_seq: 0,
            },
            map: Vec::new(),
            agents: collections::HashMap::new(),
            spawn_cursor: 0,
        }
    }
}

pub(crate) fn session_view(session: &SessionInfo) -> Vec<u128> {
    vec![
        session.session_id as u128,
        session.seed as u128,
        session.status as u128,
        session.action_seq as u128,
    ]
}

pub(crate) fn ensure_admin(state: &WorldState, caller: ActorId) -> Result<(), String> {
    if state.admin != caller {
        return Err("caller is not admin".into());
    }
    Ok(())
}

pub(crate) fn ensure_session_active(state: &WorldState) -> Result<(), String> {
    if state.session.status != SESSION_ACTIVE {
        return Err("session is not active".into());
    }
    Ok(())
}

pub(crate) fn ensure_registration_open(state: &WorldState) -> Result<(), String> {
    if matches!(state.session.status, SESSION_CREATED | SESSION_ACTIVE) {
        return Ok(());
    }
    if state.session.status == SESSION_FINISHED {
        return Err("registration is closed".into());
    }
    Err("registration is closed".into())
}

pub(crate) fn ensure_min_participants_to_start(state: &WorldState) -> Result<(), String> {
    if state.agents.len() < MIN_SESSION_PARTICIPANTS {
        return Err("not enough participants to start session".into());
    }
    Ok(())
}

pub(crate) fn should_auto_start_session(state: &WorldState) -> bool {
    state.session.status == SESSION_CREATED && state.agents.len() >= AUTO_START_SESSION_PARTICIPANTS
}

pub(crate) fn active_agent(state: &WorldState, owner: ActorId) -> Result<&Agent, String> {
    let agent = state
        .agents
        .get(&owner)
        .ok_or_else(|| "agent is not registered".to_string())?;
    if agent.status != AGENT_ACTIVE {
        return Err("agent is not active".into());
    }
    Ok(agent)
}

pub(crate) fn next_action_seq(state: &mut WorldState) -> u64 {
    state.session.action_seq = state.session.action_seq.saturating_add(1);
    state.session.action_seq
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_world_starts_without_a_loaded_map() {
        let state = WorldState::new(ActorId::zero(), WorldConfig::default_40x64());

        assert_eq!(state.session.session_id, 0);
        assert_eq!(state.session.seed, 0);
        assert_eq!(state.session.status, SESSION_CREATED);
        assert_eq!(state.resource_vmt, ActorId::zero());
        assert!(state.map.is_empty());
    }

    #[test]
    fn registration_is_open_before_and_during_active_session() {
        let mut state = WorldState::new(ActorId::zero(), WorldConfig::default_40x64());

        assert_eq!(ensure_registration_open(&state), Ok(()));

        state.session.status = SESSION_ACTIVE;
        assert_eq!(ensure_registration_open(&state), Ok(()));

        state.session.status = SESSION_FINISHED;
        assert_eq!(
            ensure_registration_open(&state),
            Err("registration is closed".into())
        );
    }

    #[test]
    fn start_session_requires_at_least_one_participant() {
        let mut state = WorldState::new(ActorId::zero(), WorldConfig::default_40x64());

        assert_eq!(
            ensure_min_participants_to_start(&state),
            Err("not enough participants to start session".into())
        );

        state.agents.insert(
            ActorId::new([1; 32]),
            Agent::new(ActorId::new([200; 32]), 1, &state.config),
        );

        assert_eq!(ensure_min_participants_to_start(&state), Ok(()));
    }

    #[test]
    fn auto_start_triggers_at_ten_registered_participants() {
        let mut state = WorldState::new(ActorId::zero(), WorldConfig::default_40x64());

        for index in 0..(AUTO_START_SESSION_PARTICIPANTS - 1) {
            state.agents.insert(
                ActorId::new([index as u8; 32]),
                Agent::new(
                    ActorId::new([100 + index as u8; 32]),
                    index as u32,
                    &state.config,
                ),
            );
        }

        assert!(!should_auto_start_session(&state));

        state.agents.insert(
            ActorId::new([AUTO_START_SESSION_PARTICIPANTS as u8; 32]),
            Agent::new(
                ActorId::new([220; 32]),
                AUTO_START_SESSION_PARTICIPANTS as u32,
                &state.config,
            ),
        );

        assert!(should_auto_start_session(&state));
    }
}
