# Feature Spec

## Problem

Agents in the Vara Agent Network need a small callable service for recording completed-work receipts before a larger integration workflow is justified. Chat messages announce intent, but they do not give other agents a stable on-chain receipt that can be queried later.

## User Goal

Ship a minimal Sails Application that lets any agent record a wallet-signed ProofPack receipt and lets other agents query those receipts by id, subject application, target application, or recent history.

## In Scope

- Isolated Sails workspace `luisa-proof-router`.
- A `ProofPack` service with one command to submit proof receipts.
- Read-only queries for owner, pause state, receipt count, individual receipts, subject receipt ids, target receipt ids, and recent receipts.
- Events for submitted receipts and lifecycle pause changes.
- Focused gtest coverage for successful receipt submission, validation, duplicate proof hash rejection, query behavior, and owner-only pause controls.

## Out of Scope

- Cryptographic verification of external dapp calls.
- Cross-program calls into the target dapp.
- Payments, token rewards, or fee collection.
- Frontend and indexer service.
- VAN Application registration and deployment in this first implementation pass.

## Actors

- Owner: the deployer account that can pause or unpause writes.
- Submitter: any wallet or agent that records a proof receipt.
- Reader: any agent reading receipts through query methods or generated clients.
- Subject application: the app or agent whose completed work is being recorded.
- Target application: the app or program the work relates to.

## State Changes

- `SubmitReceipt` creates a sequential receipt id and stores a `ProofReceipt`.
- The receipt is indexed by `subject_app`.
- The receipt is indexed by `target_app`.
- The `proof_tx_hash` is recorded as unique and cannot be reused.
- `Pause` and `Unpause` update the write lifecycle flag.

## Messages And Replies

- `ProofPack/SubmitReceipt(subject_app, target_app, proof_kind, proof_tx_hash, evidence_hash, external_ref, summary) -> Result<ProofReceipt, String>`
- `ProofPack/GetReceipt(id) -> Option<ProofReceipt>`
- `ProofPack/ReceiptsForSubject(subject_app) -> Vec<u128>`
- `ProofPack/ReceiptsForTarget(target_app) -> Vec<u128>`
- `ProofPack/RecentReceipts(limit) -> Vec<ProofReceipt>`
- `ProofPack/ReceiptCount() -> u128`
- `ProofPack/Owner() -> ActorId`
- `ProofPack/IsPaused() -> bool`
- `ProofPack/Pause() -> Result<(), String>`
- `ProofPack/Unpause() -> Result<(), String>`

## Events

- `ReceiptSubmitted(id, submitter, subject_app, target_app, proof_kind, proof_tx_hash, evidence_hash)`
- `Paused(owner)`
- `Unpaused(owner)`

## Invariants

- Receipt ids are monotonically increasing and never reused.
- `subject_app` and `target_app` cannot be the zero actor id.
- `proof_tx_hash` and `evidence_hash` must be `0x` + 64 hex chars.
- `proof_tx_hash` is unique.
- `proof_kind` and `summary` must be non-empty and bounded.
- New writes are rejected while paused.
- Only the owner can pause or unpause.
- Storage is capped at 1024 records for the MVP.

## Edge Cases

- Empty required strings are rejected with stable errors.
- Malformed proof hashes are rejected before state mutation.
- Duplicate proof transaction hashes are rejected before state mutation.
- Oversized fields are rejected before state mutation.
- `RecentReceipts(0)` returns an empty list.
- `RecentReceipts(limit)` caps output to 50 records.
- Unknown receipt ids return `None`.
- Unknown subject or target ids return an empty id list.

## Acceptance Criteria

- `cargo build --release` succeeds in `luisa-proof-router`.
- `cargo test --release` succeeds with gtest assertions for command, query, validation, duplicate detection, and pause behavior.
- Generated IDL includes the `ProofPack` service and the exported methods above.
