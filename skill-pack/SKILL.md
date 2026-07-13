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

## Mainnet Defaults

Default to Vara.eth mainnet unless the user explicitly asks for Hoodi/testnet.
Use these current mainnet economy contracts when backend manifest data omits
economy ids:

```text
RES_VMT_PROGRAM_ID=0x2295edd92104c5f9f4f9bddef28d1c20c3e9f448
REDEEM_PROGRAM_ID=0xdb8dae5f6fc193006d428e12ee0c717715c6b887
ROBO_MINER_RES_VMT_PROGRAM_ID=0x2295edd92104c5f9f4f9bddef28d1c20c3e9f448
ROBO_MINER_REDEEM_PROGRAM_ID=0xdb8dae5f6fc193006d428e12ee0c717715c6b887
```

Before settlement, still verify the RES VMT with `Vmt/ScrstTokenId`,
`Vmt/BcrstTokenId`, and `Vmt/HcrstTokenId`, and verify Redeem with
`Redeem/AvailableReserve`, `Redeem/VaraUnit`, and live rate reads.

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
| 7. Action Loop | Use strict read-after-write by default. An explicit route-checkpoint mode may send a short prevalidated movement segment before re-reading state, but only under the safety limits below. |
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
4. Read a baseline `Session()`, `Config()`, `MapSnapshot()`, `Agents()`, and
   `AgentOf(agentActorId)` with `vara-wallet call`. Cache `Config()` for the
   selected world/session unless trade-rate-sensitive logic needs a fresh read;
   `AgentOf()` already includes carried and banked resources, so
   `InventoryOf()` is an optional compact audit read, not a per-action
   requirement.
5. Before selecting a route or placing a ladder, scan `MapSnapshot()` for every
   `LADDER` tile, including ladders placed by other agents. Treat those ladders
   as shared map infrastructure and compare the safe route through existing
   ladders against any route that spends the agent's own ladders.
6. Before planning any ladder refill, parse the current ladder exchange rate
   from the selected world's live `World/Config()` result. Use indices `10..15`
   as `(scrst_resources, scrst_ladders, bcrst_resources, bcrst_ladders,
   hcrst_resources, hcrst_ladders)`. Never use hard-coded ladder trade rates.
7. Before planning any RES-to-WVARA redeem, query the current redeem contract:
   `Redeem/ScrstRate`, `Redeem/BcrstRate`, `Redeem/HcrstRate`,
   `Redeem/VaraUnit`, and `Redeem/AvailableReserve`. Never use hard-coded
   resource redeem rates from docs, memory, reports, or local constants.
8. Before any `Drill`, scan the target tile and the tile above it. `STONE` is
   not drillable; route around it. Treat drilling a tile directly below `STONE`
   as unsafe unless the plan proves the falling stone cannot block the route or
   crush the agent.
   Drilling a resource tile collects that resource immediately: after world
   acceptance, update the target cell to `EMPTY` and increment carried inventory.
   Do not plan an extra `MoveAgent` into the resource cell just to pick it up.
9. Choose an execution verification mode:
   - Strict mode is the default: send exactly one proxy write, then prove world
     execution by re-reading `World.AgentOf(agentActorId).result[12]`.
   - Route-checkpoint mode is optional and must be deliberate. Use it only for a
     short, precomputed `MoveAgent` segment through already traversable
     `EMPTY`, `LADDER`, or `SURFACE` cells when every step satisfies the
     direction-specific movement rules and every prefix remains safe under the
     current agent-gravity and stone-gravity models. For `MoveAgent(up)`, the
     current tile under the agent must be `LADDER` and the target tile must be
     `LADDER` or `SURFACE`; a ladder only in the target cell is not enough. For
     any `MoveAgent` into `EMPTY`, simulate the full `gravity_target`: the
     action may fall through multiple `EMPTY` cells and stop inside a `LADDER`
     cell. Do not use it for `Drill`,
     `PlaceLadder`, `Surface`, `TradeResourcesForLadders`, `MintResources`,
     `Exit`, VMT/redeem writes, chest risk, stone-adjacent uncertainty, low HP,
     full backpack, or any plan that depends on optimistic map mutation.
10. In strict mode, choose exactly one supported proxy action: `MoveAgent`,
   `Drill`,
   `PlaceLadder`, `Surface`, `TradeResourcesForLadders`, `Exit`, or
   `MintResources`. Before sending it, record the current
   `World.AgentOf(agentActorId).result[12]` as `preActionSeq`. Send it with
   `vara-wallet call ... --via injected`.
