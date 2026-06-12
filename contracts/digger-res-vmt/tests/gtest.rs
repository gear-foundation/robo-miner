use ::digger_redeem_client::DiggerRedeemClientCtors as _;
use ::digger_res_vmt_client::{
    DiggerResVmtClient as _, DiggerResVmtClientCtors as _, admin::Admin as _, vmt::Vmt as _,
};
use sails_rs::futures::StreamExt;
use sails_rs::{client::*, gtest::*, prelude::*};

const ADMIN_ID: u64 = 42;
const MINTER_ID: u64 = 77;
const PLAYER_ID: u64 = 99;
const OTHER_ID: u64 = 123;
const SCRST_ID: u128 = 0;
const BCRST_ID: u128 = 1;
const HCRST_ID: u128 = 2;

#[tokio::test]
async fn minter_can_mint_and_holder_can_transfer_vmt_resources() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-transfer").await;
    let mut vmt = res.vmt();
    let mut vmt_events = vmt.listen().await.unwrap();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 10, 2, 1)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));
    assert_eq!(
        vmt_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::vmt::events::VmtEvents::Minted(
                actor_bytes(PLAYER_ID),
                10,
                2,
                1
            )
        )
    );

    let transfer_result: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 4)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(transfer_result, Ok(()));
    assert_eq!(
        vmt_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::vmt::events::VmtEvents::Transfer(
                actor_bytes(PLAYER_ID),
                actor_bytes(OTHER_ID),
                SCRST_ID,
                4
            )
        )
    );

    let player_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), SCRST_ID).await.unwrap();
    let other_bcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(OTHER_ID.into(), BCRST_ID).await.unwrap();
    let other_hcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(OTHER_ID.into(), HCRST_ID).await.unwrap();

    assert_eq!(player_scrst, Ok(6));
    assert_eq!(other_bcrst, Ok(0));
    assert_eq!(other_hcrst, Ok(0));

    let transfer_bcrst: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), BCRST_ID, 1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(transfer_bcrst, Ok(()));
    assert_eq!(
        vmt_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::vmt::events::VmtEvents::Transfer(
                actor_bytes(PLAYER_ID),
                actor_bytes(OTHER_ID),
                BCRST_ID,
                1
            )
        )
    );
    let other_bcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(OTHER_ID.into(), BCRST_ID).await.unwrap();
    assert_eq!(other_bcrst, Ok(1));
}

#[tokio::test]
async fn exposes_vmt_metadata_token_ids_and_admin_configuration() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, OTHER_ID.into(), "res-metadata").await;
    let vmt = res.vmt();
    let admin = res.admin();

    let name: sails_rs::Result<sails_rs::String, sails_rs::String> = vmt.name().await.unwrap();
    let symbol: sails_rs::Result<sails_rs::String, sails_rs::String> = vmt.symbol().await.unwrap();
    let decimals: sails_rs::Result<u128, sails_rs::String> = vmt.decimals().await.unwrap();
    let scrst_id: sails_rs::Result<u128, sails_rs::String> = vmt.scrst_token_id().await.unwrap();
    let bcrst_id: sails_rs::Result<u128, sails_rs::String> = vmt.bcrst_token_id().await.unwrap();
    let hcrst_id: sails_rs::Result<u128, sails_rs::String> = vmt.hcrst_token_id().await.unwrap();
    let total_unknown: sails_rs::Result<u128, sails_rs::String> =
        vmt.total_supply_of(999).await.unwrap();
    let admins: sails_rs::Result<Vec<ActorId>, sails_rs::String> = admin.admins().await.unwrap();
    let minters: sails_rs::Result<Vec<ActorId>, sails_rs::String> = admin.minters().await.unwrap();
    let is_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.is_admin(ADMIN_ID.into()).await.unwrap();
    let is_minter: sails_rs::Result<bool, sails_rs::String> =
        admin.is_minter(MINTER_ID.into()).await.unwrap();
    let redeem_contract: sails_rs::Result<ActorId, sails_rs::String> =
        admin.redeem_contract().await.unwrap();
    let paused: sails_rs::Result<bool, sails_rs::String> = admin.is_paused().await.unwrap();

    assert_eq!(name, Ok("Digger Resources".into()));
    assert_eq!(symbol, Ok("DRES".into()));
    assert_eq!(decimals, Ok(0));
    assert_eq!(scrst_id, Ok(SCRST_ID));
    assert_eq!(bcrst_id, Ok(BCRST_ID));
    assert_eq!(hcrst_id, Ok(HCRST_ID));
    assert_eq!(total_unknown, Ok(0));
    assert_eq!(admins, Ok(vec![ADMIN_ID.into()]));
    assert_eq!(minters, Ok(vec![MINTER_ID.into()]));
    assert_eq!(is_admin, Ok(true));
    assert_eq!(is_minter, Ok(true));
    assert_eq!(redeem_contract, Ok(OTHER_ID.into()));
    assert_eq!(paused, Ok(false));
}

