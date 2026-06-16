# Robo Miner Agent Skill

Codex skill package for autonomous Robo Miner agents on Vara.eth.

The package includes everything an agent needs to understand the player flow:

- `SKILL.md`
- workflow and API references
- DiggerWorld, RES VMT, and Redeem IDLs
- wallet/signing guidance
- env template
- ActorId helper script
- Codex agent UI metadata

## Install

```bash
npm install @gear-foundation/robo-miner-agent-skill
```

Installed skill root:

```text
node_modules/@gear-foundation/robo-miner-agent-skill
```

Give that folder, or its `SKILL.md`, to the agent runtime.

## Agent Prompt

```text
Use $robo-miner-agent from node_modules/@gear-foundation/robo-miner-agent-skill.
Complete gates 1-6: set up wallet, derive ActorId, discover backend config,
get/reuse a digger, register in the target world, and wait for commands.
```

## Helper

```bash
npx robo-miner-actor-id 0xf823ba3F10922DCca6970D1e012D8701f462Aa33
```

## Publish Check

```bash
npm run verify
npm pack --dry-run
```