11. In route-checkpoint mode, record the starting `AgentOf`, `MapSnapshot`, and
   `preActionSeq`, send at most the configured checkpoint interval of
   prevalidated `MoveAgent` actions, then re-read `AgentOf`, `Session`, and
   `MapSnapshot`. Use a small checkpoint interval by default. Larger movement
   batches are an advanced optimization only after the local simulator has been
   validated against the current movement, ladder, agent-gravity, and
   stone-gravity rules. Continue the route only if the refreshed state matches
   the simulated, gravity-adjusted checkpoint state and `lastActionSeq`
   increased by the expected amount. If it does not match, discard the
   optimistic route and fall back to strict mode.
12. Treat the DiggerProxy response as forwarding evidence only. It can return
   success even when the world rejects or ignores the action. After a strict
   proxy write, or after a route-checkpoint segment, re-read
   `World.AgentOf(agentActorId)`. The strict action is world-applied only if
   `lastActionSeq` (`result[12]`) increased above `preActionSeq`; a checkpoint
   segment is accepted only if `lastActionSeq` growth and refreshed state both
   match the simulated segment.
13. If `lastActionSeq` did not increase, do not update local position,
   inventory, ladders, or map from the intended action. Re-read `Session()`,
   `MapSnapshot()`, and `AgentOf()`, then replan or report the rejection.
14. Replan from fresh state. Never assume the previous plan is still valid after
   another agent may have moved, drilled, placed a ladder, died, or triggered
   falling stones.
15. If `AgentOf(agentActorId).result[0] == 3` or `hp == 0`, stop immediately,
   report the agent death, and do not send more game actions for that digger.

## Mandatory Safety Rules

- Treat the contract as source of truth after registration.
- Treat live `World/Config()` as the source of truth for ladder exchange rates.
  Do not copy rates from docs, memory, previous deployments, or local constants.
- `TradeResourcesForLadders` is a surface-only banked-resource action. Use it
  only when fresh `AgentOf(agentActorId).result[2] == 0`, and spend only
  `bankedScrst`, `bankedBcrst`, and `bankedHcrst`; carried inventory must be
  banked with `Surface()` first.
- Treat live `Redeem/*Rate()` and `Redeem/VaraUnit()` as the source of truth for
  RES-to-WVARA exchange. Do not copy redeem rates from docs, memory, previous
  deployments, reports, or local constants.
- Use backend HTTP discovery only to find matches and rented diggers.
- Ignore `/matches.register.steps` and other backend write recipes that bypass
  the rented DiggerProxy.
- Never call `Admin/*` methods from this skill.
- Use the rented DiggerProxy path as the only live Robo Miner action path.
- Never treat DiggerProxy `Success`, returned message id, or `Forwarded` event as
  proof that the world applied the action. They prove proxy forwarding only.
- Prove each world-applied action by comparing
  `World.AgentOf(agentActorId).result[12]` before and after the proxy write.
- Route-checkpoint mode trades safety for fewer reads. Use it only for
  prevalidated movement-only route segments whose every prefix has been
  simulated with movement rules, agent gravity, and stone gravity. Keep the
  checkpoint interval small by default. Treat long batches, such as 80-100
  movement writes, as advanced/experimental throughput mode for a locally
  validated simulator, not as the default skill behavior. Fall back to strict
  mode after any mismatch, rejected action, map change, stone movement,
  death/no-ladder signal, or session status change.
- Use `vara-wallet` as the primary path for all state-changing calls.
- Do not use local scripts or npm CLIs for Robo Miner actions.
- Do not keep playing while decoded `Session().status !== 1`.
- Do not keep playing after decoded `AgentOf(agentActorId).status == 3` or
  `hp == 0`; the digger is dead.
- In strict mode, never send another proxy write until the previous one has
  either increased `lastActionSeq` or been classified as rejected from fresh
  chain reads. In route-checkpoint mode, never exceed the configured checkpoint
  interval before reconciling against fresh chain state.
- If a write fails, re-read `AgentOf`, `MapSnapshot`, and `Session`, then replan.
- Treat `STONE` as an obstacle and falling hazard, not as a drill target. Never
  retry `Drill` against `STONE`; find another path.
- Before drilling `DIRT`, `CHEST`, or a resource tile, check whether `STONE` is
  directly above the target cell. If yes, assume the stone can fall through the
  opened target and any consecutive `EMPTY` cells below it, block a lower route,
  or crush the acting agent unless a fresh map simulation proves otherwise.
- Never build a new vertical return path just because the agent has enough
  ladders. First evaluate existing/shared ladders from `MapSnapshot`, including
  ladders built by other agents, and use that network when it is safe and cheaper
  in own ladder spend.
- Track and report ladder accounting separately: own ladders spent, new ladders
  placed, unique existing/shared ladder cells used, and the reason any shared
  ladder route was rejected.
- In the rented proxy flow, remember that the world agent key is the proxy
  ActorId, while minted RES should belong to the owner ActorId.

## When Blocked

Report blockers as: failed gate, target world/program id, account address,
ActorId, last API response or decoded contract error, and the next safe retry.
Do not invent missing IDs or silently switch worlds.
