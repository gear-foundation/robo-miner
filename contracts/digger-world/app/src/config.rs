use sails_rs::prelude::*;

use crate::constants::*;

pub type RawWorldConfig = (
    (u32, u32, u32, u32, u32, u32, u32, u32, u32, u32),
    (u32, u32, u32, u32, u32, u32),
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LadderExchangeRate {
    pub(crate) scrst_resource_amount: u32,
    pub(crate) scrst_ladder_amount: u32,
    pub(crate) bcrst_resource_amount: u32,
    pub(crate) bcrst_ladder_amount: u32,
    pub(crate) hcrst_resource_amount: u32,
    pub(crate) hcrst_ladder_amount: u32,
}

impl LadderExchangeRate {
    #[cfg(test)]
    pub(crate) fn default_rates() -> Self {
        Self {
            scrst_resource_amount: 1,
            scrst_ladder_amount: 2,
            bcrst_resource_amount: 1,
            bcrst_ladder_amount: 4,
            hcrst_resource_amount: 1,
            hcrst_ladder_amount: 12,
        }
    }

    pub(crate) fn from_raw(
        scrst_resource_amount: u32,
        scrst_ladder_amount: u32,
        bcrst_resource_amount: u32,
        bcrst_ladder_amount: u32,
        hcrst_resource_amount: u32,
        hcrst_ladder_amount: u32,
    ) -> Self {
        Self {
            scrst_resource_amount,
            scrst_ladder_amount,
            bcrst_resource_amount,
            bcrst_ladder_amount,
            hcrst_resource_amount,
            hcrst_ladder_amount,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorldConfig {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) total_resources: u32,
    pub(crate) scrst_resources: u32,
    pub(crate) bcrst_resources: u32,
    pub(crate) hcrst_resources: u32,
    pub(crate) starting_hp: u32,
    pub(crate) starting_ladders: u32,
    pub(crate) backpack_capacity: u32,
    pub(crate) chest_dynamite_chance_bps: u32,
    pub(crate) ladder_exchange_rate: LadderExchangeRate,
}

impl WorldConfig {
    #[cfg(test)]
    pub(crate) fn default_40x64() -> Self {
        Self {
            width: MAP_WIDTH,
            height: MAP_HEIGHT,
            total_resources: 100,
            scrst_resources: 77,
            bcrst_resources: 19,
            hcrst_resources: 4,
            starting_hp: 1,
            starting_ladders: 50,
            backpack_capacity: 10,
            chest_dynamite_chance_bps: 1000,
            ladder_exchange_rate: LadderExchangeRate::default_rates(),
        }
    }

    pub(crate) fn from_raw(config: RawWorldConfig) -> Self {
        let (
            (
                width,
                height,
                total_resources,
                scrst_resources,
                bcrst_resources,
                hcrst_resources,
                starting_hp,
                starting_ladders,
                backpack_capacity,
                chest_dynamite_chance_bps,
            ),
            (
                ladder_scrst_resource_amount,
                ladder_scrst_ladder_amount,
                ladder_bcrst_resource_amount,
                ladder_bcrst_ladder_amount,
                ladder_hcrst_resource_amount,
                ladder_hcrst_ladder_amount,
            ),
        ) = config;

        Self {
            width,
            height,
            total_resources,
            scrst_resources,
            bcrst_resources,
            hcrst_resources,
            starting_hp,
            starting_ladders,
            backpack_capacity,
            chest_dynamite_chance_bps,
            ladder_exchange_rate: LadderExchangeRate::from_raw(
                ladder_scrst_resource_amount,
                ladder_scrst_ladder_amount,
                ladder_bcrst_resource_amount,
                ladder_bcrst_ladder_amount,
                ladder_hcrst_resource_amount,
                ladder_hcrst_ladder_amount,
            ),
        }
    }
}

pub(crate) fn config_view(config: &WorldConfig) -> Vec<u32> {
    vec![
        config.width,
        config.height,
        config.total_resources,
        config.scrst_resources,
        config.bcrst_resources,
        config.hcrst_resources,
        config.starting_hp,
        config.starting_ladders,
        config.backpack_capacity,
        config.chest_dynamite_chance_bps,
    ]
}

pub(crate) fn ladder_exchange_rate_view(rate: &LadderExchangeRate) -> Vec<u32> {
    vec![
        rate.scrst_resource_amount,
        rate.scrst_ladder_amount,
        rate.bcrst_resource_amount,
        rate.bcrst_ladder_amount,
        rate.hcrst_resource_amount,
        rate.hcrst_ladder_amount,
    ]
}

pub(crate) fn ensure_supported_config(config: &WorldConfig) -> Result<(), String> {
    if config.width != MAP_WIDTH || config.height != MAP_HEIGHT {
        return Err("only 40x64 maps are supported in MVP".into());
    }
    if config.scrst_resources + config.bcrst_resources + config.hcrst_resources
        != config.total_resources
    {
        return Err("resource counts must sum to total resources".into());
    }
    if config.total_resources >= MAP_CELLS as u32 {
        return Err("too many resources for map".into());
    }
    if config.starting_hp == 0 {
        return Err("starting hp must be greater than zero".into());
    }
    if config.backpack_capacity == 0 {
        return Err("backpack capacity must be greater than zero".into());
    }
    if config.chest_dynamite_chance_bps > 10_000 {
        return Err("chest dynamite chance must be <= 10000 bps".into());
    }
    ensure_supported_ladder_exchange_rate(&config.ladder_exchange_rate)?;
    Ok(())
}

pub(crate) fn ensure_supported_ladder_exchange_rate(
    rate: &LadderExchangeRate,
) -> Result<(), String> {
    if rate.scrst_resource_amount == 0
        || rate.scrst_ladder_amount == 0
        || rate.bcrst_resource_amount == 0
        || rate.bcrst_ladder_amount == 0
        || rate.hcrst_resource_amount == 0
        || rate.hcrst_ladder_amount == 0
    {
        return Err("ladder exchange rate values must be greater than zero".into());
    }
    Ok(())
}
