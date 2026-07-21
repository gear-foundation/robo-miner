use ::luisa_proof_router_client::{
    LuisaProofRouterClient as _, LuisaProofRouterClientCtors as _,
    proof_pack::{ProofPack as _, ProofReceipt},
};
use sails_rs::futures::StreamExt;
use sails_rs::{client::*, gtest::*, prelude::*};

const OWNER_ID: u64 = 42;
const SUBMITTER_ID: u64 = 99;
const OTHER_ID: u64 = 123;
const SUBJECT_ID: u64 = 555;
const TARGET_ID: u64 = 777;
const TEST_ACCOUNT_BALANCE: u128 = 100_000_000_000_000;
const PROOF_TX_HASH_1: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PROOF_TX_HASH_2: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";
const EVIDENCE_HASH_1: &str = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EVIDENCE_HASH_2: &str = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[tokio::test]
async fn submit_receipt_records_event_and_query_indexes() {
    let (_env, program) = deploy_proof_pack("submit-receipt").await;
    let mut proof_pack = program.proof_pack();
    let listener = proof_pack.listener();
    let mut events = listener.listen().await.unwrap();

    let submitted: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_1.into(),
            EVIDENCE_HASH_1.into(),
            "mission:m3".into(),
            "Submitted a signed AAN mission proof call.".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();

    let expected = ProofReceipt {
        id: 1,
        submitter: SUBMITTER_ID.into(),
        subject_app: SUBJECT_ID.into(),
        target_app: TARGET_ID.into(),
        proof_kind: "mission-proof".into(),
        proof_tx_hash: PROOF_TX_HASH_1.into(),
        evidence_hash: EVIDENCE_HASH_1.into(),
        external_ref: "mission:m3".into(),
        summary: "Submitted a signed AAN mission proof call.".into(),
    };
    assert_eq!(submitted, Ok(expected.clone()));
    assert_eq!(
        events.next().await.unwrap(),
        (
            program.id(),
            ::luisa_proof_router_client::proof_pack::events::ProofPackEvents::ReceiptSubmitted(
                1,
                actor_bytes(SUBMITTER_ID),
                actor_bytes(SUBJECT_ID),
                actor_bytes(TARGET_ID),
                "mission-proof".into(),
                PROOF_TX_HASH_1.into(),
                EVIDENCE_HASH_1.into(),
            )
        )
    );

    let count: u128 = proof_pack.receipt_count().await.unwrap();
    let receipt: Option<ProofReceipt> = proof_pack.get_receipt(1).await.unwrap();
    let subject_ids: Vec<u128> = proof_pack
        .receipts_for_subject(SUBJECT_ID.into())
        .await
        .unwrap();
    let target_ids: Vec<u128> = proof_pack
        .receipts_for_target(TARGET_ID.into())
        .await
        .unwrap();
    let recent: Vec<ProofReceipt> = proof_pack.recent_receipts(10).await.unwrap();

    assert_eq!(count, 1);
    assert_eq!(receipt, Some(expected.clone()));
    assert_eq!(subject_ids, vec![1]);
    assert_eq!(target_ids, vec![1]);
    assert_eq!(recent, vec![expected]);
}

