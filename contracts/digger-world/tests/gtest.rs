use ::digger_world_client::{
    DiggerWorldClient as _, DiggerWorldClientCtors as _, admin::Admin as _, world::World as _,
};
use sails_rs::futures::StreamExt;
use sails_rs::{client::*, gtest::*, prelude::*};

const ADMIN_ID: u64 = 42;
const PLAYER_ID: u64 = 99;
const LATE_PLAYER_ID: u64 = 100;
const PARTICIPANT_IDS: [u64; 1] = [PLAYER_ID];
const TEST_ACCOUNT_BALANCE: u128 = 100_000_000_000_000_000;
const TEST_SEED: u64 = 777;
const CHEST_X: u32 = 2;
const CHEST_Y: u32 = 1;
const STARTING_HP: u128 = 1;
const STARTING_LADDERS: u32 = 50;

#[tokio::test]
async fn drilling_chest_emits_event_and_applies_outcome() {
    let (env, code_id) = create_env();
    let world = deploy_world_program(&env, code_id, "world-chest-drill").await;

    let uploaded: sails_rs::Result<Vec<u128>, sails_rs::String> = world
        .admin()
        .upload_map(TEST_SEED, map_with_spawn_chest())
        .await
        .unwrap();
    assert_eq!(uploaded, Ok(vec![1, TEST_SEED as u128, 0, 0]));

    let mut world_service = world.world();
    for id in PARTICIPANT_IDS {
        let registered: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
            .register(id.into())
            .with_actor_id(id.into())
            .await
            .unwrap();
        assert!(registered.is_ok());
    }

    let started: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.admin().start_session().await.unwrap();
    assert_eq!(
        started,
        Ok(vec![
            1,
            TEST_SEED as u128,
            digger_world_app::SESSION_ACTIVE as u128,
            0
        ])
    );

    let mut world_service = world.world();
    let mut events = world_service.listen().await.unwrap();
    let drilled: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .drill(digger_world_app::DIR_DOWN)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent = drilled.expect("drilling a chest should succeed");

    assert_eq!(
        events.next().await.unwrap(),
        (
            world.id(),
            ::digger_world_client::world::events::WorldEvents::TileDrilled(
                1,
                actor_bytes(PLAYER_ID),
                CHEST_X,
                CHEST_Y,
                digger_world_app::TILE_CHEST as u32,
                digger_world_app::TILE_EMPTY as u32,
            )
        )
    );

    let chest_event = events.next().await.unwrap();
    let outcome = match chest_event {
        (
            program,
            ::digger_world_client::world::events::WorldEvents::ChestOpened(
                session_id,
                actor,
                x,
                y,
                outcome,
                ladders_remaining,
            ),
        ) => {
            assert_eq!(program, world.id());
            assert_eq!(session_id, 1);
            assert_eq!(actor, actor_bytes(PLAYER_ID));
            assert_eq!(x, CHEST_X);
            assert_eq!(y, CHEST_Y);
            (outcome, ladders_remaining)
        }
        event => std::panic!("expected ChestOpened event, got {event:?}"),
    };

    assert_eq!(agent[1], CHEST_X as u128);
    assert_eq!(agent[2], 0);
    let tile_after: sails_rs::Result<u32, sails_rs::String> =
        world.world().tile_at(CHEST_X, CHEST_Y).await.unwrap();
    assert_eq!(tile_after, Ok(digger_world_app::TILE_EMPTY as u32));

    match outcome {
        (digger_world_app::CHEST_OUTCOME_DYNAMITE, ladders_remaining) => {
            assert_eq!(ladders_remaining, STARTING_LADDERS);
            assert_eq!(agent[0], digger_world_app::AGENT_DEAD as u128);
            assert_eq!(agent[3], 0);
            assert_eq!(
                events.next().await.unwrap(),
                (
                    world.id(),
                    ::digger_world_client::world::events::WorldEvents::AgentDied(
                        1,
                        actor_bytes(PLAYER_ID),
                        CHEST_X,
                        CHEST_Y,
                        digger_world_app::TILE_CHEST as u32,
                    )
                )
            );
        }
        (digger_world_app::CHEST_OUTCOME_LADDERS, ladders_remaining) => {
            let expected_ladders = STARTING_LADDERS + digger_world_app::CHEST_LADDER_REWARD;
            assert_eq!(ladders_remaining, expected_ladders);
            assert_eq!(agent[0], digger_world_app::AGENT_ACTIVE as u128);
            assert_eq!(agent[3], STARTING_HP);
            assert_eq!(agent[4], expected_ladders as u128);
        }
        (unexpected, _) => std::panic!("unexpected chest outcome {unexpected}"),
    }
}

