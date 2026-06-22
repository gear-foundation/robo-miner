# Wallet and Signing

This reference covers the player wallet, signing path, passphrase handling, and
balance diagnostics for live Robo Miner on Vara.eth. For game actions and
settlement commands, use `workflow.md` and `digger-proxy-interface.md`.

## Runtime Values

Keep these values in local runtime state:

```text
VARA_ETH_NETWORK    = Vara.eth network name: mainnet
VARA_WALLET_ACCOUNT = local vara-wallet account name
PASSPHRASE          = local secret used to unlock the Vara.eth keystore
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

Use `vara-wallet` v0.20.3 or newer from the official
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

If `PASSPHRASE` is missing, ask the user for it and keep it in the current shell
environment:

```bash
if [ -z "${PASSPHRASE:-}" ]; then
  read -rsp "Vara.eth wallet passphrase: " PASSPHRASE
  export PASSPHRASE
  printf "\n"
fi
```

Never print the passphrase, commit it, paste it into logs, or store it in a
tracked repository file. For long-running local sessions, use a secret store,
runtime vault, CI secret, or a local env file that is already ignored by git.

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
vara-wallet vara-eth:wallet create "$VARA_WALLET_ACCOUNT" --passphrase "$PASSPHRASE"
```

Or import an existing wallet once:

```bash
vara-wallet vara-eth:wallet import "$VARA_WALLET_ACCOUNT" --private-key 0x... --passphrase "$PASSPHRASE"
```

Do not run both `create` and `import` for the same account unless the operator
explicitly wants to replace the local keystore.

Show the public EVM address and verify the passphrase:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet show "$VARA_WALLET_ACCOUNT"

vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet keys "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" >/dev/null
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

Do not use helper scripts for signed game actions. Signed live registration,
world switching, game actions, minting, approve, and redeem calls must go
through `vara-wallet`. Use backend HTTP requests with `curl` for discovery and
digger rental.

## Node Runtime Troubleshooting

Before live writes, verify that the active `vara-wallet` can decrypt the
Vara.eth keystore:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" --json \
  vara-eth:wallet keys "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" >/dev/null
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

Every state-changing Robo Miner Sails call must include the wallet account,
passphrase, local IDL, and Vara.eth injected path:

```bash
vara-wallet --chain vara-eth --network "$VARA_ETH_NETWORK" \
  --account "$VARA_WALLET_ACCOUNT" \
  --passphrase "$PASSPHRASE" \
  --json \
  call "$programId" Service/Method \
  --args '[]' \
  --idl "$IDL_PATH" \
  --via injected
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
`Redeem`.

## Minimum Wallet Checklist

- `vara-wallet --version` is v0.20.3 or newer.
- `VARA_ETH_NETWORK` is `mainnet`.
- `vara-eth:wallet show "$VARA_WALLET_ACCOUNT"` returns the expected EVM
  address.
- The passphrase check succeeds with output redirected to `/dev/null`.
- `ownerActorId` is derived from `ownerAddress`.
- Signed writes use `vara-wallet call ... --via injected`.
