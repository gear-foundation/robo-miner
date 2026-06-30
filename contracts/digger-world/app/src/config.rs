use sails_rs::prelude::*;

use crate::constants::*;

pub type WorldBaseConfigInput = (u32, u32, u32, u32, u32, u32, u32, u32, u32, u32);
pub type LadderExchangeRateInput = (u32, u32, u32, u32, u32, u32);
pub type WorldConfigInput = (WorldBaseConfigInput, LadderExchangeRateInput);

pub fn default_40x64_input() -> WorldConfigInput {
    (
        (
            MAP_WIDTH,
            MAP_HEIGHT,
            100,
            77,
            19,
            4,
            1,
            50,
            10,
            DEFAULT_CHEST_DYNAMITE_CHANCE_BPS,
        ),
        (
            DEFAULT_LADDER_SCRST_RESOURCE_AMOUNT,
            DEFAULT_LADDER_SCRST_LADDER_AMOUNT,
            DEFAULT_LADDER_BCRST_RESOURCE_AMOUNT,
            DEFAULT_LADDER_BCRST_LADDER_AMOUNT,
            DEFAULT_LADDER_HCRST_RESOURCE_AMOUNT,
            DEFAULT_LADDER_HCRST_LADDER_AMOUNT,
        ),
    )
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
    pub(crate) ladder_scrst_resource_amount: u32,
    pub(crate) ladder_scrst_ladder_amount: u32,
    pub(crate) ladder_bcrst_resource_amount: u32,
    pub(crate) ladder_bcrst_ladder_amount: u32,
    pub(crate) ladder_hcrst_resource_amount: u32,
    pub(crate) ladder_hcrst_ladder_amount: u32,
}

impl WorldConfig {
    #[cfg(test)]
    pub(crate) fn default_40x64() -> Self {
        Self::from_input(default_40x64_input())
    }

