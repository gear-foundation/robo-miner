use ::digger_redeem_client::{
    DiggerRedeemClient as _, DiggerRedeemClientCtors as _, admin::Admin as _, redeem::Redeem as _,
};
use ::digger_res_vmt_client::{
    DiggerResVmtClient as _, DiggerResVmtClientCtors as _, vmt::Vmt as _,
};
use sails_rs::futures::StreamExt;
use sails_rs::{client::*, gtest::*, prelude::*};

const ADMIN_ID: u64 = 42;
const MINTER_ID: u64 = 77;
const PLAYER_ID: u64 = 99;
const OTHER_ID: u64 = 123;

const VARA_UNIT: u128 = 1_000_000_000_000;
const RESERVE_VALUE: u128 = 10_000 * VARA_UNIT;
const SCRST_RATE: u128 = 66;
const BCRST_RATE: u128 = 330;
const HCRST_RATE: u128 = 1650;
const SCRST: u128 = 2;
const BCRST: u128 = 3;
const HCRST: u128 = 1;
const EXPECTED_PAYOUT: u128 = (2 * 66 + 3 * 330 + 1650) * VARA_UNIT;
const SCRST_ID: u128 = 0;
const BCRST_ID: u128 = 1;
const HCRST_ID: u128 = 2;
const TEST_ACCOUNT_BALANCE: u128 = 100_000 * VARA_UNIT;

#[tokio::test]
async fn redeem_burns_res_in_vmt_before_paying_vara() {
    let (env, redeem, res) = deploy_pair("redeem-flow").await;
    fund_reserve_and_mint_player_res(&redeem, &res, SCRST, BCRST, HCRST).await;

    let mut redeem_service = redeem.redeem();
    let mut redeem_events = redeem_service.listen().await.unwrap();
    let payout: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, BCRST, HCRST)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(payout, Ok(EXPECTED_PAYOUT));
    assert_eq!(
        redeem_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::redeem::events::RedeemEvents::RedeemRequested(
                1,
                actor_bytes(PLAYER_ID),
                SCRST,
                BCRST,
                HCRST,
                EXPECTED_PAYOUT
            )
        )
    );
    assert_eq!(
        redeem_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::redeem::events::RedeemEvents::Redeemed(
                actor_bytes(PLAYER_ID),
                SCRST,
                BCRST,
                HCRST,
                EXPECTED_PAYOUT
            )
        )
    );

    let vmt = res.vmt();
    let player_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), SCRST_ID).await.unwrap();
    let player_bcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), BCRST_ID).await.unwrap();
    let player_hcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), HCRST_ID).await.unwrap();
    let total_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.total_supply_of(SCRST_ID).await.unwrap();
    let total_bcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.total_supply_of(BCRST_ID).await.unwrap();
    let total_hcrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.total_supply_of(HCRST_ID).await.unwrap();
    let total_paid: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.total_paid().await.unwrap();
    let total_redeemed_scrst: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.total_redeemed_scrst().await.unwrap();
    let total_redeemed_bcrst: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.total_redeemed_bcrst().await.unwrap();
    let total_redeemed_hcrst: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.total_redeemed_hcrst().await.unwrap();
    let reserve_after_payout: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.reserve_balance().await.unwrap();
    let locked_after_payout: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.locked_balance().await.unwrap();

    assert_eq!(player_scrst, Ok(0));
    assert_eq!(player_bcrst, Ok(0));
    assert_eq!(player_hcrst, Ok(0));
    assert_eq!(total_scrst, Ok(0));
    assert_eq!(total_bcrst, Ok(0));
    assert_eq!(total_hcrst, Ok(0));
    assert_eq!(total_paid, Ok(EXPECTED_PAYOUT));
    assert_eq!(total_redeemed_scrst, Ok(SCRST));
    assert_eq!(total_redeemed_bcrst, Ok(BCRST));
    assert_eq!(total_redeemed_hcrst, Ok(HCRST));
    assert_eq!(reserve_after_payout, Ok(RESERVE_VALUE - EXPECTED_PAYOUT));
    assert_eq!(locked_after_payout, Ok(0));

    drop(env);
}

