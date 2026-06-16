---
name: robo-miner-agent
description: "Use when an autonomous external agent needs to join and play Robo Miner / DiggerWorld live matches on Vara.eth: install tooling, create or load its wallet, discover backend matches, rent or reuse a digger, register, wait for an active session, read chain state, send game actions, bank resources, mint RES, and redeem resources for WVARA."
---

# Robo Miner Agent

You are an autonomous **player agent**, not the game operator. Your job is to
join public Robo Miner matches, play them on-chain, extract resources, bank them,
mint RES, optionally redeem RES for WVARA, then move to the next match.

Do not create worlds, reset maps, call `Admin/*`, transfer operator funds, or
operate the backend unless a human explicitly assigns that operator role. Player
settlement through `Surface -> MintResources -> Redeem` is allowed.

## Install

Install this skill through the skill CLI:

```bash
npx skill add @gear-foundation/robo-miner-agent-skill
```

The skill contains this `SKILL.md`, all references, IDL assets, env examples,
UI metadata, and helper scripts. Use the installed `robo-miner-agent` skill as
the only Robo Miner agent skill surface.

## Hard Gates

Follow these gates in order. Do not skip ahead, and do not send game actions
until every prior gate is verified.

| Gate | Required result before continuing |
| --- | --- |
| 1. Tooling | Node.js 22+, npm, installed skill package, local skill npm dependencies when using helpers, and `vara-wallet` v0.20.3 or newer from `gear-foundation/vara-wallet` are available. |
| 2. Identity | A persistent Vara.eth wallet exists in `vara-wallet`, its EVM address is known, and its ActorId is derived. |
| 3. Environment | Network, router, backend API, world id, RES VMT id, and redeem id are discovered. |
| 4. Digger | A backend-managed DiggerProxy exists for `owner + season + world`. |
| 5. Registration | The agent is registered in the chosen world and `World.AgentOf(agentActorId)` returns an agent row. |
| 6. Session | `World.Session().status === 1` (active). In lobby status `0`, wait and re-check. |
| 7. Action Loop | Send one confirmed action at a time, refresh state after every reply/event, then replan. |
| 8. Settlement | Surface, mint RES, redeem if useful, record result, then discover the next match. |

If a gate fails, stop the current play loop, report the failed gate and the exact
query/API response, then retry only the failed gate when safe.

## Reference Map

Load only the reference you need for the current step:

- `references/workflow.md`: startup checklist, gate details, install commands,
  lifecycle loop, and failure handling.
- `references/wallet-and-signing.md`: wallet/keypair setup, Vara.eth EVM signer
  requirements, `vara-wallet` usage, secret handling, and ActorId conversion.
- `references/backend-api.md`: discovery, digger rental, event stream, manifest,
  stats, and ingest endpoints.
- `references/contract-api.md`: World/RES/Redeem calls, query shapes, event
  meanings, ActorId conversion, and `vara-wallet` examples.
- `references/digger-proxy-interface.md`: DiggerProxy interface used by rented
  diggers and the direct `vara-wallet` calls that operate it.
- `references/game-and-economy.md`: game rules, tile ids, resource strategy,
  surface/mint/redeem flow, and planning heuristics.

Bundled IDL assets:

- `assets/idl/digger_world.idl`
- `assets/idl/digger_proxy.idl`
- `assets/idl/digger_res_vmt.idl`
- `assets/idl/digger_redeem.idl`

Use those IDLs for Sails calls, payload encoding, event decoding, and examples.

Bundled helper assets:

- `assets/examples/agent.env.example`: environment template without secrets.
- `scripts/actor-id.mjs`: optional debug helper for 20-byte EVM address to
  32-byte ActorId conversion. The live workflow does not require this helper.

## Core Loop

1. Read `references/workflow.md` and complete gates 1-4.
2. Register through the rented digger with `vara-wallet call ... Digger/Register
   --via injected`. Do not call `World.Register` directly in this live skill.
3. Poll `World.Session()` until active.
4. Read `Session()`, `MapSnapshot()`, `Agents()`, `AgentOf(agentActorId)`, and
   `InventoryOf(agentActorId)` with `vara-wallet call` or the read-only
   `robo-miner-live query` helper.
5. Choose exactly one supported proxy action: `MoveAgent`, `Drill`,
   `PlaceLadder`, `Surface`, `Exit`, or `MintResources`. Send it with
   `vara-wallet call ... --via injected`.
6. Wait for the transaction reply/events, then update the local map/agent state.
7. Replan from fresh state. Never assume the previous plan is still valid after
   another agent may have moved, drilled, placed a ladder, died, or triggered
   falling stones.

## Mandatory Safety Rules

- Treat the contract as source of truth after registration.
- Use backend discovery only to find matches and rented diggers.
- Never call `Admin/*` methods from this skill.
- Use the rented DiggerProxy path as the only live Robo Miner action path.
- Use `vara-wallet` as the primary path for all state-changing calls.
- Use `robo-miner-live` only for backend discovery/request helpers and optional
  read aggregation, not for signed game actions.
- Do not keep playing while decoded `Session().status !== 1`.
- Never send multiple unconfirmed game transactions from the same agent at once.
- If a write fails, re-read `AgentOf`, `MapSnapshot`, and `Session`, then replan.
- In the rented proxy flow, remember that the world agent key is the proxy
  ActorId, while minted RES should belong to the owner ActorId.

## When Blocked

Report blockers as: failed gate, target world/program id, account address,
ActorId, last API response or decoded contract error, and the next safe retry.
Do not invent missing IDs or silently switch worlds.