#[tokio::test]
async fn res_vmt_supports_multiple_admins_and_minters() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-multi-roles").await;
    let mut admin = res.admin();
    let mut vmt = res.vmt();

    let add_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.add_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_admin, Ok(true));

    let add_admin_again: sails_rs::Result<bool, sails_rs::String> =
        admin.add_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_admin_again, Ok(false));

    let add_minter: sails_rs::Result<bool, sails_rs::String> =
        admin.add_minter(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_minter, Ok(true));

    let mint_by_new_minter: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_by_new_minter, Ok(()));

    let pause_by_new_admin: sails_rs::Result<(), sails_rs::String> =
        admin.pause().with_actor_id(OTHER_ID.into()).await.unwrap();
    assert_eq!(pause_by_new_admin, Ok(()));

    let unpause_by_new_admin: sails_rs::Result<(), sails_rs::String> = admin
        .unpause()
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(unpause_by_new_admin, Ok(()));

    let remove_minter: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_minter(OTHER_ID.into()).await.unwrap();
    assert_eq!(remove_minter, Ok(true));

    let mint_after_remove: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_after_remove, Err("caller is not minter".into()));

    let remove_original_minter: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_minter(MINTER_ID.into()).await.unwrap();
    assert_eq!(
        remove_original_minter,
        Err("cannot remove the last minter".into())
    );

    let remove_new_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(remove_new_admin, Ok(true));

    let pause_after_remove: sails_rs::Result<(), sails_rs::String> =
        admin.pause().with_actor_id(OTHER_ID.into()).await.unwrap();
    assert_eq!(pause_after_remove, Err("caller is not admin".into()));

    let remove_last_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_admin(ADMIN_ID.into()).await.unwrap();
    assert_eq!(
        remove_last_admin,
        Err("cannot remove the last admin".into())
    );
}

#[tokio::test]
async fn non_minter_cannot_mint_vmt_resources() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-auth").await;
    let mut vmt = res.vmt();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Err("caller is not minter".into()));
}

#[tokio::test]
async fn transfers_reject_invalid_amounts_and_insufficient_balance() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-transfer-guards").await;
    let mut vmt = res.vmt();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 3, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let zero_transfer: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let self_transfer: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), PLAYER_ID.into(), SCRST_ID, 1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let insufficient_transfer: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 4)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let unauthorized_operator: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 1)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    let zero_recipient: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), ActorId::zero(), SCRST_ID, 1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let mismatched_batch: sails_rs::Result<(), sails_rs::String> = vmt
        .batch_transfer_from(
            PLAYER_ID.into(),
            OTHER_ID.into(),
            vec![SCRST_ID, BCRST_ID],
            vec![1],
        )
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let player_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), SCRST_ID).await.unwrap();
    let other_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(OTHER_ID.into(), SCRST_ID).await.unwrap();

    assert_eq!(
        zero_transfer,
        Err("at least one VMT amount must be greater than zero".into())
    );
    assert_eq!(self_transfer, Err("cannot transfer to self".into()));
    assert_eq!(
        insufficient_transfer,
        Err("insufficient VMT balance".into())
    );
    assert_eq!(
        unauthorized_operator,
        Err("caller is not owner or approved".into())
    );
    assert_eq!(
        zero_recipient,
        Err("recipient cannot be zero address".into())
    );
    assert_eq!(
        mismatched_batch,
        Err("token ids and amounts length mismatch".into())
    );
    assert_eq!(player_scrst, Ok(3));
    assert_eq!(other_scrst, Ok(0));
}

