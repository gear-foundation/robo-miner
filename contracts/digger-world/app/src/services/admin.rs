use sails_rs::{cell::RefCell, gstd::exec, prelude::*};

use crate::{
    config::{ensure_ladder_exchange_rate, ladder_exchange_rate_view},
    constants::{PROBABILITY_BASIS_POINTS, SESSION_ACTIVE, SESSION_CREATED, SESSION_FINISHED},
    events::AdminEvents,
    map::{ensure_map_loaded, generate_map, validate_uploaded_map},
    state::{WorldState, ensure_admin, ensure_min_participants_to_start, session_view},
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
    pub fn kill(&mut self, inheritor: ActorId) -> Result<(), String> {
        {
            let state = self.state.borrow();
            let caller = Syscall::message_source();
            ensure_admin(&state, caller)?;
        }

        if inheritor == ActorId::zero() {
            return Err("inheritor cannot be zero".into());
        }

        self.emit_event(AdminEvents::Killed(inheritor.into_bytes()))
            .expect("failed to emit killed event");

        exec::exit(inheritor);
    }

    #[export(unwrap_result)]
    pub fn start_session(&mut self) -> Result<Vec<u128>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        ensure_map_loaded(&state.map)?;
        if state.session.status == SESSION_ACTIVE {
            return Err("session is already active".into());
        }
        if state.session.status != SESSION_CREATED {
            return Err("session cannot be started".into());
        }
        ensure_min_participants_to_start(&state)?;

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

    #[export(unwrap_result)]
    pub fn set_chest_dynamite_chance_bps(
        &mut self,
        chest_dynamite_chance_bps: u32,
    ) -> Result<u32, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        if chest_dynamite_chance_bps > PROBABILITY_BASIS_POINTS {
            return Err("chest dynamite chance must be at most 100%".into());
        }

        state.config.chest_dynamite_chance_bps = chest_dynamite_chance_bps;

        Ok(chest_dynamite_chance_bps)
    }

    #[export(unwrap_result)]
    pub fn chest_dynamite_chance_bps(&self) -> Result<u32, String> {
        Ok(self.state.borrow().config.chest_dynamite_chance_bps)
    }

    #[export(unwrap_result)]
    pub fn set_ladder_exchange_rate(
        &mut self,
        ladder_scrst_resource_amount: u32,
        ladder_scrst_ladder_amount: u32,
        ladder_bcrst_resource_amount: u32,
        ladder_bcrst_ladder_amount: u32,
        ladder_hcrst_resource_amount: u32,
        ladder_hcrst_ladder_amount: u32,
    ) -> Result<Vec<u32>, String> {
        let caller = Syscall::message_source();
        let mut state = self.state.borrow_mut();

        ensure_admin(&state, caller)?;
        ensure_ladder_exchange_rate(
            ladder_scrst_resource_amount,
            ladder_scrst_ladder_amount,
            ladder_bcrst_resource_amount,
            ladder_bcrst_ladder_amount,
            ladder_hcrst_resource_amount,
            ladder_hcrst_ladder_amount,
        )?;

        state.config.ladder_scrst_resource_amount = ladder_scrst_resource_amount;
        state.config.ladder_scrst_ladder_amount = ladder_scrst_ladder_amount;
        state.config.ladder_bcrst_resource_amount = ladder_bcrst_resource_amount;
        state.config.ladder_bcrst_ladder_amount = ladder_bcrst_ladder_amount;
        state.config.ladder_hcrst_resource_amount = ladder_hcrst_resource_amount;
        state.config.ladder_hcrst_ladder_amount = ladder_hcrst_ladder_amount;

        Ok(ladder_exchange_rate_view(&state.config))
    }

    #[export(unwrap_result)]
    pub fn ladder_exchange_rate(&self) -> Result<Vec<u32>, String> {
        Ok(ladder_exchange_rate_view(&self.state.borrow().config))
    }
}
