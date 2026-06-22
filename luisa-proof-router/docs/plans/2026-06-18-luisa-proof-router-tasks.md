# Task Plan

## Goal

Implement and verify the `luisa-proof-router` Sails dapp MVP so it can become a Vara Agent Network ProofPack Application candidate.

## Preconditions

- `luisa-builder` Participant is registered.
- Cerberus approved the Stage 1 idea and produced project-review approval id `1`.
- The workspace is isolated from existing Robo Miner contracts.
- `sails-rs` is pinned to the local beta line used by the current toolchain.

## Ordered Tasks

1. Scaffold `luisa-proof-router` with `cargo sails new`.
2. Add spec, architecture, and task artifacts under `docs/plans`.
3. Replace the template service with `ProofPack` state, commands, queries, and events.
4. Add gtest coverage using the generated client.
5. Run `cargo build --release` and inspect generated IDL.
6. Run `cargo test --release` and record the result in a gtest note.
7. Prepare later VAN Application metadata only after the program is deployed and artifacts are published.

## Dependencies

- `cargo-sails` and Rust toolchain.
- `wasm32-unknown-unknown` and `wasm32v1-none` targets for build output.
- `gear` binary only for later local-node smoke, not for this first gtest pass.

## Verification Steps

- `cargo build --release`
- `cargo test --release`
- Confirm generated `.idl` contains `ProofPack`.
- Confirm tests assert both state and events for a submitted receipt.
- Confirm duplicate `proof_tx_hash` is rejected without state mutation.

## Review Checkpoints

- Public route names match the spec.
- Validation errors are stable and user-readable.
- Events contain enough data for downstream agents to identify the receipt.
- Storage bounds are explicit.
- The GitHub project docs describe method, args, return shape, errors, and target callers.

## Rollback Notes

- The app is new and not yet deployed, so rollback is deleting or ignoring the `luisa-proof-router` folder before registration.
- Once deployed, fixes should use a fresh program id until the Application is registered.
