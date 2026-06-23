use sails_rs::prelude::*;

use crate::{config::WorldConfig, constants::*};

pub(crate) fn next_spawn_x(spawn_cursor: u32) -> u32 {
    (2 + spawn_cursor.saturating_mul(4)) % MAP_WIDTH
}

pub(crate) fn index_of(x: u32, y: u32) -> Result<usize, String> {
    if x >= MAP_WIDTH || y >= MAP_HEIGHT {
        return Err("position is outside map bounds".into());
    }
    Ok((y as usize) * (MAP_WIDTH as usize) + (x as usize))
}

pub(crate) fn ensure_map_loaded(map: &[u8]) -> Result<(), String> {
    if map.len() != MAP_CELLS {
        return Err("map is not loaded".into());
    }
    Ok(())
}

pub(crate) fn tile_at(map: &[u8], x: u32, y: u32) -> Result<u8, String> {
    ensure_map_loaded(map)?;
    Ok(map[index_of(x, y)?])
}

pub(crate) fn validate_uploaded_map(
    uploaded: &[u32],
    config: &WorldConfig,
) -> Result<Vec<u8>, String> {
    if uploaded.len() != MAP_CELLS {
        return Err("uploaded map has invalid length".into());
    }

    let mut map = Vec::new();
    map.reserve(MAP_CELLS);
    let mut scrst = 0u32;
    let mut bcrst = 0u32;
    let mut hcrst = 0u32;

    for (index, cell) in uploaded.iter().copied().enumerate() {
        if cell > u8::MAX as u32 {
            return Err("uploaded map contains unsupported tile value".into());
        }

        let tile = cell as u8;
        if !is_known_tile(tile) {
            return Err("uploaded map contains unknown tile".into());
        }

        let y = (index as u32) / MAP_WIDTH;
        if y == 0 && tile != TILE_SURFACE {
            return Err("top row must contain only surface tiles".into());
        }
        if y > 0 && tile == TILE_SURFACE {
            return Err("surface tiles are only allowed on top row".into());
        }

        match tile {
            TILE_RESOURCE_SCRST => scrst = scrst.saturating_add(1),
            TILE_RESOURCE_BCRST => bcrst = bcrst.saturating_add(1),
            TILE_RESOURCE_HCRST => hcrst = hcrst.saturating_add(1),
            _ => {}
        }

        map.push(tile);
    }

    if scrst != config.scrst_resources {
        return Err("uploaded map has invalid SCRST count".into());
    }
    if bcrst != config.bcrst_resources {
        return Err("uploaded map has invalid BCRST count".into());
    }
    if hcrst != config.hcrst_resources {
        return Err("uploaded map has invalid HCRST count".into());
    }
    if scrst + bcrst + hcrst != config.total_resources {
        return Err("uploaded map has invalid total resource count".into());
    }

    for y in 0..MAP_HEIGHT.saturating_sub(1) {
        for x in 0..MAP_WIDTH {
            let index = index_of(x, y).expect("map coordinate is valid");
            let below_index = index_of(x, y + 1).expect("map coordinate is valid");
            if map[index] == TILE_STONE && map[below_index] == TILE_EMPTY {
                return Err("uploaded map has unsupported stone".into());
            }
        }
    }

    Ok(map)
}

pub(crate) fn target_position(x: u32, y: u32, direction: u32) -> Result<(u32, u32), String> {
    match direction {
        DIR_UP => {
            if y == 0 {
                Err("target position is outside map bounds".into())
            } else {
                Ok((x, y - 1))
            }
        }
        DIR_RIGHT => {
            if x + 1 >= MAP_WIDTH {
                Err("target position is outside map bounds".into())
            } else {
                Ok((x + 1, y))
            }
        }
        DIR_DOWN => {
            if y + 1 >= MAP_HEIGHT {
                Err("target position is outside map bounds".into())
            } else {
                Ok((x, y + 1))
            }
        }
        DIR_LEFT => {
            if x == 0 {
                Err("target position is outside map bounds".into())
            } else {
                Ok((x - 1, y))
            }
        }
        DIR_CURRENT => Ok((x, y)),
        _ => Err("unknown direction".into()),
    }
}

pub(crate) fn is_dug_tile(tile: u8) -> bool {
    matches!(tile, TILE_EMPTY | TILE_SURFACE | TILE_LADDER)
}

