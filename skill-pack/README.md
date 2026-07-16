# Robo Miner Agent Skill

Codex skill source for autonomous Robo Miner agents on Vara.eth.

The skill folder includes everything an agent needs to understand the player
flow:

- `SKILL.md`
- workflow and API references
- DiggerWorld, DiggerProxy, RES VMT, and Redeem IDLs
- wallet/signing guidance
- env template
- `vara-wallet` command examples for registration, world switching, movement,
  drilling, surfacing, minting, approval, and redeem writes
- Codex agent UI metadata

## Use

Install the agent skill pack from GitHub:

```bash
npx skills add https://github.com/gear-foundation/robo-miner/tree/main/skill-pack -g --all -y
```

If the installer reports `PromptScript does not support global skill
installation`, treat it as non-fatal: PromptScript is project-only, while the
skill still installs for global-capable agents. For PromptScript, run the same
install without `-g` from the target project.

Then restart the agent session if it does not pick up newly installed skills
immediately. Do not install an npm package or helper CLI for this skill. The
live runtime path is `vara-wallet` for wallet/contract calls, the bundled
sourceable action helper for DiggerProxy calls, and HTTP requests for backend
discovery/rental.

## Backend and Writes

```bash
export VARA_WALLET_ACCOUNT="${VARA_WALLET_ACCOUNT:-robo-miner-agent}"
export ROBO_MINER_SKILL_ROOT="${ROBO_MINER_SKILL_ROOT:-skill-pack}"
source "$ROBO_MINER_SKILL_ROOT/scripts/robo-miner-action.sh"

vara-wallet --chain vara-eth --network mainnet --json vara-eth:wallet show "$VARA_WALLET_ACCOUNT"
curl -fsS https://api-digger-eth.vara.network/api/manifest
curl -fsS https://api-digger-eth.vara.network/api/worlds
curl -fsS 'https://api-digger-eth.vara.network/api/diggers?owner=0x...&season=season-1&status=active'

robo_miner_action Digger/Register '[]'
robo_miner_action Digger/MoveAgent '[2]'
robo_miner_action Digger/Drill '[1]'
robo_miner_action Digger/PlaceLadder '[4]'
robo_miner_action Digger/Surface '[]'
robo_miner_action Digger/MintResources '[]'
```

## Agent Prompt

```text
Use the `robo-miner-agent` skill and execute the Robo Miner play workflow
end-to-end through the hard gates. Do not stop at a plan.

First read:
- the installed `robo-miner-agent` SKILL.md, for example
  `~/.agents/skills/robo-miner-agent/SKILL.md`
- `references/workflow.md`
- as needed: `wallet-and-signing.md`, `backend-api.md`,
  `digger-proxy-interface.md`, `contract-api.md`, `game-and-economy.md`

Goal: join a public Robo Miner / DiggerWorld match on Vara.eth mainnet as a player
agent, get or reuse a backend-managed DiggerProxy, register through the
DiggerProxy, wait for an active session, use strict read-after-write by default,
optionally use short route checkpoints for prevalidated movement-only segments,
prove world execution with `World.AgentOf(agentActorId).result[12]`, and
bank/mint/redeem when useful.

Strictly follow the gates:

1. Tooling: verify `curl`, Bash, `jq`, Node, `vara-wallet >= 0.20.5`, and IDL assets.
2. Identity: use or create a persistent Vara.eth wallet. Never print the
   passphrase or private key.
3. Environment: use `mainnet` and backend
   `https://api-digger-eth.vara.network`; fetch `/health`, `/api/manifest`,
   `/api/worlds`, and `/matches`; select a joinable/open or `waiting_agents`
   world.
4. Digger: request or reuse a DiggerProxy through the backend:
   POST `/api/diggers/request` with owner EVM address, worldId, seasonId, and
   dryRun=false. If `status=pending` and `programId=null`, wait about 3 minutes
   and poll `/api/diggers?owner=<ownerAddress>&season=<seasonId>&status=active`.
   Do not pass world/worldId to the lookup. Compare `diggers[].worldId` locally.
   Do not continue until a matching `programId` exists.
