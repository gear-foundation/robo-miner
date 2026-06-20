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

## Skill Source

Use this folder as a Codex skill source. The skill is the `SKILL.md`,
references, IDL assets, env example, and UI metadata under
`skill-pack`. Install it from GitHub with `npx skills add`, not from npm. Once
the skill is loaded in the agent runtime, the live tooling is `vara-wallet` plus
ordinary backend HTTP requests.

## Hard Gates

Follow these gates in order. Do not skip ahead, and do not send game actions
until every prior gate is verified.

| Gate | Required result before continuing |
| --- | --- |
| 1. Tooling | This skill folder is loaded, `curl` is available for backend HTTP, and `vara-wallet` v0.20.3 or newer from `gear-foundation/vara-wallet` is available. |
| 2. Identity | A persistent Vara.eth wallet exists in `vara-wallet`, its EVM address is known, and its ActorId is derived. |
| 3. Environment | Network, router, backend API, world id, RES VMT id, and redeem id are discovered. |
| 4. Digger | A backend-managed DiggerProxy exists for `owner + season + world`. |
| 5. Registration | The agent is registered in the chosen world and `World.AgentOf(agentActorId)` returns an agent row. |
| 6. Session | `World.Session().status === 1` (active). In lobby status `0`, wait and re-check. |
| 7. Action Loop | Send one confirmed action at a time, refresh state after every reply/event, then replan. |
| 8. Settlement | Surface, mint RES, redeem if useful, record result, then discover the next match. |

If a gate fails, stop the current play loop, report the failed gate and the exact
query/API response, then retry only the failed gate when safe.

## Source Of Truth

When instructions disagree, use this precedence:

1. This skill workflow and bundled references.
2. Fresh chain reads from `vara-wallet`.
3. Backend discovery/rental responses.

Backend `/matches` may include legacy `register.steps` that tell clients to send
`World.Register(owner)`. Ignore those steps in this skill. Player agents register
only through the rented DiggerProxy with `Digger/Register --via injected`.

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
  surface/trade-ladders/mint/redeem flow, and planning heuristics.

Bundled IDL assets:

- `assets/idl/digger_world.idl`
- `assets/idl/digger_proxy.idl`
- `assets/idl/digger_res_vmt.idl`
- `assets/idl/digger_redeem.idl`

Use those IDLs for Sails calls, payload encoding, event decoding, and examples.

Bundled helper assets:

- `assets/examples/agent.env.example`: environment template without secrets.

## Core Loop

1. Read `references/workflow.md` and complete gates 1-4.
2. Register through the rented digger with `vara-wallet call ... Digger/Register
   --via injected`. Do not call `World.Register` directly in this live skill.
3. Poll `World.Session()` until active.
4. Read `Session()`, `MapSnapshot()`, `Agents()`, `AgentOf(agentActorId)`, and
   `InventoryOf(agentActorId)` with `vara-wallet call`.
5. Choose exactly one supported proxy action: `MoveAgent`, `Drill`,
   `PlaceLadder`, `Surface`, `TradeResourcesForLadders`, `Exit`, or
   `MintResources`. Send it with `vara-wallet call ... --via injected`.
6. Wait for the transaction reply/events, then update the local map/agent state.
7. Replan from fresh state. Never assume the previous plan is still valid after
   another agent may have moved, drilled, placed a ladder, died, or triggered
   falling stones.
8. If `AgentOf(agentActorId).result[0] == 3` or `hp == 0`, stop immediately,
   report the agent death, and do not send more game actions for that digger.

## Mandatory Safety Rules

- Treat the contract as source of truth after registration.
- Use backend HTTP discovery only to find matches and rented diggers.
- Ignore `/matches.register.steps` and other backend write recipes that bypass
  the rented DiggerProxy.
- Never call `Admin/*` methods from this skill.
- Use the rented DiggerProxy path as the only live Robo Miner action path.
- Use `vara-wallet` as the primary path for all state-changing calls.
- Do not use local scripts or npm CLIs for Robo Miner actions.
- Do not keep playing while decoded `Session().status !== 1`.
- Do not keep playing after decoded `AgentOf(agentActorId).status == 3` or
  `hp == 0`; the digger is dead.
- Never send multiple unconfirmed game transactions from the same agent at once.
- If a write fails, re-read `AgentOf`, `MapSnapshot`, and `Session`, then replan.
- In the rented proxy flow, remember that the world agent key is the proxy
  ActorId, while minted RES should belong to the owner ActorId.

## When Blocked

Report blockers as: failed gate, target world/program id, account address,
ActorId, last API response or decoded contract error, and the next safe retry.
Do not invent missing IDs or silently switch worlds.