fn is_known_tile(tile: u8) -> bool {
    matches!(
        tile,
        TILE_EMPTY
            | TILE_DIRT
            | TILE_STONE
            | TILE_CHEST
            | TILE_LADDER
            | TILE_RESOURCE_SCRST
            | TILE_RESOURCE_BCRST
            | TILE_RESOURCE_HCRST
            | TILE_SURFACE
    )
}

pub(crate) fn ensure_move_allowed(
    direction: u32,
    current_tile: u8,
    target_tile: u8,
) -> Result<(), String> {
    if !is_dug_tile(target_tile) {
        return Err("target tile is not traversable".into());
    }
    if direction == DIR_UP {
        let climbs_to_ladder = current_tile == TILE_LADDER && target_tile == TILE_LADDER;
        let exits_to_surface = current_tile == TILE_LADDER && target_tile == TILE_SURFACE;
        if !climbs_to_ladder && !exits_to_surface {
            return Err("upward movement requires a ladder".into());
        }
    }
    Ok(())
}

pub(crate) fn ensure_drill_allowed(
    tile: u8,
    carried_total: u32,
    backpack_capacity: u32,
) -> Result<(), String> {
    match tile {
        TILE_DIRT => Ok(()),
        TILE_RESOURCE_SCRST | TILE_RESOURCE_BCRST | TILE_RESOURCE_HCRST => {
            if carried_total >= backpack_capacity {
                Err("backpack is full".into())
            } else {
                Ok(())
            }
        }
        TILE_STONE => Err("stone cannot be drilled".into()),
        TILE_CHEST => Ok(()),
        TILE_EMPTY | TILE_SURFACE | TILE_LADDER => Err("tile is already open".into()),
        _ => Err("unknown tile kind".into()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChestOutcome {
    Dynamite,
    Ladders,
}

pub(crate) fn chest_outcome(
    block_timestamp: u64,
    session_seed: u64,
    x: u32,
    y: u32,
) -> ChestOutcome {
    let time_bucket = block_timestamp / 2;
    let coord_mix = (x as u64) ^ ((y as u64) << 1) ^ (((x as u64).saturating_add(y as u64)) << 4);
    let roll = time_bucket ^ session_seed ^ coord_mix ^ (coord_mix >> 3) ^ (time_bucket >> 5);

    if roll & 1 == 0 {
        ChestOutcome::Ladders
    } else {
        ChestOutcome::Dynamite
    }
}

pub(crate) fn gravity_target(map: &[u8], x: u32, y: u32) -> Result<(u32, u32), String> {
    ensure_map_loaded(map)?;
    if matches!(tile_at(map, x, y)?, TILE_LADDER | TILE_SURFACE) {
        return Ok((x, y));
    }
    let mut target_y = y;
    while target_y + 1 < MAP_HEIGHT {
        match tile_at(map, x, target_y + 1)? {
            TILE_EMPTY => target_y = target_y.saturating_add(1),
            TILE_LADDER => {
                target_y = target_y.saturating_add(1);
                break;
            }
            _ => break,
        }
    }
    Ok((x, target_y))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StoneFall {
    pub(crate) from_x: u32,
    pub(crate) from_y: u32,
    pub(crate) to_x: u32,
    pub(crate) to_y: u32,
    pub(crate) crushed_agent: bool,
}

pub(crate) fn settle_stones_above_open_cell(
    map: &mut [u8],
    x: u32,
    y: u32,
    agent_position: Option<(u32, u32)>,
) -> Result<Vec<StoneFall>, String> {
    ensure_map_loaded(map)?;
    if x >= MAP_WIDTH || y >= MAP_HEIGHT {
        return Err("position is outside map bounds".into());
    }
    if tile_at(map, x, y)? != TILE_EMPTY {
        return Ok(Vec::new());
    }

    let mut falls = Vec::new();
    let mut open_y = y;
    while open_y > 0 && tile_at(map, x, open_y - 1)? == TILE_STONE {
        let from_y = open_y - 1;

        let mut to_y = from_y;
        let mut crushed_agent = false;
        while to_y + 1 < MAP_HEIGHT && tile_at(map, x, to_y + 1)? == TILE_EMPTY {
            to_y = to_y.saturating_add(1);
            if agent_position == Some((x, to_y)) {
                crushed_agent = true;
                break;
            }
        }

        if to_y == from_y {
            break;
        }

        let from_index = index_of(x, from_y)?;
        let to_index = index_of(x, to_y)?;
        map[from_index] = TILE_EMPTY;
        map[to_index] = TILE_STONE;
        falls.push(StoneFall {
            from_x: x,
            from_y,
            to_x: x,
            to_y,
            crushed_agent,
        });

        if crushed_agent {
            break;
        }

        open_y = from_y;
    }

    Ok(falls)
}

#[cfg(test)]
fn is_resource(tile: u8) -> bool {
    matches!(
        tile,
        TILE_RESOURCE_SCRST | TILE_RESOURCE_BCRST | TILE_RESOURCE_HCRST
    )
}

pub(crate) fn generate_map(seed: u64, config: &WorldConfig) -> Vec<u8> {
    let mut map = Vec::new();
    map.resize(MAP_CELLS, TILE_DIRT);

    for x in 0..MAP_WIDTH {
        let index = index_of(x, 0).expect("surface coordinate is valid");
        map[index] = TILE_SURFACE;
    }

    for y in 1..MAP_HEIGHT {
        for x in 0..MAP_WIDTH {
            let roll = noise(seed, x, y, 1) % 100;
            let depth = y.saturating_mul(100) / MAP_HEIGHT;
            let tile = if depth > 72 && roll < 5 {
                TILE_CHEST
            } else if depth > 45 && roll < 18 {
                TILE_STONE
            } else if depth > 20 && roll < 8 {
                TILE_STONE
            } else {
                TILE_DIRT
            };
            let index = index_of(x, y).expect("map coordinate is valid");
            map[index] = tile;
        }
    }

    place_resources(
        &mut map,
        seed,
        TILE_RESOURCE_SCRST,
        config.scrst_resources,
        4,
        38,
        11,
    );
    place_resources(
        &mut map,
        seed,
        TILE_RESOURCE_BCRST,
        config.bcrst_resources,
        18,
        54,
        23,
    );
    place_resources(
        &mut map,
        seed,
        TILE_RESOURCE_HCRST,
        config.hcrst_resources,
        44,
        63,
        37,
    );

    map
}

fn place_resources(
    map: &mut [u8],
    seed: u64,
    resource_tile: u8,
    count: u32,
    min_y: u32,
    max_y: u32,
    salt: u64,
) {
    let mut placed = 0;
    let mut attempt = 0;
    let depth_span = max_y.saturating_sub(min_y).saturating_add(1);

    while placed < count && attempt < 20_000 {
        let roll = noise(seed, placed, attempt, salt);
        let x = (roll % MAP_WIDTH as u64) as u32;
        let y = min_y + (((roll >> 16) % depth_span as u64) as u32);
        let index = index_of(x, y).expect("resource coordinate is valid");
        let current = map[index];

        if current == TILE_DIRT || current == TILE_STONE || current == TILE_CHEST {
            map[index] = resource_tile;
            placed += 1;
        }

        attempt += 1;
    }
}

fn noise(seed: u64, x: u32, y: u32, salt: u64) -> u64 {
    let mut value = seed
        ^ (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (y as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9)
        ^ salt.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::WorldConfig;

    #[test]
    fn default_map_has_expected_dimensions_and_resources() {
        let config = WorldConfig::default_40x64();
        let map = generate_map(42, &config);

        assert_eq!(map.len(), MAP_CELLS);
        assert_eq!(
            map.iter().filter(|tile| **tile == TILE_SURFACE).count(),
            MAP_WIDTH as usize
        );
        assert_eq!(
            map.iter().filter(|tile| is_resource(**tile)).count(),
            config.total_resources as usize
        );
        assert_eq!(
            map.iter()
                .filter(|tile| **tile == TILE_RESOURCE_SCRST)
                .count(),
            config.scrst_resources as usize
        );
        assert_eq!(
            map.iter()
                .filter(|tile| **tile == TILE_RESOURCE_BCRST)
                .count(),
            config.bcrst_resources as usize
        );
        assert_eq!(
            map.iter()
                .filter(|tile| **tile == TILE_RESOURCE_HCRST)
                .count(),
            config.hcrst_resources as usize
        );
    }

    #[test]
    fn generation_is_deterministic_for_same_seed() {
        let config = WorldConfig::default_40x64();
        assert_eq!(generate_map(7, &config), generate_map(7, &config));
    }

    #[test]
    fn generation_changes_with_seed() {
        let config = WorldConfig::default_40x64();
        assert_ne!(generate_map(7, &config), generate_map(8, &config));
    }

    #[test]
    fn generated_map_is_valid_upload() {
        let config = WorldConfig::default_40x64();
        let generated = generate_map(42, &config);
        let uploaded: Vec<u32> = generated.iter().copied().map(u32::from).collect();

        assert_eq!(validate_uploaded_map(&uploaded, &config), Ok(generated));
    }

    #[test]
    fn tile_at_rejects_unloaded_map() {
        assert_eq!(tile_at(&[], 0, 0), Err("map is not loaded".into()));
    }

    #[test]
    fn dug_tiles_are_open_or_laddered_cells() {
        assert!(is_dug_tile(TILE_EMPTY));
        assert!(is_dug_tile(TILE_SURFACE));
        assert!(is_dug_tile(TILE_LADDER));

        assert!(!is_dug_tile(TILE_DIRT));
        assert!(!is_dug_tile(TILE_STONE));
        assert!(!is_dug_tile(TILE_CHEST));
        assert!(!is_dug_tile(TILE_RESOURCE_SCRST));
        assert!(!is_dug_tile(TILE_RESOURCE_BCRST));
        assert!(!is_dug_tile(TILE_RESOURCE_HCRST));
    }

    #[test]
    fn uploaded_map_rejects_invalid_length() {
        let config = WorldConfig::default_40x64();
        let mut uploaded: Vec<u32> = generate_map(42, &config)
            .iter()
            .copied()
            .map(u32::from)
            .collect();
        uploaded.pop();

        assert!(validate_uploaded_map(&uploaded, &config).is_err());
    }

    #[test]
    fn uploaded_map_rejects_non_surface_top_row() {
        let config = WorldConfig::default_40x64();
        let mut uploaded: Vec<u32> = generate_map(42, &config)
            .iter()
            .copied()
            .map(u32::from)
            .collect();
        uploaded[0] = TILE_DIRT as u32;

        assert!(validate_uploaded_map(&uploaded, &config).is_err());
    }

    #[test]
    fn uploaded_map_rejects_bad_resource_count() {
        let config = WorldConfig::default_40x64();
        let mut uploaded: Vec<u32> = generate_map(42, &config)
            .iter()
            .copied()
            .map(u32::from)
            .collect();
        let resource_index = uploaded
            .iter()
            .position(|tile| *tile == TILE_RESOURCE_SCRST as u32)
            .expect("generated map contains SCRST");
        uploaded[resource_index] = TILE_DIRT as u32;

        assert!(validate_uploaded_map(&uploaded, &config).is_err());
    }

    #[test]
    fn uploaded_map_rejects_stone_over_empty() {
        let config = WorldConfig::default_40x64();
        let mut uploaded: Vec<u32> = generate_map(42, &config)
            .iter()
            .copied()
            .map(u32::from)
            .collect();
        uploaded[index_of(3, 1).unwrap()] = TILE_STONE as u32;
        uploaded[index_of(3, 2).unwrap()] = TILE_EMPTY as u32;

        assert_eq!(
            validate_uploaded_map(&uploaded, &config),
            Err("uploaded map has unsupported stone".into())
        );
    }

    #[test]
    fn target_position_checks_bounds() {
        assert_eq!(target_position(2, 2, DIR_UP), Ok((2, 1)));
        assert_eq!(target_position(2, 2, DIR_RIGHT), Ok((3, 2)));
        assert_eq!(target_position(2, 2, DIR_DOWN), Ok((2, 3)));
        assert_eq!(target_position(2, 2, DIR_LEFT), Ok((1, 2)));
        assert_eq!(target_position(2, 2, DIR_CURRENT), Ok((2, 2)));
        assert!(target_position(0, 0, DIR_LEFT).is_err());
        assert!(target_position(0, 0, DIR_UP).is_err());
    }

    #[test]
    fn upward_movement_requires_ladder() {
        assert_eq!(
            ensure_move_allowed(DIR_UP, TILE_EMPTY, TILE_EMPTY),
            Err("upward movement requires a ladder".into())
        );
        assert_eq!(
            ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_EMPTY),
            Err("upward movement requires a ladder".into())
        );
        assert_eq!(
            ensure_move_allowed(DIR_UP, TILE_EMPTY, TILE_LADDER),
            Err("upward movement requires a ladder".into())
        );
        assert!(ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_SURFACE).is_ok());
        assert!(ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_LADDER).is_ok());
    }

    #[test]
    fn non_upward_movement_can_enter_any_traversable_tile() {
        assert!(ensure_move_allowed(DIR_DOWN, TILE_EMPTY, TILE_EMPTY).is_ok());
        assert!(ensure_move_allowed(DIR_LEFT, TILE_EMPTY, TILE_LADDER).is_ok());
        assert!(ensure_move_allowed(DIR_RIGHT, TILE_LADDER, TILE_SURFACE).is_ok());
    }

    #[test]
    fn movement_rejects_non_traversable_tiles() {
        assert_eq!(
            ensure_move_allowed(DIR_DOWN, TILE_EMPTY, TILE_DIRT),
            Err("target tile is not traversable".into())
        );
        assert_eq!(
            ensure_move_allowed(DIR_RIGHT, TILE_EMPTY, TILE_RESOURCE_SCRST),
            Err("target tile is not traversable".into())
        );
    }

    #[test]
    fn drill_rules_allow_chests_and_reject_stone_and_open_tiles() {
        assert!(ensure_drill_allowed(TILE_DIRT, 0, 10).is_ok());
        assert!(ensure_drill_allowed(TILE_CHEST, 0, 10).is_ok());
        assert!(ensure_drill_allowed(TILE_RESOURCE_SCRST, 9, 10).is_ok());

        assert_eq!(
            ensure_drill_allowed(TILE_RESOURCE_BCRST, 10, 10),
            Err("backpack is full".into())
        );
        assert_eq!(
            ensure_drill_allowed(TILE_STONE, 0, 10),
            Err("stone cannot be drilled".into())
        );
        assert_eq!(
            ensure_drill_allowed(TILE_EMPTY, 0, 10),
            Err("tile is already open".into())
        );
        assert_eq!(
            ensure_drill_allowed(TILE_LADDER, 0, 10),
            Err("tile is already open".into())
        );
        assert_eq!(
            ensure_drill_allowed(TILE_SURFACE, 0, 10),
            Err("tile is already open".into())
        );
    }

    #[test]
    fn chest_outcome_is_deterministic_but_timestamp_sensitive() {
        let first = chest_outcome(42, 777, 5, 9);
        assert_eq!(chest_outcome(42, 777, 5, 9), first);
        assert_ne!(chest_outcome(42, 777, 5, 9), chest_outcome(42, 778, 5, 9));
        assert_ne!(chest_outcome(42, 777, 5, 9), chest_outcome(42, 777, 6, 9));

        let mut saw_dynamite = false;
        let mut saw_ladders = false;
        for timestamp in 1..=32 {
            match chest_outcome(timestamp, 777, 5, 9) {
                ChestOutcome::Dynamite => saw_dynamite = true,
                ChestOutcome::Ladders => saw_ladders = true,
            }
        }
        assert!(saw_dynamite);
        assert!(saw_ladders);
    }

    #[test]
    fn gravity_falls_through_consecutive_empty_tiles() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_EMPTY;
        map[index_of(3, 2).unwrap()] = TILE_EMPTY;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;
        map[index_of(3, 4).unwrap()] = TILE_DIRT;

        assert_eq!(gravity_target(&map, 3, 1), Ok((3, 3)));
    }

    #[test]
    fn gravity_falls_onto_ladder_but_not_through_it() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_EMPTY;
        map[index_of(3, 2).unwrap()] = TILE_LADDER;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;

        assert_eq!(gravity_target(&map, 3, 1), Ok((3, 2)));
    }

    #[test]
    fn moving_up_from_ladder_to_empty_does_not_leave_agent_floating_above_ladder() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_EMPTY;
        map[index_of(3, 2).unwrap()] = TILE_LADDER;

        assert_eq!(
            ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_EMPTY),
            Err("upward movement requires a ladder".into())
        );
        assert_eq!(gravity_target(&map, 3, 1), Ok((3, 2)));
    }

    #[test]
    fn moving_up_to_ladder_keeps_agent_on_target_ladder() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_LADDER;
        map[index_of(3, 2).unwrap()] = TILE_LADDER;

        assert!(ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_LADDER).is_ok());
        assert_eq!(gravity_target(&map, 3, 1), Ok((3, 1)));
    }

    #[test]
    fn moving_up_from_ladder_to_surface_keeps_agent_on_surface() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_LADDER;

        assert!(ensure_move_allowed(DIR_UP, TILE_LADDER, TILE_SURFACE).is_ok());
        assert_eq!(gravity_target(&map, 3, 0), Ok((3, 0)));
    }

    #[test]
    fn gravity_does_not_pull_agent_off_current_ladder() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_LADDER;
        map[index_of(3, 2).unwrap()] = TILE_EMPTY;

        assert_eq!(gravity_target(&map, 3, 1), Ok((3, 1)));
    }

    #[test]
    fn stone_gravity_falls_through_empty_tiles() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_STONE;
        map[index_of(3, 2).unwrap()] = TILE_EMPTY;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;
        map[index_of(3, 4).unwrap()] = TILE_DIRT;

        let falls = settle_stones_above_open_cell(&mut map, 3, 2, None).unwrap();

        assert_eq!(
            falls,
            vec![StoneFall {
                from_x: 3,
                from_y: 1,
                to_x: 3,
                to_y: 3,
                crushed_agent: false,
            }]
        );
        assert_eq!(map[index_of(3, 1).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 3).unwrap()], TILE_STONE);
    }

    #[test]
    fn stone_gravity_crushes_agent_in_fall_path() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_STONE;
        map[index_of(3, 2).unwrap()] = TILE_EMPTY;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;
        map[index_of(3, 4).unwrap()] = TILE_DIRT;

        let falls = settle_stones_above_open_cell(&mut map, 3, 2, Some((3, 3))).unwrap();

        assert_eq!(
            falls,
            vec![StoneFall {
                from_x: 3,
                from_y: 1,
                to_x: 3,
                to_y: 3,
                crushed_agent: true,
            }]
        );
        assert_eq!(map[index_of(3, 1).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 3).unwrap()], TILE_STONE);
    }

    #[test]
    fn stone_gravity_settles_contiguous_stone_chain() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_STONE;
        map[index_of(3, 2).unwrap()] = TILE_STONE;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;
        map[index_of(3, 4).unwrap()] = TILE_EMPTY;
        map[index_of(3, 5).unwrap()] = TILE_EMPTY;
        map[index_of(3, 6).unwrap()] = TILE_DIRT;

        let falls = settle_stones_above_open_cell(&mut map, 3, 3, None).unwrap();

        assert_eq!(
            falls,
            vec![
                StoneFall {
                    from_x: 3,
                    from_y: 2,
                    to_x: 3,
                    to_y: 5,
                    crushed_agent: false,
                },
                StoneFall {
                    from_x: 3,
                    from_y: 1,
                    to_x: 3,
                    to_y: 4,
                    crushed_agent: false,
                }
            ]
        );
        assert_eq!(map[index_of(3, 1).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 2).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 4).unwrap()], TILE_STONE);
        assert_eq!(map[index_of(3, 5).unwrap()], TILE_STONE);
    }

    #[test]
    fn drilling_dirt_under_stone_crushes_agent_below_it() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_STONE;
        map[index_of(3, 2).unwrap()] = TILE_DIRT;
        map[index_of(3, 3).unwrap()] = TILE_EMPTY;
        map[index_of(3, 4).unwrap()] = TILE_DIRT;

        map[index_of(3, 2).unwrap()] = TILE_EMPTY;
        let falls = settle_stones_above_open_cell(&mut map, 3, 2, Some((3, 3))).unwrap();

        assert_eq!(
            falls,
            vec![StoneFall {
                from_x: 3,
                from_y: 1,
                to_x: 3,
                to_y: 3,
                crushed_agent: true,
            }]
        );
        assert_eq!(map[index_of(3, 1).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 3).unwrap()], TILE_STONE);
    }

    #[test]
    fn stone_gravity_stops_on_ladder_before_agent() {
        let mut map = vec![TILE_DIRT; MAP_CELLS];
        for x in 0..MAP_WIDTH {
            map[index_of(x, 0).unwrap()] = TILE_SURFACE;
        }
        map[index_of(3, 1).unwrap()] = TILE_STONE;
        map[index_of(3, 2).unwrap()] = TILE_EMPTY;
        map[index_of(3, 3).unwrap()] = TILE_LADDER;
        map[index_of(3, 4).unwrap()] = TILE_EMPTY;

        let falls = settle_stones_above_open_cell(&mut map, 3, 2, Some((3, 4))).unwrap();

        assert_eq!(
            falls,
            vec![StoneFall {
                from_x: 3,
                from_y: 1,
                to_x: 3,
                to_y: 2,
                crushed_agent: false,
            }]
        );
        assert_eq!(map[index_of(3, 1).unwrap()], TILE_EMPTY);
        assert_eq!(map[index_of(3, 2).unwrap()], TILE_STONE);
        assert_eq!(map[index_of(3, 3).unwrap()], TILE_LADDER);
    }
}
