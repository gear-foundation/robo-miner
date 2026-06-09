use sails_rs::prelude::*;

use crate::{config::WorldConfig, constants::*};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Agent {
    pub(crate) owner: ActorId,
    pub(crate) status: u32,
    pub(crate) x: u32,
    pub(crate) y: u32,
    pub(crate) hp: u32,
    pub(crate) ladders_remaining: u32,
    pub(crate) inventory_scrst: u32,
    pub(crate) inventory_bcrst: u32,
    pub(crate) inventory_hcrst: u32,
    pub(crate) banked_scrst: u32,
    pub(crate) banked_bcrst: u32,
    pub(crate) banked_hcrst: u32,
    pub(crate) backpack_capacity: u32,
    pub(crate) last_action_seq: u64,
}

impl Agent {
    pub(crate) fn new(owner: ActorId, x: u32, config: &WorldConfig) -> Self {
        Self {
            owner,
            status: AGENT_ACTIVE,
            x,
            y: 0,
            hp: config.starting_hp,
            ladders_remaining: config.starting_ladders,
            inventory_scrst: 0,
            inventory_bcrst: 0,
            inventory_hcrst: 0,
            banked_scrst: 0,
            banked_bcrst: 0,
            banked_hcrst: 0,
            backpack_capacity: config.backpack_capacity,
            last_action_seq: 0,
        }
    }

    pub(crate) fn carried_total(&self) -> u32 {
        self.inventory_scrst
            .saturating_add(self.inventory_bcrst)
            .saturating_add(self.inventory_hcrst)
    }

    pub(crate) fn bank_inventory(&mut self) {
        self.banked_scrst = self.banked_scrst.saturating_add(self.inventory_scrst);
        self.banked_bcrst = self.banked_bcrst.saturating_add(self.inventory_bcrst);
        self.banked_hcrst = self.banked_hcrst.saturating_add(self.inventory_hcrst);
        self.inventory_scrst = 0;
        self.inventory_bcrst = 0;
        self.inventory_hcrst = 0;
    }
}

pub(crate) fn agent_view(agent: &Agent) -> Vec<u128> {
    vec![
        agent.status as u128,
        agent.x as u128,
        agent.y as u128,
        agent.hp as u128,
        agent.ladders_remaining as u128,
        agent.inventory_scrst as u128,
        agent.inventory_bcrst as u128,
        agent.inventory_hcrst as u128,
        agent.banked_scrst as u128,
        agent.banked_bcrst as u128,
        agent.banked_hcrst as u128,
        agent.backpack_capacity as u128,
        agent.last_action_seq as u128,
    ]
}

pub(crate) fn inventory_view(agent: &Agent) -> Vec<u32> {
    vec![
        agent.inventory_scrst,
        agent.inventory_bcrst,
        agent.inventory_hcrst,
        agent.banked_scrst,
        agent.banked_bcrst,
        agent.banked_hcrst,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WorldConfig;

    #[test]
    fn bank_inventory_preserves_active_status_for_return_runs() {
        let config = WorldConfig::default_40x64();
        let mut agent = Agent::new(ActorId::zero(), 2, &config);
        agent.inventory_scrst = 2;
        agent.inventory_bcrst = 1;
        agent.inventory_hcrst = 3;
        agent.banked_scrst = 5;

        agent.bank_inventory();

        assert_eq!(agent.status, AGENT_ACTIVE);
        assert_eq!(agent.inventory_scrst, 0);
        assert_eq!(agent.inventory_bcrst, 0);
        assert_eq!(agent.inventory_hcrst, 0);
        assert_eq!(agent.banked_scrst, 7);
        assert_eq!(agent.banked_bcrst, 1);
        assert_eq!(agent.banked_hcrst, 3);
    }
}