#[tokio::test]
async fn approved_operator_can_transfer_vmt_resources() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-approval").await;
    let mut vmt = res.vmt();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 5, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let approve_result: sails_rs::Result<bool, sails_rs::String> = vmt
        .approve(OTHER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(approve_result, Ok(true));
    let approved: sails_rs::Result<bool, sails_rs::String> = vmt
        .is_approved(PLAYER_ID.into(), OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(approved, Ok(true));

    let transfer_result: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 2)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(transfer_result, Ok(()));

    let operator_balance: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(OTHER_ID.into(), SCRST_ID).await.unwrap();
    assert_eq!(operator_balance, Ok(2));
}

#[tokio::test]
async fn approval_rejects_zero_operator_and_self_approval_is_noop() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-approval-guards").await;
    let mut vmt = res.vmt();

    let zero_operator: sails_rs::Result<bool, sails_rs::String> = vmt
        .approve(ActorId::zero())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let self_approval: sails_rs::Result<bool, sails_rs::String> = vmt
        .approve(PLAYER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let approved_self: sails_rs::Result<bool, sails_rs::String> = vmt
        .is_approved(PLAYER_ID.into(), PLAYER_ID.into())
        .await
        .unwrap();

    assert_eq!(zero_operator, Err("operator cannot be zero address".into()));
    assert_eq!(self_approval, Ok(false));
    assert_eq!(approved_self, Ok(false));
}

