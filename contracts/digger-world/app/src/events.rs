use sails_rs::prelude::*;

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum WorldEvents {
    AgentRegistered(u64, [u8; 32]),
    AgentSpawned(u64, [u8; 32], u32, u32),
    SessionStarted(u64),
    AgentMoved(u64, [u8; 32], u32, u32, u32, u32),
    TileDrilled(u64, [u8; 32], u32, u32, u32, u32),
    ResourceExtracted(u64, [u8; 32], u32, u32, u32, u32),
    LadderPlaced(u64, [u8; 32], u32, u32, u32),
    AgentSurfaced(u64, [u8; 32], u32, u32, u32),
    AgentDied(u64, [u8; 32], u32, u32, u32),
    AgentExited(u64, [u8; 32]),
    ResourcesMinted(u64, [u8; 32], u32, u32, u32),
    StoneMoved(u64, [u8; 32], u32, u32, u32, u32),
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum AdminEvents {
    Killed([u8; 32]),
    MapGenerated(u64, u64),
    SessionStarted(u64),
    SessionFinished(u64),
    ResourceVmtUpdated([u8; 32], [u8; 32]),
}