#[tokio::test]
async fn submit_receipt_rejects_invalid_inputs_without_state_change() {
    let (_env, program) = deploy_proof_pack("validation").await;
    let mut proof_pack = program.proof_pack();

    let zero_subject: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            ActorId::zero(),
            TARGET_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_1.into(),
            EVIDENCE_HASH_1.into(),
            "".into(),
            "summary".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert_eq!(zero_subject, Err("subject app cannot be zero".into()));

    let malformed_hash: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "".into(),
            "tx:0xabc123".into(),
            EVIDENCE_HASH_1.into(),
            "".into(),
            "summary".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert_eq!(malformed_hash, Err("proof kind is required".into()));

    let malformed_hash: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "mission-proof".into(),
            "tx:0xabc123".into(),
            EVIDENCE_HASH_1.into(),
            "".into(),
            "summary".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert_eq!(
        malformed_hash,
        Err("proof tx hash must be a 32-byte 0x hex hash".into())
    );

    let count: u128 = proof_pack.receipt_count().await.unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn duplicate_proof_tx_hash_is_rejected() {
    let (_env, program) = deploy_proof_pack("duplicate").await;
    let mut proof_pack = program.proof_pack();

    let first: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_1.into(),
            EVIDENCE_HASH_1.into(),
            "".into(),
            "first receipt".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert!(first.is_ok());

    let duplicate: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            OTHER_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_1.into(),
            EVIDENCE_HASH_2.into(),
            "".into(),
            "duplicate receipt".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();

    assert_eq!(duplicate, Err("proof tx hash already exists".into()));
    let count: u128 = proof_pack.receipt_count().await.unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn owner_can_pause_and_unpause_writes() {
    let (_env, program) = deploy_proof_pack("pause").await;
    let mut proof_pack = program.proof_pack();
    let listener = proof_pack.listener();
    let mut events = listener.listen().await.unwrap();

    let owner: ActorId = proof_pack.owner().await.unwrap();
    let paused: bool = proof_pack.is_paused().await.unwrap();
    assert_eq!(owner, OWNER_ID.into());
    assert!(!paused);

    let non_owner_pause: sails_rs::Result<(), sails_rs::String> = proof_pack
        .pause()
        .with_actor_id(OTHER_ID.into())
        .await
        .unwrap();
    assert_eq!(non_owner_pause, Err("caller is not owner".into()));

    let pause: sails_rs::Result<(), sails_rs::String> = proof_pack.pause().await.unwrap();
    assert_eq!(pause, Ok(()));
    assert_eq!(
        events.next().await.unwrap(),
        (
            program.id(),
            ::luisa_proof_router_client::proof_pack::events::ProofPackEvents::Paused(actor_bytes(
                OWNER_ID
            ))
        )
    );
    let paused: bool = proof_pack.is_paused().await.unwrap();
    assert!(paused);

    let paused_submit: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_1.into(),
            EVIDENCE_HASH_1.into(),
            "".into(),
            "summary".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert_eq!(paused_submit, Err("proof pack is paused".into()));

    let unpause: sails_rs::Result<(), sails_rs::String> = proof_pack.unpause().await.unwrap();
    assert_eq!(unpause, Ok(()));
    assert_eq!(
        events.next().await.unwrap(),
        (
            program.id(),
            ::luisa_proof_router_client::proof_pack::events::ProofPackEvents::Unpaused(
                actor_bytes(OWNER_ID)
            )
        )
    );
    let submit_after_unpause: sails_rs::Result<ProofReceipt, sails_rs::String> = proof_pack
        .submit_receipt(
            SUBJECT_ID.into(),
            TARGET_ID.into(),
            "mission-proof".into(),
            PROOF_TX_HASH_2.into(),
            EVIDENCE_HASH_2.into(),
            "".into(),
            "summary".into(),
        )
        .with_actor_id(SUBMITTER_ID.into())
        .await
        .unwrap();
    assert!(submit_after_unpause.is_ok());
}

async fn deploy_proof_pack(
    salt: &str,
) -> (
    GtestEnv,
    sails_rs::client::Actor<::luisa_proof_router_client::LuisaProofRouterClientProgram, GtestEnv>,
) {
    let (env, code_id) = create_env();
    let program = env
        .deploy::<::luisa_proof_router_client::LuisaProofRouterClientProgram>(
            code_id,
            salt.as_bytes().to_vec(),
        )
        .create()
        .await
        .unwrap();

    (env, program)
}

fn create_env() -> (GtestEnv, CodeId) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(OWNER_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(SUBMITTER_ID, TEST_ACCOUNT_BALANCE);
    system.mint_to(OTHER_ID, TEST_ACCOUNT_BALANCE);

    let code_id = system.submit_code(::luisa_proof_router::WASM_BINARY);
    let env = GtestEnv::new(system, OWNER_ID.into());
    (env, code_id)
}

fn actor_bytes(id: u64) -> [u8; 32] {
    ActorId::from(id).into()
}