    pub(crate) fn from_input(input: WorldConfigInput) -> Self {
        let (base, ladder_exchange_rate) = input;
        let (
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
        ) = base;
        let (
            ladder_scrst_resource_amount,
            ladder_scrst_ladder_amount,
            ladder_bcrst_resource_amount,
            ladder_bcrst_ladder_amount,
            ladder_hcrst_resource_amount,
            ladder_hcrst_ladder_amount,
        ) = ladder_exchange_rate;

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
            ladder_scrst_resource_amount,
            ladder_scrst_ladder_amount,
            ladder_bcrst_resource_amount,
            ladder_bcrst_ladder_amount,
            ladder_hcrst_resource_amount,
            ladder_hcrst_ladder_amount,
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
        config.ladder_scrst_resource_amount,
        config.ladder_scrst_ladder_amount,
        config.ladder_bcrst_resource_amount,
        config.ladder_bcrst_ladder_amount,
        config.ladder_hcrst_resource_amount,
        config.ladder_hcrst_ladder_amount,
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
    if config.chest_dynamite_chance_bps > PROBABILITY_BASIS_POINTS {
        return Err("chest dynamite chance must be at most 100%".into());
    }
    ensure_ladder_exchange_rate(
        config.ladder_scrst_resource_amount,
        config.ladder_scrst_ladder_amount,
        config.ladder_bcrst_resource_amount,
        config.ladder_bcrst_ladder_amount,
        config.ladder_hcrst_resource_amount,
        config.ladder_hcrst_ladder_amount,
    )?;
    Ok(())
}

pub(crate) fn ladder_exchange_rate_view(config: &WorldConfig) -> Vec<u32> {
    vec![
        config.ladder_scrst_resource_amount,
        config.ladder_scrst_ladder_amount,
        config.ladder_bcrst_resource_amount,
        config.ladder_bcrst_ladder_amount,
        config.ladder_hcrst_resource_amount,
        config.ladder_hcrst_ladder_amount,
    ]
}

pub(crate) fn ensure_ladder_exchange_rate(
    ladder_scrst_resource_amount: u32,
    ladder_scrst_ladder_amount: u32,
    ladder_bcrst_resource_amount: u32,
    ladder_bcrst_ladder_amount: u32,
    ladder_hcrst_resource_amount: u32,
    ladder_hcrst_ladder_amount: u32,
) -> Result<(), String> {
    if ladder_scrst_resource_amount == 0 {
        return Err("ladder SCRST resource amount must be greater than zero".into());
    }
    if ladder_scrst_ladder_amount == 0 {
        return Err("ladder SCRST ladder amount must be greater than zero".into());
    }
    if ladder_bcrst_resource_amount == 0 {
        return Err("ladder BCRST resource amount must be greater than zero".into());
    }
    if ladder_bcrst_ladder_amount == 0 {
        return Err("ladder BCRST ladder amount must be greater than zero".into());
    }
    if ladder_hcrst_resource_amount == 0 {
        return Err("ladder HCRST resource amount must be greater than zero".into());
    }
    if ladder_hcrst_ladder_amount == 0 {
        return Err("ladder HCRST ladder amount must be greater than zero".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_uses_ten_percent_chest_dynamite_chance() {
        let config = WorldConfig::default_40x64();

        assert_eq!(
            config.chest_dynamite_chance_bps,
            DEFAULT_CHEST_DYNAMITE_CHANCE_BPS
        );
        assert_eq!(config_view(&config)[9], DEFAULT_CHEST_DYNAMITE_CHANCE_BPS);
    }

    #[test]
    fn default_config_uses_configured_ladder_exchange_rate() {
        let config = WorldConfig::default_40x64();

        assert_eq!(
            ladder_exchange_rate_view(&config),
            vec![
                DEFAULT_LADDER_SCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_SCRST_LADDER_AMOUNT,
                DEFAULT_LADDER_BCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_BCRST_LADDER_AMOUNT,
                DEFAULT_LADDER_HCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_HCRST_LADDER_AMOUNT,
            ]
        );
        assert_eq!(
            &config_view(&config)[10..16],
            &[
                DEFAULT_LADDER_SCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_SCRST_LADDER_AMOUNT,
                DEFAULT_LADDER_BCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_BCRST_LADDER_AMOUNT,
                DEFAULT_LADDER_HCRST_RESOURCE_AMOUNT,
                DEFAULT_LADDER_HCRST_LADDER_AMOUNT,
            ]
        );
    }

    #[test]
    fn config_rejects_impossible_chest_dynamite_chance() {
        let mut config = WorldConfig::default_40x64();
        config.chest_dynamite_chance_bps = PROBABILITY_BASIS_POINTS + 1;

        assert_eq!(
            ensure_supported_config(&config),
            Err("chest dynamite chance must be at most 100%".into())
        );
    }

    #[test]
    fn config_rejects_zero_ladder_exchange_rate_parts() {
        assert_eq!(
            ensure_ladder_exchange_rate(0, 1, 1, 1, 1, 1),
            Err("ladder SCRST resource amount must be greater than zero".into())
        );
        assert_eq!(
            ensure_ladder_exchange_rate(1, 0, 1, 1, 1, 1),
            Err("ladder SCRST ladder amount must be greater than zero".into())
        );
        assert_eq!(
            ensure_ladder_exchange_rate(1, 1, 0, 1, 1, 1),
            Err("ladder BCRST resource amount must be greater than zero".into())
        );
        assert_eq!(
            ensure_ladder_exchange_rate(1, 1, 1, 0, 1, 1),
            Err("ladder BCRST ladder amount must be greater than zero".into())
        );
        assert_eq!(
            ensure_ladder_exchange_rate(1, 1, 1, 1, 0, 1),
            Err("ladder HCRST resource amount must be greater than zero".into())
        );
        assert_eq!(
            ensure_ladder_exchange_rate(1, 1, 1, 1, 1, 0),
            Err("ladder HCRST ladder amount must be greater than zero".into())
        );
    }
}
