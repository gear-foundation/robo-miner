# Architecture Note

## Summary

`luisa-proof-router` is an isolated Sails workspace and deployable program for ProofPack. It stores operator-attested receipts for completed agent work discovered in the Vara Agent Network. The contract does not verify external transactions; it provides a stable on-chain receipt surface that other agents can query.

## Program And Service Boundaries

- `Program` owns one `RefCell<ProofPackState>` and exposes a single `ProofPack` service.
- `ProofPackService` owns all public commands and queries.
- No raw `gstd` routing or child program creation is used.

## State Ownership

- `ProofPackState` is owned by the program and borrowed by the service.
- State fields:
  - owner `ActorId`
  - paused flag
  - next receipt id
  - receipts by id
  - receipt id index by subject `ActorId`
  - receipt id index by target `ActorId`
  - unique lookup by `proof_tx_hash`
- State is source-of-truth. Recent receipt lists are derived from receipt ids.

## Message Flow

- `SubmitReceipt` reads `Syscall::message_source()` as submitter, validates input, stores a receipt, updates subject and target indexes, records the proof transaction hash as used, emits `ReceiptSubmitted`, and replies with the full receipt.
- `Pause` and `Unpause` require owner authorization and emit lifecycle events.
- Queries borrow state immutably and never mutate receipts.

## Routing And Public Interface

- Existing public routes that must remain stable: none; this is a new app.
- New routes introduced by this release:
  - `ProofPack/SubmitReceipt`
  - `ProofPack/GetReceipt`
  - `ProofPack/ReceiptsForSubject`
  - `ProofPack/ReceiptsForTarget`
  - `ProofPack/RecentReceipts`
  - `ProofPack/ReceiptCount`
  - `ProofPack/Owner`
  - `ProofPack/IsPaused`
  - `ProofPack/Pause`
  - `ProofPack/Unpause`
- No deprecated routes.
- Method signatures and reply shapes are stable for the MVP registration.

## Event Contract

- Existing events that must remain stable: none.
- New events:
  - `ReceiptSubmitted(u128, [u8; 32], [u8; 32], [u8; 32], String, String, String)`
  - `Paused([u8; 32])`
  - `Unpaused([u8; 32])`
- No event versioning is required for the first release.

## Generated Client Or IDL Impact

- Build regenerates the `.idl` and Rust client.
- VAN readiness will publish the generated `.idl` and a `skills.md` describing the service.
- No old generated clients exist yet.

## Contract Version And Status Surface

- The MVP exposes write status through `IsPaused() -> bool`.
- The owner can move writes between active and paused.
- There is no version query in v1; versioning can be added before public review if needed.

## Off-Chain Components

- No frontend in this pass.
- No custom indexer in this pass.
- Agents can use the generated IDL or `vara-wallet` to call and query the service.

## Release And Cutover Plan

- Build and test locally with gtest first.
- Deploy after green tests.
- Register as a VAN Application only after published `skills.md` and `.idl` URLs exist.
- The old state does not exist; no cutover is required.

## Failure And Recovery Paths

- If deployment fails, keep the workspace local and do not register the Application.
- If the service is deployed but metadata is not ready, keep it unregistered in VAN.
- If a logic issue is found before submission, redeploy and register only the fixed program id.

## Open Questions

- Whether to add a future owner-controlled delete/archive path for spam receipts.
- Whether to add richer evidence schemas after the first live integration proves demand.
