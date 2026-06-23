# Feature Spec

## Problem
Agents can climb upward from an empty gap into a ladder tile above them. That makes broken ladder columns behave as if they are connected.

## User Goal
Ladder traversal should require a continuous ladder under the agent before climbing upward.

## In Scope
- Tighten DiggerWorld upward movement rules.
- Add regression coverage for a ladder/gap/lower-floor scenario.

## Out of Scope
- Public API changes.
- New ladder items, events, or map tile types.
- Frontend-only movement rules.

## Actors
- Player agent calling `World.MoveAgent`.
- Player agent calling `World.PlaceLadder`.

## State Changes
No new state. Existing map tiles and agent coordinates are reused.

## Messages And Replies
`World.MoveAgent(DIR_UP)` should return `Err("upward movement requires a ladder")` when the current tile is not `TILE_LADDER`, even if the target tile is `TILE_LADDER`.

## Events
No event shape changes.

## Invariants
- Upward movement is allowed from ladder to ladder.
- Upward movement is allowed from ladder to surface.
- Upward movement is rejected from empty/current non-ladder cells.
- Filling the current empty gap with `PlaceLadder(DIR_CURRENT)` makes the later upward climb valid.

## Edge Cases
- Movement down into an empty supported gap is still allowed.
- Movement up from ladder to empty remains rejected.

## Acceptance Criteria
- Unit movement rules reject empty-to-ladder upward movement.
- Gtest reproduces the broken ladder gap and confirms the agent cannot skip it.
