## Digger L1 Adapter Spike

This package is the first L1/Mirror spike for surfacing Digger RES VMT balances as ERC-20 tokens and redeeming them through an async Vara.eth-backed flow.

The important invariant is:

```text
L1 wrapper supply is minted only after the VMT Mirror confirms that the Vara-side vault balance was minted.
```

The adapter treats Vara.eth calls as asynchronous:

1. Store `messageId -> Operation`.
2. Accept callbacks only from the trusted Mirror contract.
3. Delete pending state exactly once on success or error.
4. Complete local L1 accounting only after a callback.

### Contracts

- `src/DiggerL1Adapter.sol`
  - owns three ERC-20 wrapper tokens: `SCRST`, `BCRST`, `HCRST`;
  - calls `digger-res-vmt.vmt.MintResources(...)` through the VMT Mirror;
  - calls `digger-redeem.redeem.Redeem(...)` through the redeem Mirror;
  - stores every async operation by `messageId`;
  - credits redeem payouts as pull-style `claimable` ETH.
- `src/ResourceToken.sol`
  - minimal zero-decimal ERC-20 used by the adapter.
- `src/mocks/*`
  - Foundry mocks for the Mirror callback lifecycle.

### Mint Flow

```text
owner/requester
  -> DiggerL1Adapter.requestMint(user, scrst, bcrst, hcrst)
  -> VMT Mirror vmtMintResources(callReply=true, address(adapter), amounts)
  -> pending[messageId] = Mint(...)
  -> Mirror callback replyOn_vmtMintResources(messageId)
  -> adapter mints L1 SCRST/BCRST/HCRST to user
```

For the real deployment, the `digger-res-vmt` minter should be the adapter/Mirror-side ActorId. The adapter mints Vara-side RES to itself, then later calls `redeemRedeem` from the same actor, so Vara-side burn ownership matches the minted holder.

### Redeem Flow

```text
user
  -> DiggerL1Adapter.requestRedeem(scrst, bcrst, hcrst)
  -> adapter burns user's L1 wrapper tokens
  -> adapter reserves L1 payout
  -> redeem Mirror redeemRedeem(callReply=true, amounts)
  -> pending[messageId] = Redeem(...)
  -> Mirror callback replyOn_redeemRedeem(messageId, payout)
  -> adapter credits claimable ETH
  -> user withdrawClaim()
```

On Mirror error, the adapter re-mints the burned wrapper tokens to the user and unreserves the payout.

Payouts use the same unit scale and rates as the deployed `digger-redeem`
program. Pass `varaUnit`, `scrstRate`, `bcrstRate`, and `hcrstRate` into the
adapter constructor from the same config used for `digger-redeem.Create`; this
keeps `quoteRedeem` aligned with `replyOn_redeemRedeem`.

### Current Spike Boundary

The adapter imports the generated Sails Solidity ABI wrappers from `src/generated` and uses these methods:

- `vmtMintResources(bool callReply, address to, uint128 scrst, uint128 bcrst, uint128 hcrst)`
- `redeemRedeem(bool callReply, uint128 scrst, uint128 bcrst, uint128 hcrst)`
- success callbacks:
  - `replyOn_vmtMintResources(bytes32 messageId)`
  - `replyOn_redeemRedeem(bytes32 messageId, uint128 payout)`
- error callback:
  - `onErrorReply(bytes32 messageId, bytes payload, bytes4 replyCode)`

Regenerate the Solidity ABI contracts from the current Sails IDL after any Sails ABI change:

```sh
cargo sails sol --idl-path ../digger-res-vmt/client/digger_res_vmt_client.idl --target-dir src/generated --contract-name DiggerResVmtMirror
cargo sails sol --idl-path ../digger-redeem/client/digger_redeem_client.idl --target-dir src/generated --contract-name DiggerRedeemMirror
```

Use a Sails CLI version compatible with the contracts' IDL version. These wrappers were generated with `sails-cli 1.0.0-beta.5`. The older `sails-cli 0.10.x` cannot parse the current IDL v2 format.

### Tests

```sh
forge test --offline
```

Covered:

- mint is pending until VMT callback;
- mint error clears pending state without minting;
- callback sender must be the trusted Mirror;
- unknown message callbacks are rejected;
- redeem burns L1 wrappers and credits claimable payout on success;
- redeem error refunds burned wrappers and unreserves payout;
- callback payout must match the locally reserved payout;
- adapter cannot over-reserve the L1 redeem vault;
- adapter emits request, confirm, failure, and withdrawal events for the L1 flow.

### Live Mirror Smoke Checklist

Run this before treating the spike as network-ready:

1. Deploy or attach the current `digger-res-vmt` and `digger-redeem` programs.
2. Regenerate Solidity wrappers from the exact deployed IDLs and confirm the adapter still compiles.
3. Deploy `DiggerL1Adapter` with the real RES VMT Mirror, redeem Mirror, and
   the live redeem `varaUnit/scrstRate/bcrstRate/hcrstRate` values.
4. Configure `digger-res-vmt` so the Mirror-side actor used by the adapter can mint to the adapter actor.
5. Configure `digger-redeem` with the deployed RES VMT program and fund its VARA reserve.
6. Call `requestMint`, wait for `replyOn_vmtMintResources`, and verify:
   - `MintRequested` and `MintConfirmed` are emitted;
   - Vara-side RES balance increased for the adapter actor;
   - L1 wrapper balances are minted only after callback.
7. Call `requestRedeem`, wait for `replyOn_redeemRedeem`, and verify:
   - L1 wrappers are burned before callback;
   - `RedeemRequested` and `RedeemConfirmed` are emitted;
   - `claimable(user)` equals the payout returned by redeem;
   - `withdrawClaim` transfers ETH and emits `ClaimWithdrawn`.
8. Force or simulate Mirror failure for both paths and verify:
   - mint failure leaves no L1 wrappers;
   - redeem failure refunds wrappers and releases reserved payout;
   - `OperationFailed` includes the reply code and payload.
