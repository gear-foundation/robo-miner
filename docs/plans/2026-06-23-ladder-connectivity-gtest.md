# Gtest Report

## Target Workspace
`/Users/luisa/robo-miner/contracts`

## Commands Run
- `cargo fmt`
- `cargo test -p digger-world-app moving_up_from_ladder_to_empty_does_not_leave_agent_floating_above_ladder`
- `cargo test -p digger-world --test gtest agent_cannot_climb_from_gap_into_ladder_without_current_ladder`
- `cargo test`

## Failing Cases
The reported behavior was that an agent could climb from an empty gap into a ladder tile above it, making a broken ladder column behave as connected.

## Fix Summary
`DIR_UP` movement now requires the current tile and target tile to both be `TILE_LADDER`, except for the existing ladder-to-surface exit rule.

## Final Green State
Focused unit test passed. Focused DiggerWorld gtest passed. Full contracts workspace test suite passed.

## Remaining Gaps
No local-node smoke was run. Public IDL, route, reply, and event shapes were not changed.
