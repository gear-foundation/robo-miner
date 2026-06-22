## ProofPack / luisa-proof-router

`luisa-proof-router` is a Sails program for the Vara Agent Network ProofPack idea: a standalone on-chain receipt registry for completed agent work.

It stores operator-attested receipts that link a completed action to verifiable proof hashes. It does not cryptographically verify external transactions; it gives other agents, dashboards, and reviewers a stable receipt id and indexed read paths they can cite.

The workspace includes:

- `luisa-proof-router`: builds the WASM binary and generated IDL.
- `luisa-proof-router-app`: contains the `ProofPack` service and state.
- `luisa-proof-router-client`: generated Rust client used by gtest and off-chain callers.

### Service

`ProofPack`

### Command

`ProofPack/SubmitReceipt(subject_app, target_app, proof_kind, proof_tx_hash, evidence_hash, external_ref, summary) -> ProofReceipt`

Arguments:

- `subject_app: ActorId` - application or agent whose completed work is being recorded.
- `target_app: ActorId` - application or program the work relates to.
- `proof_kind: String` - short proof category, max 64 bytes.
- `proof_tx_hash: String` - unique 32-byte `0x` transaction hash.
- `evidence_hash: String` - 32-byte `0x` hash of supporting evidence or metadata.
- `external_ref: String` - optional external pointer, max 160 bytes.
- `summary: String` - human-readable summary, max 512 bytes.

Validation:

- `subject_app` and `target_app` must be non-zero actor ids.
- `proof_tx_hash` and `evidence_hash` must be `0x` + 64 hex chars.
- `proof_tx_hash` must be unique.
- `proof_kind` and `summary` must be non-empty and bounded.
- writes are rejected while paused.

### Queries

- `ProofPack/GetReceipt(id: u128) -> Option<ProofReceipt>`
- `ProofPack/ReceiptsForSubject(subject_app: ActorId) -> Vec<u128>`
- `ProofPack/ReceiptsForTarget(target_app: ActorId) -> Vec<u128>`
- `ProofPack/RecentReceipts(limit: u32) -> Vec<ProofReceipt>`; capped to 50.
- `ProofPack/ReceiptCount() -> u128`
- `ProofPack/Owner() -> ActorId`
- `ProofPack/IsPaused() -> bool`

### Owner Commands

- `ProofPack/Pause() -> Result<(), String>`
- `ProofPack/Unpause() -> Result<(), String>`

Only the deployment owner can pause or unpause writes.

### Build

```bash
cargo build --release
```

### Test

```bash
cargo test --release
```

Current gtest coverage checks receipt submission, subject/target indexes, hash validation, duplicate proof transaction rejection, and owner-only pause controls.

# License

The source code is licensed under the [MIT license](LICENSE).
