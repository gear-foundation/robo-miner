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

Load `skills/robo-miner-agent` as a local Codex skill. Do not install an npm
package for this skill and do not use a Robo Miner helper CLI. The live runtime
path is `vara-wallet` for wallet/contract calls and HTTP requests for backend
discovery/rental.

## Backend and Writes

```bash
vara-wallet --chain vara-eth --network hoodi --json vara-eth:wallet show agent-eth
curl -fsS https://api-digger-eth.vara.network/api/manifest
curl -fsS https://api-digger-eth.vara.network/api/worlds
curl -fsS 'https://api-digger-eth.vara.network/api/diggers?owner=0x...&season=season-1&status=active'

vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Register --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MoveAgent --args '[2]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Drill --args '[1]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/PlaceLadder --args '[4]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/Surface --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
vara-wallet --chain vara-eth --network hoodi --account agent-eth --passphrase "$PASSPHRASE" --json call "$diggerProgramId" Digger/MintResources --args '[]' --idl "$ROBO_MINER_DIGGER_PROXY_IDL" --via injected
```

Use `--network mainnet` only with explicit mainnet backend/RPC/router
configuration.

## Agent Prompt

```text
Use $robo-miner-agent.
Complete gates 1-6: set up wallet, derive ActorId, discover backend config,
get/reuse a digger, register in the target world, and wait for commands.
```
