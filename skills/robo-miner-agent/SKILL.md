---
name: robo-miner-agent
description: "Use when an autonomous external agent needs to join and play Robo Miner / DiggerWorld live matches on Vara.eth: install tooling, create or load its wallet, discover backend matches, rent or reuse a digger, register, wait for an active session, read chain state, send game actions, bank resources, mint RES, and redeem resources for VARA."
license: MIT
metadata:
  author: web3-miner
  version: "0.3.0"
---

# Robo Miner Agent

You are an autonomous **player agent**, not the game operator. Your job is to
join public Robo Miner matches, play them on-chain, extract resources, bank them,
mint RES, optionally redeem RES for VARA, then move to the next match.

Do not create worlds, reset maps, call `Admin/*`, top up balances, or operate the
backend unless a human explicitly assigns that operator role.

## Hard Gates

Follow these gates in order. Do not skip ahead, and do not send game actions
until every prior gate is verified.

| Gate | Required result before continuing |
| --- | --- |
| 1. Tooling | Node/npm available, `vara-wallet` installed or an equivalent Vara.eth signer configured. |
| 2. Identity | A persistent wallet/keypair exists, its EVM address is known, and its ActorId is derived. |
| 3. Environment | Network, router, backend API, world id, RES VMT id, and redeem id are discovered. |
| 4. Digger | A backend-managed DiggerProxy exists for `owner + season + world`, or direct world mode is explicitly allowed. |
| 5. Registration | The agent is registered in the chosen world and `World.AgentOf(agentActorId)` returns an agent row. |
| 6. Session | `World.Session()[2] === 1` (active). In lobby status `0`, wait and re-check. |
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
  meanings, ActorId conversion, and script examples.
- `references/digger-proxy-interface.md`: DiggerProxy interface used by rented
  diggers. The generated proxy IDL is not currently bundled in this repo.
- `references/game-and-economy.md`: game rules, tile ids, resource strategy,
  surface/mint/redeem flow, and planning heuristics.

Bundled IDL assets:

- `assets/idl/digger_world.idl`
- `assets/idl/digger_res_vmt.idl`
- `assets/idl/digger_redeem.idl`

Use those IDLs for Sails calls, payload encoding, event decoding, and examples.

Bundled helper assets:

- `assets/examples/agent.env.example`: environment template without secrets.
- `scripts/actor-id.mjs`: deterministic EVM address <-> ActorId helper.

## Core Loop

1. Read `references/workflow.md` and complete gates 1-4.
2. Register through the rented digger when available. Direct `World.Register`
   is only for explicitly direct/test flows.
3. Poll `World.Session()` until active.
4. Read `Config()`, `Session()`, `MapSnapshot()`, `Agents()`, and
   `AgentOf(agentActorId)`.
5. Choose exactly one action: `MoveAgent`, `Drill`, `PlaceLadder`, `Surface`,
   `MintResources`, or `Exit`.
6. Wait for the transaction reply/events, then update the local map/agent state.
7. Replan from fresh state. Never assume the previous plan is still valid after
   another agent may have moved, drilled, placed a ladder, died, or triggered
   falling stones.

## Mandatory Safety Rules

- Treat the contract as source of truth after registration.
- Use backend discovery only to find matches and rented diggers.
- Never call `Admin/*` methods from this skill.
- Do not keep playing while `Session()[2] !== 1`.
- Never send multiple unconfirmed game transactions from the same agent at once.
- If a write fails, re-read `AgentOf`, `MapSnapshot`, and `Session`, then replan.
- If proxy mode is used, remember that the world agent key is the proxy ActorId,
  while minted RES should belong to the owner ActorId.

## When Blocked

Report blockers as: failed gate, target world/program id, account address,
ActorId, last API response or decoded contract error, and the next safe retry.
Do not invent missing IDs or silently switch worlds.
