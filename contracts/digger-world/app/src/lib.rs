#![no_std]

#[cfg(test)]
extern crate std;

mod agent;
mod config;
mod constants;
mod events;
mod map;
mod services;
mod state;

use sails_rs::{cell::RefCell, prelude::*};

use crate::{
    config::{WorldConfig, ensure_supported_config},
    services::{AdminService, WorldService},
    state::WorldState,
};

pub use constants::*;
pub use events::{AdminEvents, WorldEvents};

pub struct Program {
    state: RefCell<WorldState>,
}

#[program]
impl Program {
    pub fn create() -> Self {
        let config = WorldConfig::default_40x64();
        ensure_supported_config(&config).expect("unsupported world config");
        Self {
            state: RefCell::new(WorldState::new(Syscall::message_source(), config)),
        }
    }

    pub fn world(&self) -> WorldService<'_> {
        WorldService::new(&self.state)
    }

    pub fn admin(&self) -> AdminService<'_> {
        AdminService::new(&self.state)
    }
}