5. Verify DiggerProxy with read-only `vara-wallet` calls: `Digger/Owner`,
   `Digger/World`, and `Digger/Status`. Owner must match `ownerActorId`; World
   must match the selected world ActorId.
6. Source the reviewed bundled action helper, then register only through the
   rented DiggerProxy: `robo_miner_action Digger/Register '[]'`. Never call
   `World/Register` directly.

Write path rule:
For all DiggerProxy state-changing calls after rental, source
`$ROBO_MINER_SKILL_ROOT/scripts/robo-miner-action.sh` and use
`robo_miner_action Digger/<Method> '<json-array>'`. Its default submitted path
reuses one named-wallet Vara.eth session for injected writes and chain reads,
then proves completion from fresh chain state before another action may be sent.

Do not use `--via eth` for the play loop unless explicitly asked. If `--via eth`
returns `PROMISE_TIMEOUT`, do not assume failure; immediately verify with a
read-only query.

7. Verify registration from `World/Agents`: it must contain `agentActorId`,
   which is derived from `diggerProgramId`. Then read the successful
   `World/AgentOf(agentActorId)` row.

Register recovery:
If `Digger/Register` fails because the world is full, already active, closed, or
not joinable:
1. Fetch worlds again.
2. Select a fresh joinable/waiting world.
3. Call `robo_miner_action Digger/SetWorld '["newWorldActorId"]'` through the
   same rented DiggerProxy.
4. Verify `Digger.World`.
5. Retry `Digger/Register`.

8. Wait for session: poll `World/Session`; play only when
   `World.Session().result[2] === 1`.
9. Action loop: start from a fresh planning snapshot (`Session`, `AgentOf`,
   `MapSnapshot`, plus cached `Config` as needed). Record
   `preActionSeq = AgentOf(...).result[12]`; in strict mode, send exactly one
   action through DiggerProxy, reread `AgentOf`, and treat the action as applied
   only if `result[12]` increased. Refresh `MapSnapshot` before map-dependent
   decisions and after accepted map-changing actions. In optional
   route-checkpoint mode, send only a short prevalidated `MoveAgent` segment
   whose steps satisfy direction-specific movement rules; for `MoveAgent(up)`,
   require `LADDER` underfoot and `LADDER` or `SURFACE` in the target cell; for
   moves into `EMPTY`, simulate agent gravity because one action can fall
   through multiple empty cells and stop inside a ladder cell. Then reread and
   continue only if `lastActionSeq` growth and chain state match the simulated
   checkpoint.
10. Settlement: when useful, return to surface, then use
   `Surface -> MintResources -> Approve/Redeem` if balances and reserve allow it.

Safety rules:
- Never call `Admin/*`.
- Do not use Robo Miner npm packages, helper CLIs, or arbitrary local scripts
  for game actions. The reviewed bundled
  `scripts/robo-miner-action.sh` is the sole exception; source it rather than
  copying or modifying its commands.
- In strict mode, do not send another proxy action until the previous one has
  either increased `lastActionSeq` or been classified as rejected from fresh
  chain reads. Use route-checkpoint mode only for short movement-only segments.
- After registration, chain state is the source of truth.
- Use backend only for discovery and DiggerProxy rental.
- If any gate fails, stop and report the failed gate, world/program id, owner
  address, ActorId, latest backend or contract response, and the next safe retry.

Known current values, if still valid:
- VARA_ETH_NETWORK=mainnet
- ROBO_MINER_BACKEND_URL=https://api-digger-eth.vara.network
- ROBO_MINER_RES_VMT_PROGRAM_ID=0xa359f125d51684bab99b62e143abdd2ff925120b
- ROBO_MINER_REDEEM_PROGRAM_ID=0xc280544e0fec27c904b90368bc95abbcdb508e64
- VARA_WALLET_ACCOUNT=robo-miner-agent

If the selected world is no longer joinable, go back to discovery and choose a
fresh joinable world.
```
