# Wallet and Signing

This skill needs a persistent player identity. For current Robo Miner live
matches, the backend rental API expects an EVM-style owner address
(`0x` + 20 bytes). Contract state often uses the corresponding 32-byte ActorId.

## Required Identity Values

Keep these values in local runtime state:

```text
ownerAddress   = EVM address, 20 bytes, starts with 0x
ownerActorId   = 0x + 12 zero bytes + ownerAddress without 0x
agentActorId   = DiggerProxy ActorId in proxy mode, ownerActorId in direct mode
private key    = local secret only; never print or paste into chat
```

Gate 2 is not complete until `ownerAddress` and `ownerActorId` are known.

## `vara-wallet` Role

Install:

```bash
npm install -g vara-wallet
vara-wallet --version
```

Use `vara-wallet` for:

- wallet lifecycle when compatible with the target network;
- read-only Sails calls and diagnostics with bundled IDLs;
- event watching and message inspection;
- balance/program checks.

Do not assume a native/SS58 wallet address from `vara-wallet wallet list` is the
same thing as the EVM owner address used by the backend rental API. If the
runtime shows a native address like `kG...`, keep it for native diagnostics, but
use an EVM signer for Vara.eth injected transactions and `/api/diggers/request`.

## Vara.eth EVM Signer

The repo scripts use an EVM private key with `viem` and `@vara-eth/api`.
Standalone runners should use the same signing model unless the operator
provides a different signer.

Install standalone dependencies:

```bash
npm install @vara-eth/api @vara-eth/viem sails-js dotenv tsx typescript
```

Local env template:

```bash
cp skills/robo-miner-agent/assets/examples/agent.env.example .env
chmod 600 .env
```

Set `PRIVATE_KEY` only through a local secret store, protected `.env`, CI secret,
or runtime vault. Never commit it, print it, or include it in messages.

## ActorId Helper

Use the bundled helper:

```bash
node skills/robo-miner-agent/scripts/actor-id.mjs 0xf823ba3F10922DCca6970D1e012D8701f462Aa33
```

Expected ActorId:

```text
0x000000000000000000000000f823ba3f10922dcca6970d1e012d8701f462aa33
```

The helper also accepts a 32-byte ActorId and returns the embedded EVM address
when the first 12 bytes are zero.

## Balance and Fuel

Player agents do not top up worlds. In the live rental flow, the backend deploys
and funds the DiggerProxy executable balance. If calls fail because of fuel or
balance:

1. Re-check `/api/diggers?owner=...&world=...&season=...&status=active`.
2. Query the digger/program balance if tooling supports it.
3. Report the balance/fuel gate failure.
4. Do not call world `Admin/*` or transfer operator funds.

## Minimum Signing Checklist

- `ownerAddress` is a valid 20-byte EVM address.
- `ownerActorId` is derived and stable.
- The signer can submit a harmless dry-run or read-only call.
- Backend `/api/diggers/request` accepts `ownerAddress`.
- The chosen world/digger ids are never hardcoded when discovery provides them.
