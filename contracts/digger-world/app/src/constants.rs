pub const MAP_WIDTH: u32 = 40;
pub const MAP_HEIGHT: u32 = 64;
pub const MAP_CELLS: usize = (MAP_WIDTH as usize) * (MAP_HEIGHT as usize);

pub const TILE_EMPTY: u8 = 0;
pub const TILE_DIRT: u8 = 1;
pub const TILE_STONE: u8 = 2;
pub const TILE_LAVA: u8 = 3;
pub const TILE_LADDER: u8 = 4;
pub const TILE_RESOURCE_SCRST: u8 = 10;
pub const TILE_RESOURCE_BCRST: u8 = 11;
pub const TILE_RESOURCE_HCRST: u8 = 12;
pub const TILE_SURFACE: u8 = 20;

pub const RESOURCE_SCRST: u32 = 1;
pub const RESOURCE_BCRST: u32 = 2;
pub const RESOURCE_HCRST: u32 = 3;

pub const SESSION_CREATED: u32 = 0;
pub const SESSION_ACTIVE: u32 = 1;
pub const SESSION_FINISHED: u32 = 2;

pub const MIN_SESSION_PARTICIPANTS: usize = 8;
pub const AUTO_START_SESSION_PARTICIPANTS: usize = 10;

pub const AGENT_ACTIVE: u32 = 1;
pub const AGENT_SURFACED: u32 = 2;
pub const AGENT_DEAD: u32 = 3;
pub const AGENT_EXITED: u32 = 4;

pub const DIR_UP: u32 = 0;
pub const DIR_RIGHT: u32 = 1;
pub const DIR_DOWN: u32 = 2;
pub const DIR_LEFT: u32 = 3;
pub const DIR_CURRENT: u32 = 4;
