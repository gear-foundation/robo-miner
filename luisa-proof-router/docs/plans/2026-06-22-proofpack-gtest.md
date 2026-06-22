# Gtest Report

## Target Workspace

`luisa-proof-router`

## Commands Run

- `cargo fmt`
- `cargo build --release`
- `cargo test --release`

## Failing Cases

- None after the ProofPack receipt API update.

## Fix Summary

- Implemented `ProofPack/SubmitReceipt` with `subject_app`, `target_app`, `proof_kind`, `proof_tx_hash`, `evidence_hash`, `external_ref`, and `summary`.
- Implemented `GetReceipt`, `ReceiptsForSubject`, `ReceiptsForTarget`, `RecentReceipts`, `ReceiptCount`, `Owner`, and `IsPaused`.
- Added validation for non-zero actor ids, 32-byte `0x` hash strings, duplicate `proof_tx_hash`, bounded strings, and paused writes.
- Updated generated-client gtests to assert events, indexes, duplicate prevention, validation, and owner-only pause controls.

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

- Local-node smoke is still pending.
- Mainnet deploy and VAN Application registration are still pending.