#[tokio::test]
async fn active_session_still_accepts_late_registration() {
    let (env, code_id) = create_env();
    let world = deploy_world_program(&env, code_id, "world-late-registration").await;

    let uploaded: sails_rs::Result<Vec<u128>, sails_rs::String> = world
        .admin()
        .upload_map(
            TEST_SEED,
            map_with_spawn_resource(digger_world_app::TILE_RESOURCE_BCRST),
        )
        .await
        .unwrap();
    assert_eq!(uploaded, Ok(vec![1, TEST_SEED as u128, 0, 0]));

    let mut world_service = world.world();
    let first_registered: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .register(PLAYER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert!(first_registered.is_ok());

    let started: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.admin().start_session().await.unwrap();
    assert_eq!(
        started,
        Ok(vec![
            1,
            TEST_SEED as u128,
            digger_world_app::SESSION_ACTIVE as u128,
            0
        ])
    );

    let late_registered: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .register(LATE_PLAYER_ID.into())
        .with_actor_id(LATE_PLAYER_ID.into())
        .await
        .unwrap();
    let late_agent = late_registered.expect("active session should accept late registration");
    assert_eq!(late_agent[0], digger_world_app::AGENT_ACTIVE as u128);
    assert_eq!(late_agent[2], 0);

    let session: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.world().session().await.unwrap();
    assert_eq!(
        session,
        Ok(vec![
            1,
            TEST_SEED as u128,
            digger_world_app::SESSION_ACTIVE as u128,
            0
        ])
    );

    let agents: sails_rs::Result<Vec<ActorId>, sails_rs::String> =
        world.world().agents().await.unwrap();
    let agents = agents.expect("agents query should succeed");
    assert_eq!(agents.len(), 2);
    assert!(agents.contains(&ActorId::from(PLAYER_ID)));
    assert!(agents.contains(&ActorId::from(LATE_PLAYER_ID)));
}

#[tokio::test]
async fn surfaced_agent_can_trade_banked_resources_for_ladders() {
    let (env, code_id) = create_env();
    let world = deploy_world_program(&env, code_id, "world-resource-trade").await;

    let uploaded: sails_rs::Result<Vec<u128>, sails_rs::String> = world
        .admin()
        .upload_map(
            TEST_SEED,
            map_with_spawn_resource(digger_world_app::TILE_RESOURCE_BCRST),
        )
        .await
        .unwrap();
    assert_eq!(uploaded, Ok(vec![1, TEST_SEED as u128, 0, 0]));

    let mut world_service = world.world();
    let registered: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .register(PLAYER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert!(registered.is_ok());

    let started: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.admin().start_session().await.unwrap();
    assert_eq!(
        started,
        Ok(vec![
            1,
            TEST_SEED as u128,
            digger_world_app::SESSION_ACTIVE as u128,
            0
        ])
    );

    let drilled: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .drill(digger_world_app::DIR_DOWN)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent_after_drill = drilled.expect("drilling BCRST should succeed");
    assert_eq!(agent_after_drill[6], 1);

    let surfaced: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .surface()
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent_after_surface = surfaced.expect("surface should bank carried resources");
    assert_eq!(agent_after_surface[6], 0);
    assert_eq!(agent_after_surface[9], 1);

    let mut events = world_service.listen().await.unwrap();
    let traded: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .trade_resources_for_ladders(0, 1, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent_after_trade = traded.expect("resource trade should succeed");
    assert_eq!(agent_after_trade[4], (STARTING_LADDERS + 1) as u128);
    assert_eq!(agent_after_trade[9], 0);

    assert_eq!(
        events.next().await.unwrap(),
        (
            world.id(),
            ::digger_world_client::world::events::WorldEvents::ResourcesTradedForLadders(
                1,
                actor_bytes(PLAYER_ID),
                0,
                1,
                0,
                1,
                STARTING_LADDERS + 1,
            )
        )
    );
}

#[tokio::test]
async fn agent_cannot_climb_from_gap_into_ladder_without_current_ladder() {
    let (env, code_id) = create_env();
    let world = deploy_world_program(&env, code_id, "world-ladder-gap").await;

    let uploaded: sails_rs::Result<Vec<u128>, sails_rs::String> = world
        .admin()
        .upload_map(TEST_SEED, map_with_ladder_gap_above_spawn())
        .await
        .unwrap();
    assert_eq!(uploaded, Ok(vec![1, TEST_SEED as u128, 0, 0]));

    let mut world_service = world.world();
    let registered: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .register(PLAYER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert!(registered.is_ok());

    let started: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.admin().start_session().await.unwrap();
    assert_eq!(
        started,
        Ok(vec![
            1,
            TEST_SEED as u128,
            digger_world_app::SESSION_ACTIVE as u128,
            0
        ])
    );

    let down_to_ladder: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .move_agent(digger_world_app::DIR_DOWN)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent = down_to_ladder.expect("agent should step down onto first ladder");
    assert_eq!(agent[1], CHEST_X as u128);
    assert_eq!(agent[2], 1);

    let down_to_gap: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .move_agent(digger_world_app::DIR_DOWN)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent = down_to_gap.expect("agent should stand in the empty gap below the ladder");
    assert_eq!(agent[1], CHEST_X as u128);
    assert_eq!(agent[2], 2);

    let skipped_ladder: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .move_agent(digger_world_app::DIR_UP)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(
        skipped_ladder,
        Err("upward movement requires a ladder".into())
    );
    let agent_after_rejected_move: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world_service.agent_of(PLAYER_ID.into()).await.unwrap();
    let agent =
        agent_after_rejected_move.expect("agent should remain registered after rejected climb");
    assert_eq!(agent[1], CHEST_X as u128);
    assert_eq!(agent[2], 2);

    let placed_current: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .place_ladder(digger_world_app::DIR_CURRENT)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent = placed_current.expect("agent should fill the current gap with a ladder");
    assert_eq!(agent[4], (STARTING_LADDERS - 1) as u128);

    let climbed_after_filling_gap: sails_rs::Result<Vec<u128>, sails_rs::String> = world_service
        .move_agent(digger_world_app::DIR_UP)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let agent =
        climbed_after_filling_gap.expect("agent should climb once the current cell is a ladder");
    assert_eq!(agent[1], CHEST_X as u128);
    assert_eq!(agent[2], 1);
}

async fn deploy_world_program(
    env: &GtestEnv,
    code_id: CodeId,
    salt: &str,
) -> sails_rs::client::Actor<::digger_world_client::DiggerWorldClientProgram, GtestEnv> {
    env.deploy::<::digger_world_client::DiggerWorldClientProgram>(code_id, salt.as_bytes().to_vec())
        .create()
        .await
        .unwrap()
}

fn create_env() -> (GtestEnv, CodeId) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(ADMIN_ID, TEST_ACCOUNT_BALANCE);
    for id in PARTICIPANT_IDS {
        system.mint_to(id, TEST_ACCOUNT_BALANCE);
    }
    system.mint_to(LATE_PLAYER_ID, TEST_ACCOUNT_BALANCE);

    let code_id = system.submit_code(::digger_world::WASM_BINARY);
    let env = GtestEnv::new(system, ADMIN_ID.into());
    (env, code_id)
}

fn map_with_spawn_chest() -> Vec<u32> {
    let mut map = vec![digger_world_app::TILE_DIRT as u32; digger_world_app::MAP_CELLS];
    for x in 0..digger_world_app::MAP_WIDTH {
        map[map_index(x, 0)] = digger_world_app::TILE_SURFACE as u32;
    }
    map[map_index(CHEST_X, CHEST_Y)] = digger_world_app::TILE_CHEST as u32;

    place_resources(&mut map, digger_world_app::TILE_RESOURCE_SCRST, 77);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_BCRST, 19);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_HCRST, 4);
    map
}

fn map_with_spawn_resource(resource_tile: u8) -> Vec<u32> {
    let mut map = vec![digger_world_app::TILE_DIRT as u32; digger_world_app::MAP_CELLS];
    for x in 0..digger_world_app::MAP_WIDTH {
        map[map_index(x, 0)] = digger_world_app::TILE_SURFACE as u32;
    }
    map[map_index(CHEST_X, CHEST_Y)] = resource_tile as u32;

    place_resources(&mut map, digger_world_app::TILE_RESOURCE_SCRST, 77);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_BCRST, 18);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_HCRST, 4);
    map
}

