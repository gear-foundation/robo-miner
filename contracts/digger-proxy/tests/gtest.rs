use ::digger_proxy_client::{
    DiggerProxyClient as _, DiggerProxyClientCtors as _, digger::Digger as _,
};
use ::digger_world_client::{
    DiggerWorldClient as _, DiggerWorldClientCtors as _, admin::Admin as _, world::World as _,
};
use sails_rs::{client::*, gtest::*, prelude::*};

const ADMIN_ID: u64 = 42;
const OWNER_ID: u64 = 99;
const TEST_ACCOUNT_BALANCE: u128 = 100_000_000_000_000_000;
const TEST_SEED: u64 = 777;
const SPAWN_X: u32 = 2;
const SPAWN_RESOURCE_Y: u32 = 1;
const STARTING_LADDERS: u128 = 50;

#[tokio::test]
async fn proxy_registers_and_trades_ladders_through_world_route() {
    let (env, world_code, proxy_code) = create_env();
    let world = env
        .deploy::<::digger_world_client::DiggerWorldClientProgram>(
            world_code,
            b"proxy-world-route".to_vec(),
        )
        .create(digger_world_app::default_40x64_input())
        .await
        .unwrap();

    let uploaded: sails_rs::Result<Vec<u128>, sails_rs::String> = world
        .admin()
        .upload_map(
            TEST_SEED,
            map_with_spawn_resource(digger_world_app::TILE_RESOURCE_BCRST),
        )
        .await
        .unwrap();
    assert_eq!(uploaded, Ok(vec![1, TEST_SEED as u128, 0, 0]));

    let proxy = env
        .deploy::<::digger_proxy_client::DiggerProxyClientProgram>(
            proxy_code,
            b"proxy-route".to_vec(),
        )
        .create(OWNER_ID.into(), world.id())
        .await
        .unwrap();

    let proxy_owner: sails_rs::Result<ActorId, sails_rs::String> =
        proxy.digger().owner().await.unwrap();
    assert_eq!(proxy_owner, Ok(OWNER_ID.into()));

    let proxy_world: sails_rs::Result<ActorId, sails_rs::String> =
        proxy.digger().world().await.unwrap();
    assert_eq!(proxy_world, Ok(world.id()));

    let register: sails_rs::Result<[u8; 32], sails_rs::String> = proxy
        .digger()
        .register()
        .with_actor_id(OWNER_ID.into())
        .await
        .unwrap();
    assert!(register.is_ok());
    env.run_next_block();

    let owner_of_proxy: sails_rs::Result<ActorId, sails_rs::String> =
        world.world().owner_of(proxy.id()).await.unwrap();
    assert_eq!(owner_of_proxy, Ok(OWNER_ID.into()));

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

    let drill: sails_rs::Result<[u8; 32], sails_rs::String> = proxy
        .digger()
        .drill(digger_world_app::DIR_DOWN)
        .with_actor_id(OWNER_ID.into())
        .await
        .unwrap();
    assert!(drill.is_ok());
    env.run_next_block();

    let inventory_after_drill: sails_rs::Result<Vec<u32>, sails_rs::String> =
        world.world().inventory_of(proxy.id()).await.unwrap();
    assert_eq!(inventory_after_drill, Ok(vec![0, 1, 0, 0, 0, 0]));

    let surface: sails_rs::Result<[u8; 32], sails_rs::String> = proxy
        .digger()
        .surface()
        .with_actor_id(OWNER_ID.into())
        .await
        .unwrap();
    assert!(surface.is_ok());
    env.run_next_block();

    let inventory_after_surface: sails_rs::Result<Vec<u32>, sails_rs::String> =
        world.world().inventory_of(proxy.id()).await.unwrap();
    assert_eq!(inventory_after_surface, Ok(vec![0, 0, 0, 0, 1, 0]));

    let trade: sails_rs::Result<[u8; 32], sails_rs::String> = proxy
        .digger()
        .trade_resources_for_ladders(0, 1, 0)
        .with_actor_id(OWNER_ID.into())
        .await
        .unwrap();
    assert!(trade.is_ok());
    env.run_next_block();

    let agent_after_trade: sails_rs::Result<Vec<u128>, sails_rs::String> =
        world.world().agent_of(proxy.id()).await.unwrap();
    let agent_after_trade = agent_after_trade.expect("proxy agent should remain registered");
    assert_eq!(
        agent_after_trade[4],
        STARTING_LADDERS + digger_world_app::DEFAULT_LADDER_BCRST_LADDER_AMOUNT as u128
    );
    assert_eq!(agent_after_trade[9], 0);

    let proxy_status: sails_rs::Result<Vec<u128>, sails_rs::String> =
        proxy.digger().status().await.unwrap();
    assert_eq!(proxy_status, Ok(vec![4, 8]));
}

fn create_env() -> (GtestEnv, CodeId, CodeId) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(ADMIN_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(OWNER_ID, TEST_ACCOUNT_BALANCE);

    let world_code = system.submit_code(::digger_world::WASM_BINARY);
    let proxy_code = system.submit_code(::digger_proxy::WASM_BINARY);
    let env = GtestEnv::new(system, ADMIN_ID.into());

    (env, world_code, proxy_code)
}

fn map_with_spawn_resource(resource_tile: u8) -> Vec<u32> {
    let mut map = vec![digger_world_app::TILE_DIRT as u32; digger_world_app::MAP_CELLS];
    for x in 0..digger_world_app::MAP_WIDTH {
        map[map_index(x, 0)] = digger_world_app::TILE_SURFACE as u32;
    }
    map[map_index(SPAWN_X, SPAWN_RESOURCE_Y)] = resource_tile as u32;

    place_resources(&mut map, digger_world_app::TILE_RESOURCE_SCRST, 77);
    place_resources(&mut map, digger_world_app::TILE_RESOURCE_BCRST, 18);
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
    ((y * digger_world_app::MAP_WIDTH) + x) as usize
}