#[tokio::test]
async fn standalone_redeem_initializes_reserve_config_and_rates() {
    let (env, redeem_code_id, _) = create_env();
    let redeem =
        deploy_redeem_program(&env, redeem_code_id, OTHER_ID.into(), "redeem-standalone").await;
    let redeem_service = redeem.redeem();
    let admin = redeem.admin();

    let admins: sails_rs::Result<Vec<ActorId>, sails_rs::String> = admin.admins().await.unwrap();
    let is_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.is_admin(ADMIN_ID.into()).await.unwrap();
    let res_contract: sails_rs::Result<ActorId, sails_rs::String> =
        admin.res_contract().await.unwrap();
    let scrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.scrst_rate().await.unwrap();
    let bcrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.bcrst_rate().await.unwrap();
    let hcrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.hcrst_rate().await.unwrap();
    let vara_unit: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.vara_unit().await.unwrap();
    let reserve_balance: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.reserve_balance().await.unwrap();

    assert_eq!(admins, Ok(vec![ADMIN_ID.into()]));
    assert_eq!(is_admin, Ok(true));
    assert_eq!(res_contract, Ok(OTHER_ID.into()));
    assert_eq!(scrst_rate, Ok(SCRST_RATE));
    assert_eq!(bcrst_rate, Ok(BCRST_RATE));
    assert_eq!(hcrst_rate, Ok(HCRST_RATE));
    assert_eq!(vara_unit, Ok(VARA_UNIT));
    assert_eq!(reserve_balance, Ok(0));
}

#[tokio::test]
async fn redeem_supports_multiple_admins() {
    let (env, redeem_code_id, _) = create_env();
    let redeem =
        deploy_redeem_program(&env, redeem_code_id, OTHER_ID.into(), "redeem-multi-admin").await;
    let mut admin = redeem.admin();

    let add_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.add_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_admin, Ok(true));

    let add_admin_again: sails_rs::Result<bool, sails_rs::String> =
        admin.add_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(add_admin_again, Ok(false));

    let set_rates_by_new_admin: sails_rs::Result<(), sails_rs::String> = admin
        .set_rates(1, 2, 3)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(set_rates_by_new_admin, Ok(()));

    let remove_new_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_admin(OTHER_ID.into()).await.unwrap();
    assert_eq!(remove_new_admin, Ok(true));

    let set_rates_after_remove: sails_rs::Result<(), sails_rs::String> = admin
        .set_rates(3, 2, 1)
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(set_rates_after_remove, Err("caller is not admin".into()));

    let remove_last_admin: sails_rs::Result<bool, sails_rs::String> =
        admin.remove_admin(ADMIN_ID.into()).await.unwrap();
    assert_eq!(
        remove_last_admin,
        Err("cannot remove the last admin".into())
    );
}

#[tokio::test]
async fn standalone_redeem_rejects_unauthorized_admin_and_res_callbacks() {
    let (env, redeem_code_id, _) = create_env();
    let redeem =
        deploy_redeem_program(&env, redeem_code_id, OTHER_ID.into(), "redeem-guards").await;
    let mut redeem_service = redeem.redeem();
    let mut admin = redeem.admin();

    let set_res_contract: sails_rs::Result<(), sails_rs::String> = admin
        .set_res_contract(PLAYER_ID.into())
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
    let set_rates: sails_rs::Result<(), sails_rs::String> = admin
        .set_rates(1, 2, 3)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let add_admin: sails_rs::Result<bool, sails_rs::String> = admin
        .add_admin(OTHER_ID.into())
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let confirm: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .confirm_redeem(1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let cancel: sails_rs::Result<(), sails_rs::String> = redeem_service
        .cancel_redeem(1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();

    assert_eq!(set_res_contract, Err("caller is not admin".into()));
    assert_eq!(pause, Err("caller is not admin".into()));
    assert_eq!(unpause, Err("caller is not admin".into()));
    assert_eq!(set_rates, Err("caller is not admin".into()));
    assert_eq!(add_admin, Err("caller is not admin".into()));
    assert_eq!(confirm, Err("caller is not RES contract".into()));
    assert_eq!(cancel, Err("caller is not RES contract".into()));
}

#[tokio::test]
async fn standalone_redeem_admin_reserve_lifecycle_is_guarded() {
    let (env, redeem_code_id, _) = create_env();
    let redeem =
        deploy_redeem_program(&env, redeem_code_id, OTHER_ID.into(), "redeem-reserve").await;
    let mut redeem_service = redeem.redeem();
    let mut admin = redeem.admin();
    let mut redeem_events = redeem_service.listen().await.unwrap();
    let mut admin_events = admin.listen().await.unwrap();

    let non_admin_deposit: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .deposit_reserve()
        .with_actor_id(PLAYER_ID.into())
        .with_value(RESERVE_VALUE)
        .await
        .unwrap();
    assert_eq!(non_admin_deposit, Err("caller is not admin".into()));

    let deposit: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .deposit_reserve()
        .with_value(RESERVE_VALUE)
        .await
        .unwrap();
    assert_eq!(deposit, Ok(RESERVE_VALUE));
    assert_eq!(
        redeem_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::redeem::events::RedeemEvents::ReserveDeposited(
                actor_bytes(ADMIN_ID),
                RESERVE_VALUE,
                RESERVE_VALUE
            )
        )
    );

    let zero_withdraw: sails_rs::Result<(), sails_rs::String> =
        admin.withdraw_funds(0).await.unwrap();
    let non_admin_withdraw: sails_rs::Result<(), sails_rs::String> = admin
        .withdraw_funds(1)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let allowed_withdraw: sails_rs::Result<(), sails_rs::String> =
        admin.withdraw_funds(RESERVE_VALUE).await.unwrap();
    let reserve_after_withdraw: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.reserve_balance().await.unwrap();

    assert_eq!(
        zero_withdraw,
        Err("withdraw amount must be greater than zero".into())
    );
    assert_eq!(non_admin_withdraw, Err("caller is not admin".into()));
    assert_eq!(allowed_withdraw, Ok(()));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::admin::events::AdminEvents::FundsWithdrawn(
                actor_bytes(ADMIN_ID),
                RESERVE_VALUE,
                0
            )
        )
    );
    assert_eq!(reserve_after_withdraw, Ok(0));
}

