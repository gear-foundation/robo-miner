use sails_rs::prelude::*;

use crate::constants::*;

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
}

impl WorldConfig {
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
    Ok(())
}
