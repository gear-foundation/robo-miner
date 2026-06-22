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
immediately. Do not install an npm package for this skill and do not use a Robo
Miner helper CLI. The live runtime path is `vara-wallet` for wallet/contract
calls and HTTP requests for backend discovery/rental.

## Backend and Writes

```bash
export VARA_WALLET_ACCOUNT="${VARA_WALLET_ACCOUNT:-robo-miner-agent}"

vara-wallet --chain vara-eth --network mainnet --json vara-eth:wallet show "$VARA_WALLET_ACCOUNT"
curl -fsS https://api-digger-eth.vara.network/api/manifest
curl -fsS https://api-digger-eth.vara.network/api/worlds
curl -fsS 'https://api-digger-eth.vara.network/api/diggers?owner=0x...&season=season-1&status=active'

vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Register --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MoveAgent --args '[2]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Drill --args '[1]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/PlaceLadder --args '[4]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Surface --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network mainnet --account "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MintResources --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
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
DiggerProxy, wait for an active session, play one confirmed action at a time,
and bank/mint/redeem when useful.

Strictly follow the gates:

1. Tooling: verify `curl`, Node, `vara-wallet >= 0.20.3`, and IDL assets.
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
6. Register only through the rented DiggerProxy: call `Digger/Register` with
   `--via injected`. Never call `World/Register` directly.

Write path rule:
For all DiggerProxy state-changing calls after rental, use:
`vara-wallet --chain vara-eth --network mainnet ... call <diggerProgramId> Digger/<Method> ... --via injected`

Do not use `--via eth` for the play loop unless explicitly asked. If `--via eth`
returns `PROMISE_TIMEOUT`, do not assume failure; immediately verify with a
read-only query.

7. Verify registration with `World/AgentOf(agentActorId)`, where `agentActorId`
   is derived from `diggerProgramId`.

Register recovery:
If `Digger/Register` fails because the world is full, already active, closed, or
not joinable:
1. Fetch worlds again.
2. Select a fresh joinable/waiting world.
3. Call `Digger/SetWorld(newWorldActorId)` through the same rented DiggerProxy
   with `--via injected`.
4. Verify `Digger.World`.
5. Retry `Digger/Register`.

8. Wait for session: poll `World/Session`; play only when
   `World.Session().result[2] === 1`.
9. Action loop: before every action, reread `Session`, `AgentOf`, `InventoryOf`,
   and `MapSnapshot`; send exactly one confirmed action through DiggerProxy;
   wait for the result, reread state, and replan.
10. Settlement: when useful, return to surface, then use
   `Surface -> MintResources -> Approve/Redeem` if balances and reserve allow it.

Safety rules:
- Never call `Admin/*`.
- Do not use Robo Miner npm packages, helper CLIs, or local scripts for game
  actions. Use only `vara-wallet` and backend HTTP.
- Do not send multiple unconfirmed transactions at once.
- After registration, chain state is the source of truth.
- Use backend only for discovery and DiggerProxy rental.
- If any gate fails, stop and report the failed gate, world/program id, owner
  address, ActorId, latest backend or contract response, and the next safe retry.

Known current values, if still valid:
- VARA_ETH_NETWORK=mainnet
- ROBO_MINER_BACKEND_URL=https://api-digger-eth.vara.network
- VARA_WALLET_ACCOUNT=robo-miner-agent

If the selected world is no longer joinable, go back to discovery and choose a
fresh joinable world.
```
