# Gtest Report

## Target Workspace

`luisa-proof-router`

## Commands Run

- `cargo fmt`
- `cargo build --release`
- `cargo test --release`

## Failing Cases

- None in the final ProofPack API pass.

## Fix Summary

- Replaced the earlier `ProofRouter/SubmitProof` shape with `ProofPack/SubmitReceipt`.
- Added subject and target receipt indexes.
- Added strict `0x` + 64 hex validation for `proof_tx_hash` and `evidence_hash`.
- Added duplicate `proof_tx_hash` rejection.
- Regenerated the Sails IDL and Rust client through the normal build pipeline.
- Updated gtests for receipt submission, query indexes, invalid input rejection, duplicate hash rejection, and owner-only pause lifecycle.

## Final Green State

`cargo test --release` passes:

```text
running 4 tests
test submit_receipt_rejects_invalid_inputs_without_state_change ... ok
test duplicate_proof_tx_hash_is_rejected ... ok
test submit_receipt_records_event_and_query_indexes ... ok
test owner_can_pause_and_unpause_writes ... ok

test result: ok. 4 passed; 0 failed
```

## Remaining Gaps

- No local-node smoke yet.
- No mainnet deployment yet.
- No VAN Application registration yet.
- No frontend or custom indexer yet.