fn map_with_ladder_gap_above_spawn() -> Vec<u32> {
    let mut map = vec![digger_world_app::TILE_DIRT as u32; digger_world_app::MAP_CELLS];
    for x in 0..digger_world_app::MAP_WIDTH {
        map[map_index(x, 0)] = digger_world_app::TILE_SURFACE as u32;
    }
    map[map_index(CHEST_X, 1)] = digger_world_app::TILE_LADDER as u32;
    map[map_index(CHEST_X, 2)] = digger_world_app::TILE_EMPTY as u32;

    place_resources(&mut map, digger_world_app::TILE_RESOURCE_SCRST, 77);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_BCRST, 19);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_HCRST, 4);
    map
}

fn place_resources(map: &mut [u32], tile: u8, count: u32) {
    let mut placed = 0;
    for y in (1..digger_world_app::MAP_HEIGHT).rev() {
        for x in 0..digger_world_app::MAP_WIDTH {
            let index = map_index(x, y);
            if map[index] == digger_world_app::TILE_DIRT as u32 {
                map[index] = tile as u32;
                placed += 1;
                if placed == count {
                    return;
                }
            }
        }
    }
    std::panic!("test map has no room for resources");
}

fn map_index(x: u32, y: u32) -> usize {
    (y * digger_world_app::MAP_WIDTH + x) as usize
}

fn actor_bytes(id: u64) -> [u8; 32] {
    ActorId::from(id).into()
}
