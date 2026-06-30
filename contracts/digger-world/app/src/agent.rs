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
        config: &WorldConfig,
    ) -> Result<u32, String> {
        let ladders_added = ladders_for_resources(scrst, bcrst, hcrst, config)?;
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

pub(crate) fn ladders_for_resources(
    scrst: u32,
    bcrst: u32,
    hcrst: u32,
    config: &WorldConfig,
) -> Result<u32, String> {
    if scrst == 0 && bcrst == 0 && hcrst == 0 {
        return Err("no resources selected".into());
    }

    let scrst_ladders = ladders_from_resource(
        scrst,
        config.ladder_scrst_resource_amount,
        config.ladder_scrst_ladder_amount,
        "SCRST",
    )?;
    let bcrst_ladders = ladders_from_resource(
        bcrst,
        config.ladder_bcrst_resource_amount,
        config.ladder_bcrst_ladder_amount,
        "BCRST",
    )?;
    let hcrst_ladders = ladders_from_resource(
        hcrst,
        config.ladder_hcrst_resource_amount,
        config.ladder_hcrst_ladder_amount,
        "HCRST",
    )?;
    let ladders = scrst_ladders
        .saturating_add(bcrst_ladders)
        .saturating_add(hcrst_ladders);
    if ladders == 0 {
        return Err("selected resources do not buy any ladders".into());
    }

    Ok(ladders)
}

fn ladders_from_resource(
    resources: u32,
    resource_amount: u32,
    ladder_amount: u32,
    resource_name: &str,
) -> Result<u32, String> {
    if resources == 0 {
        return Ok(0);
    }
    if resources % resource_amount != 0 {
        return Err(match resource_name {
            "SCRST" => "SCRST must be traded in configured batches",
            "BCRST" => "BCRST must be traded in configured batches",
            "HCRST" => "HCRST must be traded in configured batches",
            _ => "resource must be traded in configured batches",
        }
        .into());
    }

    Ok((resources / resource_amount).saturating_mul(ladder_amount))
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
        let config = WorldConfig::default_40x64();

        assert_eq!(ladders_for_resources(3, 0, 0, &config), Ok(1));
        assert_eq!(ladders_for_resources(0, 1, 0, &config), Ok(3));
        assert_eq!(ladders_for_resources(0, 0, 1, &config), Ok(12));
        assert_eq!(ladders_for_resources(6, 2, 1, &config), Ok(20));
    }

    #[test]
    fn resources_trade_for_ladders_supports_multi_resource_batches() {
        let mut config = WorldConfig::default_40x64();
        config.ladder_bcrst_resource_amount = 2;
        config.ladder_bcrst_ladder_amount = 5;

        assert_eq!(ladders_for_resources(0, 2, 0, &config), Ok(5));
        assert_eq!(
            ladders_for_resources(0, 1, 0, &config),
            Err("BCRST must be traded in configured batches".into())
        );
    }

    #[test]
    fn trading_banked_resources_spends_resources_and_adds_ladders() {
        let config = WorldConfig::default_40x64();
        let mut agent = Agent::new(ActorId::zero(), 2, &config);
        agent.banked_scrst = 5;
        agent.banked_bcrst = 1;
        agent.banked_hcrst = 1;

        assert_eq!(
            agent.trade_banked_resources_for_ladders(3, 1, 1, &config),
            Ok(16)
        );
        assert_eq!(agent.banked_scrst, 2);
        assert_eq!(agent.banked_bcrst, 0);
        assert_eq!(agent.banked_hcrst, 0);
        assert_eq!(agent.ladders_remaining, config.starting_ladders + 16);
    }

    #[test]
    fn resource_trade_rejects_invalid_or_missing_resources() {
        let config = WorldConfig::default_40x64();
        let mut agent = Agent::new(ActorId::zero(), 2, &config);
        agent.banked_scrst = 4;

        assert_eq!(
            ladders_for_resources(0, 0, 0, &config),
            Err("no resources selected".into())
        );
        assert_eq!(
            agent.trade_banked_resources_for_ladders(4, 0, 0, &config),
            Err("SCRST must be traded in configured batches".into())
        );
        assert_eq!(
            agent.trade_banked_resources_for_ladders(6, 0, 0, &config),
            Err("not enough banked SCRST".into())
        );
    }
}
