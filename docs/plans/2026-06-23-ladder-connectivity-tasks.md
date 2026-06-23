# Task Plan

## Goal
Prevent upward ladder movement across a gap.

## Preconditions
- Existing DiggerWorld gtest suite passes.
- Public DiggerWorld API remains unchanged.

## Ordered Tasks
1. Update `ensure_move_allowed` so `DIR_UP` requires `current_tile == TILE_LADDER`.
2. Update unit coverage for empty-to-ladder upward movement.
3. Add a DiggerWorld gtest that reproduces a ladder above an empty gap.
4. Run focused and workspace contract tests.

## Dependencies
No new dependencies.

## Verification Steps
- `cargo test -p digger-world-app moving_up_from_ladder_to_empty_does_not_leave_agent_floating_above_ladder`
- `cargo test -p digger-world --test gtest agent_cannot_climb_from_gap_into_ladder_without_current_ladder`
- `cargo test`

## Review Checkpoints
- No IDL shape change.
- No event shape change.
- Failed skipped-ladder move does not mutate agent position.

## Rollback Notes
Restore the previous `climbs_to_ladder` condition if the intended game design allows jumping onto a ladder from an empty supported gap.
