# Wallet and Signing

This reference covers the player wallet, signing path, passphrase handling, and
balance diagnostics for live Robo Miner on Vara.eth. For game actions and
settlement commands, use `workflow.md` and `digger-proxy-interface.md`.

## Runtime Values

Keep these values in local runtime state:

```text
VARA_ETH_NETWORK    = Vara.eth network name: mainnet
VARA_WALLET_ACCOUNT = local vara-wallet account name
ownerAddress        = EVM address from vara-eth:wallet show, 20 bytes
ownerActorId        = 0x + 12 zero bytes + ownerAddress without 0x
```

After Gate 4, also keep:

```text
diggerProgramId = backend-rented DiggerProxy program id
agentActorId    = 0x + 12 zero bytes + diggerProgramId without 0x
```

Gate 2 is complete only when `ownerAddress` and `ownerActorId` are known.
`agentActorId` is not known until a digger has been rented or reused.

## Verify `vara-wallet`

Use `vara-wallet` v0.20.5 or newer from the official
`gear-foundation/vara-wallet` releases.

```bash
node --version
vara-wallet --version
vara-wallet --chain vara-eth --network "${VARA_ETH_NETWORK:-mainnet}" --help
```

Always select the Vara.eth rail explicitly for live calls:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json <command>
```

Use `mainnet` for Robo Miner production.

## Passphrase Handling

The action runner never receives a passphrase argument. `vara-wallet` v0.20.5
requires a passphrase to create a Vara.eth wallet; provide it only through a
one-time secure provisioning process using `--passphrase` or
`VARA_PASSPHRASE`. After creation, store it in the local `0600` per-wallet or
global passphrase file so later named-wallet calls, including
`vara-eth:session`, resolve it automatically.

For an existing keystore that was encrypted with a separately supplied secret,
provision that secret out of band in the secure per-wallet file
`~/.vara-wallet/passphrases/<wallet>.passphrase` (or the global
`~/.vara-wallet/.passphrase`) before starting the agent. Keep the containing
directory private and each passphrase file mode `0600`.

Never print the passphrase, commit it, paste it into logs, put it in the agent
environment template, or forward it on a `vara-wallet` command line. A secret
manager or provisioning process may write the local passphrase file before the
runner starts.

If a command fails with `WRONG_PASSPHRASE`, stop and ask the user for the
correct local wallet passphrase. Do not try secrets from unrelated wallets.

## Create or Load Wallet

Set the local account and network:

```bash
export VARA_ETH_NETWORK="${VARA_ETH_NETWORK:-mainnet}"
export VARA_WALLET_ACCOUNT="${VARA_WALLET_ACCOUNT:-robo-miner-agent}"
```

Create a new wallet once:

```bash
vara-wallet vara-eth:wallet create "$VARA_WALLET_ACCOUNT"
```

Or import an existing wallet once:

```bash
vara-wallet vara-eth:wallet import "$VARA_WALLET_ACCOUNT" --private-key 0x...
```

Do not run both `create` and `import` for the same account unless the operator
explicitly wants to replace the local keystore.

Show the public EVM address and verify the passphrase:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet show "$VARA_WALLET_ACCOUNT"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet keys "$VARA_WALLET_ACCOUNT" \
  >/dev/null
```

`vara-eth:wallet keys` can print the private key if stdout is not redirected.
Use it only as a local passphrase check, redirect it to `/dev/null`, and never
capture it in logs.

Derive the backend owner address and contract ActorId:

```bash
ownerAddress="$(vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet show "$VARA_WALLET_ACCOUNT" | jq -r '.address')"
ownerActorId="0x000000000000000000000000${ownerAddress#0x}"
```

If `jq` is unavailable, read the `address` field from the JSON output of
`vara-eth:wallet show` and set `ownerAddress` manually.

Use `ownerAddress` for backend rental APIs. Use `ownerActorId` for Sails calls
that require an ActorId.

Do not use helper CLIs or arbitrary scripts for signed game actions. The
reviewed bundled `scripts/robo-miner-action.sh` is the exception for supported
DiggerProxy registration, world switching, and play-loop actions; it delegates
each signed call to `vara-wallet`. VMT approve and redeem calls go directly
through `vara-wallet`. Use backend HTTP requests with `curl` for discovery and
digger rental.

## Persistent Vara.eth Agent Session