#[tokio::test]
async fn non_admin_cannot_update_res_configuration() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-admin-guards").await;
    let mut admin = res.admin();

    let set_redeem: sails_rs::Result<(), sails_rs::String> = admin
        .set_redeem_contract(OTHER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let add_minter: sails_rs::Result<bool, sails_rs::String> = admin
        .add_minter(OTHER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let pause: sails_rs::Result<(), sails_rs::String> =
        admin.pause().with_actor_id(PLAYER_ID.into()).await.unwrap();
    let unpause: sails_rs::Result<(), sails_rs::String> = admin
        .unpause()
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();

    assert_eq!(set_redeem, Err("caller is not admin".into()));
    assert_eq!(add_minter, Err("caller is not admin".into()));
    assert_eq!(pause, Err("caller is not admin".into()));
    assert_eq!(unpause, Err("caller is not admin".into()));
}

#[tokio::test]
async fn pause_blocks_transfers_until_unpaused() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-pause-transfer").await;
    let mut admin = res.admin();
    let mut vmt = res.vmt();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 2, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let pause_result: sails_rs::Result<(), sails_rs::String> = admin.pause().await.unwrap();
    assert_eq!(pause_result, Ok(()));
    let pause_again: sails_rs::Result<(), sails_rs::String> = admin.pause().await.unwrap();
    assert_eq!(pause_again, Err("RES VMT is already paused".into()));
    let transfer_paused: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(transfer_paused, Err("RES VMT is paused".into()));

    let unpause_result: sails_rs::Result<(), sails_rs::String> = admin.unpause().await.unwrap();
    assert_eq!(unpause_result, Ok(()));
    let unpause_again: sails_rs::Result<(), sails_rs::String> = admin.unpause().await.unwrap();
    assert_eq!(unpause_again, Err("RES VMT is not paused".into()));
    let transfer_after_unpause: sails_rs::Result<(), sails_rs::String> = vmt
        .transfer_from(PLAYER_ID.into(), OTHER_ID.into(), SCRST_ID, 1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(transfer_after_unpause, Ok(()));
}

#[tokio::test]
async fn mint_rejects_zero_recipient_and_empty_amounts() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-mint-guards").await;
    let mut vmt = res.vmt();

    let zero_recipient: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(ActorId::zero(), 1, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    let empty_amounts: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 0, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();

    assert_eq!(
        zero_recipient,
        Err("recipient cannot be zero address".into())
    );
    assert_eq!(
        empty_amounts,
        Err("at least one VMT amount must be greater than zero".into())
    );
}

#[tokio::test]
async fn non_redeem_contract_cannot_burn_player_res() {
    let (env, redeem_code_id, res_code_id) = create_env();
    let redeem = deploy_redeem_program(&env, redeem_code_id, "reserve-auth").await;
    let res = deploy_res_program(&env, res_code_id, redeem.id(), "res-insufficient").await;
    let mut vmt = res.vmt();

    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let burn_result: sails_rs::Result<(), sails_rs::String> = vmt
        .burn_for_redeem(1, PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(burn_result, Err("caller is not redeem contract".into()));
}

#[tokio::test]
async fn admin_can_pause_res_token_and_update_configuration() {
    let (env, _, res_code_id) = create_env();
    let res = deploy_res_program(&env, res_code_id, ActorId::zero(), "res-admin").await;
    let mut admin = res.admin();
    let mut vmt = res.vmt();
    let mut admin_events = admin.listen().await.unwrap();

    let new_redeem = ActorId::new([7; 32]);
    let set_redeem: sails_rs::Result<(), sails_rs::String> =
        admin.set_redeem_contract(new_redeem).await.unwrap();
    assert_eq!(set_redeem, Ok(()));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::admin::events::AdminEvents::RedeemContractUpdated(
                actor_bytes(ADMIN_ID),
                new_redeem.into()
            )
        )
    );

    let add_minter: sails_rs::Result<bool, sails_rs::String> =
        admin.add_minter(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_minter, Ok(true));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::admin::events::AdminEvents::MinterAdded(actor_bytes(OTHER_ID))
        )
    );

    let pause_result: sails_rs::Result<(), sails_rs::String> = admin.pause().await.unwrap();
    assert_eq!(pause_result, Ok(()));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            res.id(),
            ::digger_res_vmt_client::admin::events::AdminEvents::Paused(actor_bytes(ADMIN_ID))
        )
    );

    let mint_paused: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), 1, 0, 0)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_paused, Err("RES VMT is paused".into()));
}

async fn deploy_redeem_program(
    env: &GtestEnv,
    code_id: CodeId,
    salt: &str,
) -> sails_rs::client::Actor<::digger_redeem_client::DiggerRedeemClientProgram, GtestEnv> {
    env.deploy::<::digger_redeem_client::DiggerRedeemClientProgram>(
        code_id,
        salt.as_bytes().to_vec(),
    )
    .create(ActorId::zero(), 1_000_000_000_000, 66, 330, 1650)
    .await
    .unwrap()
}

async fn deploy_res_program(
    env: &GtestEnv,
    code_id: CodeId,
    redeem_contract: ActorId,
    salt: &str,
) -> sails_rs::client::Actor<::digger_res_vmt_client::DiggerResVmtClientProgram, GtestEnv> {
    env.deploy::<::digger_res_vmt_client::DiggerResVmtClientProgram>(
        code_id,
        salt.as_bytes().to_vec(),
    )
    .create(redeem_contract, MINTER_ID.into())
    .await
    .unwrap()
}

fn create_env() -> (GtestEnv, CodeId, CodeId) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(ADMIN_ID, 1_000_000_000_000_000);
    system.mint_to(MINTER_ID, 1_000_000_000_000_000);
    system.mint_to(PLAYER_ID, 1_000_000_000_000_000);
    system.mint_to(OTHER_ID, 1_000_000_000_000_000);

    let redeem_code_id = system.submit_code(::digger_redeem::WASM_BINARY);
    let res_code_id = system.submit_code(::digger_res_vmt::WASM_BINARY);
    let env = GtestEnv::new(system, ADMIN_ID.into());
    (env, redeem_code_id, res_code_id)
}

fn actor_bytes(id: u64) -> [u8; 32] {
    ActorId::from(id).into()
}
