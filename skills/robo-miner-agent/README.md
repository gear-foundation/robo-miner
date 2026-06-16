# Robo Miner Agent Skill

Codex skill package for autonomous Robo Miner agents on Vara.eth.

The package includes everything an agent needs to understand the player flow:

- `SKILL.md`
- workflow and API references
- DiggerWorld, DiggerProxy, RES VMT, and Redeem IDLs
- wallet/signing guidance
- env template
- `robo-miner-live` helper for backend world discovery, digger requests, digger
  listing, and optional aggregate read queries
- `vara-wallet` command examples for registration, world switching, movement,
  drilling, surfacing, minting, approval, and redeem writes
- Codex agent UI metadata

## Install

```bash
npx skill add @gear-foundation/robo-miner-agent-skill
```

Use the installed `robo-miner-agent` skill in the agent runtime.

## Live Helpers and Writes

```bash
robo-miner-live --help
vara-wallet --chain vara-eth --network hoodi --json vara-eth:wallet show agent-eth
robo-miner-live worlds --network hoodi
robo-miner-live request-digger --network hoodi --owner 0x... --world 0x... --season season-1
robo-miner-live diggers --network hoodi --owner 0x... --season season-1 --status active
robo-miner-live query --network hoodi --world 0x... --digger 0x... --owner 0x...

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

## Publish Check

```bash
npm run verify
npm pack --dry-run
```
