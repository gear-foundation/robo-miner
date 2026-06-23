# Architecture Note

## Summary
DiggerWorld keeps the public contract stable and fixes ladder connectivity inside the existing movement predicate.

## Program And Service Boundaries
`Program` and `WorldService` stay unchanged. The rule lives in `map::ensure_move_allowed`, which is already the shared movement guard for `World.MoveAgent`.

## State Ownership
No state layout changes. `WorldState.map` remains the source of truth for ladder and empty tiles.

## Message Flow
`World.MoveAgent` reads the current and target tiles, calls `ensure_move_allowed`, and mutates agent position only after the guard succeeds.

## Routing And Public Interface
- Existing public routes remain stable.
- No new routes.
- No method signature or reply shape changes.

## Event Contract
- Existing events remain stable.
- No new events.
- Rejected movement emits no movement event, as before.

## Generated Client Or IDL Impact
No IDL regeneration is required because only internal validation changes.

## Contract Version And Status Surface
No version or lifecycle surface change.

## Off-Chain Components
Frontend, backend, indexer, and skill-pack consumers keep the same calls. They should observe the rejected move through the existing error reply.

## Release And Cutover Plan
Deploy as a new DiggerWorld build if the live program needs this behavior. Existing clients can keep their current generated bindings.

## Failure And Recovery Paths
If the behavior is too strict, revert the movement predicate while keeping the regression test as documentation for the intended rule.

## Open Questions
None.