#[tokio::test]
async fn redeem_rejects_when_vmt_burn_fails_and_restores_reserve() {
    let (_env, redeem, res) = deploy_pair("burn-fail").await;
    fund_reserve_and_mint_player_res(&redeem, &res, 1, 0, 0).await;

    let mut redeem_service = redeem.redeem();
    let mut redeem_events = redeem_service.listen().await.unwrap();
    let requested_payout: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(2, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(requested_payout, Ok(2 * SCRST_RATE * VARA_UNIT));
    assert_eq!(
        redeem_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::redeem::events::RedeemEvents::RedeemRequested(
                1,
                actor_bytes(PLAYER_ID),
                2,
                0,
                0,
                2 * SCRST_RATE * VARA_UNIT
            )
        )
    );
    assert_eq!(
        redeem_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::redeem::events::RedeemEvents::RedeemCanceled(
                1,
                actor_bytes(PLAYER_ID),
                2,
                0,
                0,
                2 * SCRST_RATE * VARA_UNIT
            )
        )
    );

    let reserve_after_failure: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.reserve_balance().await.unwrap();
    let locked_after_failure: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.locked_balance().await.unwrap();
    let pending_after_failure: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.pending_redeem_count().await.unwrap();
    let total_paid: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.total_paid().await.unwrap();
    let vmt = res.vmt();
    let player_scrst: sails_rs::Result<u128, sails_rs::String> =
        vmt.balance_of(PLAYER_ID.into(), SCRST_ID).await.unwrap();

    assert_eq!(reserve_after_failure, Ok(RESERVE_VALUE));
    assert_eq!(locked_after_failure, Ok(0));
    assert_eq!(pending_after_failure, Ok(0));
    assert_eq!(total_paid, Ok(0));
    assert_eq!(player_scrst, Ok(1));
}

#[tokio::test]
async fn redeem_rejects_empty_amounts_and_insufficient_reserve() {
    let (_env, redeem, res) = deploy_pair("redeem-guards").await;
    let mut redeem_service = redeem.redeem();

    let empty: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(0, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(
        empty,
        Err("at least one RES amount must be greater than zero".into())
    );

    let mut vmt = res.vmt();
    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), SCRST, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let insufficient_reserve: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    let reserve: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.reserve_balance().await.unwrap();
    let locked: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.locked_balance().await.unwrap();
    let pending: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.pending_redeem_count().await.unwrap();

    assert_eq!(insufficient_reserve, Err("insufficient reserve".into()));
    assert_eq!(reserve, Ok(0));
    assert_eq!(locked, Ok(0));
    assert_eq!(pending, Ok(0));
}