For a low-latency agent loop, keep the named wallet inside one `vara-wallet`
process rather than exporting it to a runner:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" vara-eth:session
```

The command reads NDJSON requests from stdin and writes NDJSON responses. A
request has `id`, `program`, `method` (`Service/Method`), `args` (array), and
optional `idl`. Functions use injected submission and return their stable
`txHash`/`messageId`; queries return decoded Sails results. Keep stdin open for
the session lifetime so the API connection and decrypted signer are reused.
Never substitute `wallet keys`, `wallet export --decrypt`, or `PRIVATE_KEY` for
this protocol. The bundled `robo_miner_action` helper starts and reuses this
session automatically for its default `submitted` path; call
`robo_miner_session_stop` after a long-running shell loop. Set
`ROBO_MINER_SESSION_MODE=off` only for legacy diagnostics.

## Node Runtime Troubleshooting

Before live writes, verify that the active `vara-wallet` can decrypt the
Vara.eth keystore:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet keys "$VARA_WALLET_ACCOUNT" \
  >/dev/null
```

If that command fails with `ERR_REQUIRE_ESM`, use a modern Node 22 runtime for
`vara-wallet` and repeat the key check. The known working local workaround is an
nvm-managed Node 22 runtime.

```bash
# If nvm is available:
nvm use 22
node --version
vara-wallet --version
```

Keep the same working Node/PATH in place for every `vara-wallet` state-changing
command.

## ActorId Format

Expected ActorId for owner `0xf823ba3f10922dcca6970d1e012d8701f462aa33`:

```text
0x000000000000000000000000f823ba3f10922dcca6970d1e012d8701f462aa33
```

Use this 32-byte form when contract calls require an ActorId. Use the original
20-byte EVM address when talking to the backend rental API.

## Signing Rule

Source the bundled action helper after the runtime values and IDL paths are set:

```bash
source "$ROBO_MINER_SKILL_ROOT/scripts/robo-miner-action.sh"
```

For supported DiggerProxy calls, use `robo_miner_action` instead of repeating
the complete signed command. It verifies `vara-wallet >= 0.20.5`, submits on
the injected rail through the persistent session, and proves the expected
on-chain state before it returns success. It selects the named Vara.eth wallet and lets
`vara-wallet` resolve its passphrase from the secure per-wallet or global
passphrase file, so the passphrase is not forwarded as a command argument:

```bash
robo_miner_action Digger/MoveAgent '[2]'
```

Read-only calls do not need `--account`, `--passphrase`, or `--via injected`.

## Balance and Fuel Diagnostics

The backend deploys the DiggerProxy, funds its initial executable balance, and
may refill it on the backend's daily schedule. Separately, a player can convert
earned resources to WVARA through the settlement path:

```text
Surface -> MintResources -> Redeem
```

If a write fails with a balance or fuel-like error, classify the failure before
acting:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Owner \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/World \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  call "$diggerProgramId" Digger/Status \
  --args '[]' \
  --idl "$ROBO_MINER_DIGGER_PROXY_IDL"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  balance "$diggerProgramId"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wvara balance "$ownerAddress"
```

If `Digger/Owner` does not equal `ownerActorId`, stop because this wallet does
not own the proxy. If `Digger/World` does not equal the selected world ActorId,
request or reuse a digger for the correct world.

If the proxy executable balance is depleted, report the balance/fuel gate
failure and wait for backend refill or operator action. Do not call world
`Admin/*`, do not use admin top-up methods, and do not transfer operator funds.

If the owner wallet is short on WVARA but the agent has banked resources, use
the player settlement flow from `workflow.md` to `Surface`, `MintResources`, and
`Redeem`. Before estimating payout or choosing redeem amounts, query the live
redeem contract for `Redeem/ScrstRate`, `Redeem/BcrstRate`,
`Redeem/HcrstRate`, `Redeem/VaraUnit`, and `Redeem/AvailableReserve`; never use
hard-coded resource-to-WVARA rates.

## Minimum Wallet Checklist

- `vara-wallet --version` is v0.20.5 or newer.
- `VARA_ETH_NETWORK` is `mainnet`.
- `vara-eth:wallet show "$VARA_WALLET_ACCOUNT"` returns the expected EVM
  address.
- The passphrase-file-based key check succeeds with output redirected to
  `/dev/null`.
- `ownerActorId` is derived from `ownerAddress`.
- Signed DiggerProxy writes use `robo_miner_action`, which delegates to the
  named-wallet `vara-eth:session` injected-submission path.
