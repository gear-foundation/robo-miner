## The **digger-res-vmt** program

Program **digger-res-vmt** for the Digger Vara.eth campaign, written in [Sails](https://github.com/gear-tech/sails) with the `ethexe` feature enabled.

This contract is the separate RES VMT token contract. It holds banked player resources as one multi-token collection and burns them only when the configured `digger-redeem` reserve contract requests a redeem burn.

The contract implements:

- one VMT-style token collection with resource token ids:
  - `SCRST_ID = 0`
  - `BCRST_ID = 1`
  - `HCRST_ID = 2`
- `vmt.mint_resources(to, scrst, bcrst, hcrst)`, callable only by the configured minter;
- `vmt.transfer_from(from, to, id, amount)` and `vmt.batch_transfer_from(from, to, ids, amounts)`;
- `vmt.approve(operator)` and `vmt.is_approved(account, operator)` for operator transfers;
- `vmt.balance_of(account, id)` and `vmt.total_supply_of(id)`;
- `vmt.burn_for_redeem(redeem_id, owner, scrst, bcrst, hcrst)`, callable only by the configured redeem contract;
- an outbound `confirm_redeem(redeem_id)` callback after burn, or `cancel_redeem(redeem_id)` when the owner lacks enough RES;
- admin controls for minter updates, redeem contract updates, pause, and unpause.

### Roles

- `admin`: deployer/controller that can update the minter, update the redeem contract, pause, and unpause.
- `minter`: trusted actor that can mint extracted RES to players.
- `redeem_contract`: the only actor allowed to call `burn_for_redeem`.
- `player`: owns VMT balances and can transfer RES or approve an operator.

### Token ids

| Resource | Token id |
| --- | ---: |
| `SCRST` | `0` |
| `BCRST` | `1` |
| `HCRST` | `2` |

`balance_of(account, id)` and `total_supply_of(id)` are per-resource. There is intentionally no aggregate total supply across all resources in the Solidity-facing ABI.

### Mint Flow

```text
trusted minter
  -> vmt.mint_resources(player, scrst, bcrst, hcrst)
  -> balances[player][SCRST_ID/BCRST_ID/HCRST_ID] increase
  -> total_supply_of(id) increases per token id
  -> Minted(player, scrst, bcrst, hcrst)
```

The call fails if the caller is not the configured minter, the recipient is zero, all amounts are zero, or the contract is paused.

### Transfer Flow

Players can transfer one resource with `transfer_from(from, to, id, amount)` or several resources with `batch_transfer_from(from, to, ids, amounts)`.

The caller must be either `from` or an approved operator. `approve(operator)` grants whole-account operator access for all three resource token ids.

Successful transfers emit:

- `Transfer(from, to, id, amount)` for a single token id;
- `BatchTransfer(from, to)` for a batch transfer.

### Redeem Burn Flow

`digger-res-vmt` does not pay VARA. It only burns RES after `digger-redeem` has created and locked a pending redeem.

```text
digger-redeem
  -> vmt.burn_for_redeem(redeem_id, player, scrst, bcrst, hcrst)
  -> check caller == configured redeem_contract
  -> check player has enough RES for every requested token id
  -> on success:
       burn player RES
       emit Burned(player, scrst, bcrst, hcrst)
       send confirm_redeem(redeem_id) to digger-redeem
  -> on failure:
       leave player RES unchanged
       emit RedeemBurnRejected(redeem_id, player, scrst, bcrst, hcrst)
       send cancel_redeem(redeem_id) to digger-redeem
```

`redeem_id` is passed through unchanged. It is owned by `digger-redeem` and is used there to find the locked payout and pending player operation.

### Campaign Flow

1. The world/game logic decides how much banked RES a player earned after a successful surface.
2. The configured minter calls `vmt.mint_resources(player, scrst, bcrst, hcrst)`.
3. The player later calls `digger-redeem.redeem(scrst, bcrst, hcrst)` for the exact amount they want to exchange.
4. `digger-redeem` asks this contract to burn the player's RES.
5. This contract confirms or cancels the pending redeem back to `digger-redeem`.

### Admin Flow

Admin actions emit explicit events for indexers and UIs:

- `add_admin(new_admin)` -> `AdminAdded(new_admin)`;
- `remove_admin(admin)` -> `AdminRemoved(admin)`;
- `add_minter(new_minter)` -> `MinterAdded(new_minter)`;
- `remove_minter(minter)` -> `MinterRemoved(minter)`;
- `set_redeem_contract(new_redeem_contract)` -> `RedeemContractUpdated(old, new)`;
- `pause()` -> `Paused(admin)`;
- `unpause()` -> `Unpaused(admin)`.

### Building

```bash
cargo build --release
```

Expected Vara.eth artifacts:

- `target/wasm32-gear/release/digger_res_vmt.wasm`
- `target/wasm32-gear/release/digger_res_vmt.opt.wasm`
- `target/wasm32-gear/release/digger_res_vmt.idl`

### IDL Consumers

After changing any public service, event, constructor, or return type, rebuild
the release artifacts and refresh downstream consumers:

- `frontend/src/chain/digger_res_vmt.idl` must match
  `contracts/target/wasm32-gear/release/digger_res_vmt.idl`;
- `backend/src/modules/indexer/idlRegistry.js` reads the release IDL directly;
- `contracts/l1-adapter/src/generated` should be regenerated if the L1 adapter
  is being compiled against the new interface.

Frontend guard:

```bash
cd frontend
npm run check:idl
```

### Testing

```bash
cargo test --release
```