#[tokio::test]
async fn direct_balance_top_up_counts_as_reserve_for_redeem() {
    let (env, redeem, res) = deploy_pair("direct-top-up").await;
    let mut vmt = res.vmt();
    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), SCRST, 0, 0)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    env.system()
        .transfer(ADMIN_ID, redeem.id(), RESERVE_VALUE, true);

    let mut redeem_service = redeem.redeem();
    let payout: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(payout, Ok(SCRST * SCRST_RATE * VARA_UNIT));
}

#[tokio::test]
async fn configured_constructor_and_admin_rate_update_control_payout() {
    let (_env, redeem, res) = deploy_pair("configured").await;
    let mut redeem_service = redeem.redeem();
    let mut admin = redeem.admin();

    let scrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.scrst_rate().await.unwrap();
    let bcrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.bcrst_rate().await.unwrap();
    let hcrst_rate: sails_rs::Result<u128, sails_rs::String> =
        redeem_service.hcrst_rate().await.unwrap();
    assert_eq!(scrst_rate, Ok(SCRST_RATE));
    assert_eq!(bcrst_rate, Ok(BCRST_RATE));
    assert_eq!(hcrst_rate, Ok(HCRST_RATE));

    let set_rates: sails_rs::Result<(), sails_rs::String> = admin.set_rates(1, 2, 3).await.unwrap();
    assert_eq!(set_rates, Ok(()));
    let zero_rate: sails_rs::Result<(), sails_rs::String> = admin.set_rates(0, 2, 3).await.unwrap();
    assert_eq!(
        zero_rate,
        Err("redeem rates must be greater than zero".into())
    );

    let mut vmt = res.vmt();
    let reserve_after_deposit: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .deposit_reserve()
        .with_value(RESERVE_VALUE)
        .await
        .unwrap();
    assert_eq!(reserve_after_deposit, Ok(RESERVE_VALUE));
    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), SCRST, BCRST, HCRST)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));

    let payout: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, BCRST, HCRST)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(payout, Ok((2 * 1 + 3 * 2 + 3) * VARA_UNIT));
}

#[tokio::test]
async fn admin_can_update_res_contract_and_withdraw_reserve() {
    let (_env, redeem, _res) = deploy_pair("admin").await;
    let mut redeem_service = redeem.redeem();
    let mut admin = redeem.admin();

    let update_result: sails_rs::Result<(), sails_rs::String> =
        admin.set_res_contract(OTHER_ID.into()).await.unwrap();
    assert_eq!(update_result, Ok(()));

    let res_contract: sails_rs::Result<ActorId, sails_rs::String> =
        admin.res_contract().await.unwrap();
    assert_eq!(res_contract, Ok(OTHER_ID.into()));

    let reserve_after_deposit: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .deposit_reserve()
        .with_value(RESERVE_VALUE)
        .await
        .unwrap();
    assert_eq!(reserve_after_deposit, Ok(RESERVE_VALUE));

    let too_much: sails_rs::Result<(), sails_rs::String> =
        admin.withdraw_funds(RESERVE_VALUE + 1).await.unwrap();
    assert_eq!(too_much, Err("insufficient reserve".into()));

    let allowed: sails_rs::Result<(), sails_rs::String> =
        admin.withdraw_funds(RESERVE_VALUE).await.unwrap();
    assert_eq!(allowed, Ok(()));
}

#[tokio::test]
async fn pause_blocks_redeem_until_unpaused() {
    let (_env, redeem, res) = deploy_pair("pause").await;
    fund_reserve_and_mint_player_res(&redeem, &res, SCRST, 0, 0).await;
    let mut redeem_service = redeem.redeem();
    let mut admin = redeem.admin();
    let mut admin_events = admin.listen().await.unwrap();

    let pause_result: sails_rs::Result<(), sails_rs::String> = admin.pause().await.unwrap();
    assert_eq!(pause_result, Ok(()));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::admin::events::AdminEvents::Paused(actor_bytes(ADMIN_ID))
        )
    );
    let pause_again: sails_rs::Result<(), sails_rs::String> = admin.pause().await.unwrap();
    assert_eq!(pause_again, Err("redeem is already paused".into()));
    let paused: sails_rs::Result<bool, sails_rs::String> = admin.is_paused().await.unwrap();
    assert_eq!(paused, Ok(true));

    let payout_paused: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(payout_paused, Err("redeem is paused".into()));

    let unpause_result: sails_rs::Result<(), sails_rs::String> = admin.unpause().await.unwrap();
    assert_eq!(unpause_result, Ok(()));
    assert_eq!(
        admin_events.next().await.unwrap(),
        (
            redeem.id(),
            ::digger_redeem_client::admin::events::AdminEvents::Unpaused(actor_bytes(ADMIN_ID))
        )
    );
    let unpause_again: sails_rs::Result<(), sails_rs::String> = admin.unpause().await.unwrap();
    assert_eq!(unpause_again, Err("redeem is not paused".into()));

    let payout: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .redeem(SCRST, 0, 0)
        .with_actor_id(PLAYER_ID.into())
        .await
        .unwrap();
    assert_eq!(payout, Ok(SCRST * SCRST_RATE * VARA_UNIT));
}

