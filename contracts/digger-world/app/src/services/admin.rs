use sails_rs::{cell::RefCell, prelude::*};

use crate::{
    constants::{SESSION_ACTIVE, SESSION_CREATED, SESSION_FINISHED},
    events::AdminEvents,
    map::{ensure_map_loaded, generate_map, validate_uploaded_map},
    state::{WorldState, ensure_admin, session_view},
};

pub struct AdminService<'a> {
    state: &'a RefCell<WorldState>,
}

impl<'a> AdminService<'a> {
    pub fn new(state: &'a RefCell<WorldState>) -> Self {
        Self { state }
    }
}

#[service(events = AdminEvents)]
impl AdminService<'_> {
    #[export(unwrap_result)]
    pub fn start_session(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        ensure_map_loaded(&state.map)?;
        if state.session.status == SESSION_ACTIVE {
            return Err("session is already active".into());
        }

        state.session.status = SESSION_ACTIVE;
        let session_id = state.session.session_id;
        let session = session_view(&state.session);
        self.emit_event(AdminEvents::SessionStarted(session_id))
            .expect("failed to emit session started event");

        Ok(session)
    }

    #[export(unwrap_result)]
    pub fn finish_session(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if state.session.status == SESSION_FINISHED {
            return Err("session is already finished".into());
        }

        state.session.status = SESSION_FINISHED;
        let session_id = state.session.session_id;
        let session = session_view(&state.session);
        self.emit_event(AdminEvents::SessionFinished(session_id))
            .expect("failed to emit session finished event");

        Ok(session)
    }

    #[export(unwrap_result)]
    pub fn reset_map(&mut self, seed: u64) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;

        state.map = generate_map(seed, &state.config);
        state.agents.clear();
        state.spawn_cursor = 0;
        state.session.session_id = state.session.session_id.saturating_add(1);
        state.session.seed = seed;
        state.session.status = SESSION_CREATED;
        state.session.action_seq = 0;

        let session_id = state.session.session_id;
        let session = session_view(&state.session);
        self.emit_event(AdminEvents::MapGenerated(session_id, seed))
            .expect("failed to emit map generated event");

        Ok(session)
    }

    #[export(unwrap_result)]
    pub fn upload_map(&mut self, seed: u64, map: Vec<u32>) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;

        state.map = validate_uploaded_map(&map, &state.config)?;
        state.agents.clear();
        state.spawn_cursor = 0;
        state.session.session_id = state.session.session_id.saturating_add(1);
        state.session.seed = seed;
        state.session.status = SESSION_CREATED;
        state.session.action_seq = 0;

        let session_id = state.session.session_id;
        let session = session_view(&state.session);
        self.emit_event(AdminEvents::MapGenerated(session_id, seed))
            .expect("failed to emit map generated event");

        Ok(session)
    }

    #[export(unwrap_result)]
    pub fn admin(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().admin)
    }

    #[export(unwrap_result)]
    pub fn set_resource_vmt(&mut self, resource_vmt: ActorId) -> Result<ActorId, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;

        let previous = state.resource_vmt;
        state.resource_vmt = resource_vmt;

        self.emit_event(AdminEvents::ResourceVmtUpdated(
            previous.into_bytes(),
            resource_vmt.into_bytes(),
        ))
        .expect("failed to emit resource VMT updated event");

        Ok(resource_vmt)
    }

    #[export(unwrap_result)]
    pub fn resource_vmt(&self) -> Result<ActorId, String> {
        Ok(self.state.borrow().resource_vmt)
    }
}
