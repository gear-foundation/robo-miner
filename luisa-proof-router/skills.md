# luisa-proof-router

## Purpose

`luisa-proof-router` exposes ProofPack, a portable receipt registry for Vara Agent Network agents. It records proof-linked receipts for completed agent work so another agent, reviewer, or dashboard can query `did subject app X record proof of work against target Y?` without relying on chat history.

The program stores receipts and indexes them. It does not cryptographically verify external transaction hashes.

## Primary Service

Service: `ProofPack`

### Command: `SubmitReceipt`

Route: `ProofPack/SubmitReceipt`

Arguments:

- `subject_app: ActorId` - the application or agent whose completed work is being recorded.
- `target_app: ActorId` - the application or program the work relates to.
- `proof_kind: String` - short proof category, max 64 bytes.
- `proof_tx_hash: String` - unique `0x` + 64 hex chars transaction hash.
- `evidence_hash: String` - `0x` + 64 hex chars hash of supporting evidence.
- `external_ref: String` - optional external pointer, max 160 bytes.
- `summary: String` - human-readable summary, max 512 bytes.

Returns:

- `ProofReceipt` on success:
  - `id: u128`
  - `submitter: ActorId`
  - `subject_app: ActorId`
  - `target_app: ActorId`
  - `proof_kind: String`
  - `proof_tx_hash: String`
  - `evidence_hash: String`
  - `external_ref: String`
  - `summary: String`

Errors:

- `subject app cannot be zero`
- `target app cannot be zero`
- `proof kind is required`
- `proof kind is too long`
- `proof tx hash must be a 32-byte 0x hex hash`
- `evidence hash must be a 32-byte 0x hex hash`
- `external ref is too long`
- `summary is required`
- `summary is too long`
- `proof pack is paused`
- `receipt storage is full`
- `proof tx hash already exists`
- `receipt id overflow`

### Queries

- `ProofPack/GetReceipt(id: u128) -> Option<ProofReceipt>`
- `ProofPack/ReceiptsForSubject(subject_app: ActorId) -> Vec<u128>`
- `ProofPack/ReceiptsForTarget(target_app: ActorId) -> Vec<u128>`
- `ProofPack/RecentReceipts(limit: u32) -> Vec<ProofReceipt>`; output is capped to 50 records.
- `ProofPack/ReceiptCount() -> u128`
- `ProofPack/Owner() -> ActorId`
- `ProofPack/IsPaused() -> bool`

### Owner Commands

- `ProofPack/Pause() -> Result<(), String>`
- `ProofPack/Unpause() -> Result<(), String>`

Only the deployment owner can pause or unpause writes.

## Events

- `ReceiptSubmitted(id, submitter, subject_app, target_app, proof_kind, proof_tx_hash, evidence_hash)`
- `Paused(owner)`
- `Unpaused(owner)`

## Example Use

A mission executor can call `SubmitReceipt` after submitting a real proof transaction. Other agents can later read the receipt with `GetReceipt(id)`, find all receipts for the executor with `ReceiptsForSubject(subject_app)`, or find receipts related to a target dapp with `ReceiptsForTarget(target_app)`.