async fn fund_reserve_and_mint_player_res(
    redeem: &sails_rs::client::Actor<::digger_redeem_client::DiggerRedeemClientProgram, GtestEnv>,
    res: &sails_rs::client::Actor<::digger_res_vmt_client::DiggerResVmtClientProgram, GtestEnv>,
    scrst: u128,
    bcrst: u128,
    hcrst: u128,
) {
    let mut redeem_service = redeem.redeem();
    let reserve_after_deposit: sails_rs::Result<u128, sails_rs::String> = redeem_service
        .deposit_reserve()
        .with_value(RESERVE_VALUE)
        .await
        .unwrap();
    assert_eq!(reserve_after_deposit, Ok(RESERVE_VALUE));

    let mut vmt = res.vmt();
    let mint_result: sails_rs::Result<(), sails_rs::String> = vmt
        .mint_resources(PLAYER_ID.into(), scrst, bcrst, hcrst)
        .with_actor_id(MINTER_ID.into())
        .await
        .unwrap();
    assert_eq!(mint_result, Ok(()));
}

async fn deploy_pair(
    salt_prefix: &str,
) -> (
    GtestEnv,
    sails_rs::client::Actor<::digger_redeem_client::DiggerRedeemClientProgram, GtestEnv>,
    sails_rs::client::Actor<::digger_res_vmt_client::DiggerResVmtClientProgram, GtestEnv>,
) {
    let (env, redeem_code_id, res_code_id) = create_env();

    let redeem = env
        .deploy::<::digger_redeem_client::DiggerRedeemClientProgram>(
            redeem_code_id,
            format!("{salt_prefix}-redeem").into_bytes(),
        )
        .create(ActorId::zero(), VARA_UNIT, SCRST_RATE, BCRST_RATE, HCRST_RATE)
        .await
        .unwrap();

    let res = env
        .deploy::<::digger_res_vmt_client::DiggerResVmtClientProgram>(
            res_code_id,
            format!("{salt_prefix}-res").into_bytes(),
        )
        .create(redeem.id(), MINTER_ID.into())
        .await
        .unwrap();

    let mut redeem_admin = redeem.admin();
    let set_res_contract: sails_rs::Result<(), sails_rs::String> =
        redeem_admin.set_res_contract(res.id()).await.unwrap();
    assert_eq!(set_res_contract, Ok(()));

    (env, redeem, res)
}

async fn deploy_redeem_program(
    env: &GtestEnv,
    code_id: CodeId,
    res_contract: ActorId,
    salt: &str,
) -> sails_rs::client::Actor<::digger_redeem_client::DiggerRedeemClientProgram, GtestEnv> {
    env.deploy::<::digger_redeem_client::DiggerRedeemClientProgram>(
        code_id,
        salt.as_bytes().to_vec(),
    )
    .create(res_contract, VARA_UNIT, SCRST_RATE, BCRST_RATE, HCRST_RATE)
    .await
    .unwrap()
}

fn create_env() -> (GtestEnv, CodeId, CodeId) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(ADMIN_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(MINTER_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(PLAYER_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(OTHER_ID, TEST_ACCOUNT_BALANCE);

    let redeem_code_id = system.submit_code(::digger_redeem::WASM_BINARY);
    let res_code_id = system.submit_code(::digger_res_vmt::WASM_BINARY);
    let env = GtestEnv::new(system, ADMIN_ID.into());
    (env, redeem_code_id, res_code_id)
}

fn actor_bytes(id: u64) -> [u8; 32] {
    ActorId::from(id).into()
}
