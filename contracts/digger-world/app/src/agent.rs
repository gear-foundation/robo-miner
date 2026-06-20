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

    pub(crate) fn trade_banked_resources_for_ladders(
        &mut self,
        scrst: u32,
        bcrst: u32,
        hcrst: u32,
    ) -> Result<u32, String> {
        let ladders_added = ladders_for_resources(scrst, bcrst, hcrst)?;
        if self.banked_scrst < scrst {
            return Err("not enough banked SCRST".into());
        }
        if self.banked_bcrst < bcrst {
            return Err("not enough banked BCRST".into());
        }
        if self.banked_hcrst < hcrst {
            return Err("not enough banked HCRST".into());
        }

        self.banked_scrst = self.banked_scrst.saturating_sub(scrst);
        self.banked_bcrst = self.banked_bcrst.saturating_sub(bcrst);
        self.banked_hcrst = self.banked_hcrst.saturating_sub(hcrst);
        self.ladders_remaining = self.ladders_remaining.saturating_add(ladders_added);

        Ok(ladders_added)
    }
}

pub(crate) fn ladders_for_resources(scrst: u32, bcrst: u32, hcrst: u32) -> Result<u32, String> {
    if scrst == 0 && bcrst == 0 && hcrst == 0 {
        return Err("no resources selected".into());
    }
    if scrst % LADDER_SCRST_COST != 0 {
        return Err("SCRST must be traded in batches of five".into());
    }

    let scrst_ladders = scrst / LADDER_SCRST_COST;
    let bcrst_ladders = bcrst.saturating_mul(LADDER_BCRST_REWARD);
    let hcrst_ladders = hcrst.saturating_mul(LADDER_HCRST_REWARD);
    let ladders = scrst_ladders
        .saturating_add(bcrst_ladders)
        .saturating_add(hcrst_ladders);
    if ladders == 0 {
        return Err("selected resources do not buy any ladders".into());
    }

    Ok(ladders)
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

pub(crate) fn owner_view(agent: &Agent) -> ActorId {
    agent.owner
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

    #[test]
    fn resources_trade_for_ladders_at_configured_rates() {
        assert_eq!(ladders_for_resources(5, 0, 0), Ok(1));
        assert_eq!(ladders_for_resources(0, 1, 0), Ok(1));
        assert_eq!(ladders_for_resources(0, 0, 1), Ok(5));
        assert_eq!(ladders_for_resources(10, 2, 1), Ok(9));
    }

    #[test]
    fn trading_banked_resources_spends_resources_and_adds_ladders() {
        let config = WorldConfig::default_40x64();
        let mut agent = Agent::new(ActorId::zero(), 2, &config);
        agent.banked_scrst = 5;
        agent.banked_bcrst = 1;
        agent.banked_hcrst = 1;

        assert_eq!(agent.trade_banked_resources_for_ladders(5, 1, 1), Ok(7));
        assert_eq!(agent.banked_scrst, 0);
        assert_eq!(agent.banked_bcrst, 0);
        assert_eq!(agent.banked_hcrst, 0);
        assert_eq!(agent.ladders_remaining, config.starting_ladders + 7);
    }

    #[test]
    fn resource_trade_rejects_invalid_or_missing_resources() {
        let config = WorldConfig::default_40x64();
        let mut agent = Agent::new(ActorId::zero(), 2, &config);
        agent.banked_scrst = 4;

        assert_eq!(
            ladders_for_resources(0, 0, 0),
            Err("no resources selected".into())
        );
        assert_eq!(
            agent.trade_banked_resources_for_ladders(4, 0, 0),
            Err("SCRST must be traded in batches of five".into())
        );
        assert_eq!(
            agent.trade_banked_resources_for_ladders(5, 0, 0),
            Err("not enough banked SCRST".into())
        );
    }
}
