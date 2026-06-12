## The **digger-redeem** program

[![Build Status](https://github.com/gear-tech/digger-redeem/workflows/CI/badge.svg)](https://github.com/gear-tech/digger-redeem/actions)

Program **digger-redeem** for the Digger Vara.eth campaign, written in [Sails](https://github.com/gear-tech/sails) with the `ethexe` feature enabled.

This contract is the VARA redeem reserve and the player-facing exchange entrypoint. RES balances live in the separate `digger-res-vmt` VMT contract.

- redeem rate config is required constructor configuration: `vara_unit`, `scrst_rate`, `bcrst_rate`, `hcrst_rate`;
- `vara_unit` is the number of minimal units in `1` display VARA. On Vara.eth this is normally `1_000_000_000_000`;
- resource rates are stored as display VARA values, for example `66`, `330`, `1650`;
- an admin-funded VARA reserve through `redeem.deposit_reserve` (`payable`);
- direct VARA transfers to the program id are also counted as reserve on the next call;
- `redeem.redeem(scrst, bcrst, hcrst)`, called by the player with the RES amount they want to exchange;
- an internal pending redemption flow: `digger-redeem` locks reserve, asks `digger-res-vmt.vmt.burn_for_redeem` to burn RES VMT balances, then pays only after `confirm_redeem`;
- `confirm_redeem` and `cancel_redeem`, callable only by the configured RES contract;
- admin controls for pause/unpause, rate updates, RES contract updates, reserve withdrawal, and manual stuck-pending recovery.

The user-facing flow is:

1. The admin deploys `digger-redeem`, then deploys `digger-res-vmt`.
2. The admin sets `digger-redeem.admin.set_res_contract(digger_res_vmt_program_id)`.
3. The admin deposits reserve VARA through `redeem.deposit_reserve` or transfers VARA directly to the program id.
4. The player calls `digger-redeem.redeem.redeem(scrst, bcrst, hcrst)`.
5. `digger-redeem` locks the calculated VARA payout and sends `vmt.burn_for_redeem` to `digger-res-vmt`.
6. `digger-res-vmt` checks and burns the player's RES VMT balances.
7. `digger-res-vmt` calls `confirm_redeem` after a successful burn, or `cancel_redeem` if the burn fails.
8. `digger-redeem` pays fixed-rate VARA only after `confirm_redeem`.

### Roles

- `admin`: deployer/controller that can configure the RES contract, update rates, pause/unpause, and withdraw unlocked reserve.
- `res_contract`: the only actor allowed to call `confirm_redeem` and `cancel_redeem`.
- `player`: calls `redeem(scrst, bcrst, hcrst)` to exchange already banked RES for VARA.

### Rates And Reserve

Rates and `vara_unit` are constructor configuration:

| Config | Value |
| --- | ---: |
| `vara_unit` | `1000000000000` |
| `SCRST` rate | `66` |
| `BCRST` rate | `330` |
| `HCRST` rate | `1650` |

The payout formula is:

```text
payout =
  scrst * scrst_rate * vara_unit
  + bcrst * bcrst_rate * vara_unit
  + hcrst * hcrst_rate * vara_unit
```

For example, `redeem(20, 0, 0)` with the SCRST rate above pays
`20 * 66 * 1000000000000 = 1320000000000000`, which displays as `1320 VARA`.

`deposit_reserve()` is payable and increases the program's available VARA reserve. Direct transfers to the program id are also counted on the next reserve sync.

The contract tracks:

- `reserve_balance`: VARA available for new redeems after accounting sync;
- `locked_balance`: VARA reserved by pending redeems that are waiting for RES burn confirmation;
- `total_paid`: cumulative confirmed payout;
- per-resource redeemed totals.

Admin withdrawals can only use unlocked reserve. Pending redeem payouts cannot be withdrawn through `withdraw_funds`; use the force recovery methods below only when a redeem is known to be stuck.

### Redeem State Machine

```text
player
  -> redeem(scrst, bcrst, hcrst)
  -> validate non-zero amounts and reserve >= payout
  -> create redeem_id
  -> store pending[redeem_id] = player, amounts, payout
  -> reserve_balance -= payout
  -> locked_balance += payout
  -> emit RedeemRequested(redeem_id, player, amounts, payout)
  -> send digger-res-vmt.vmt.burn_for_redeem(redeem_id, player, amounts)
```

Successful burn callback:

```text
digger-res-vmt
  -> confirm_redeem(redeem_id)
  -> check caller == configured res_contract
  -> remove pending redeem
  -> locked_balance -= payout
  -> transfer payout VARA to player
  -> update totals
  -> emit Redeemed(player, amounts, payout)
```

Failed burn callback:

```text
digger-res-vmt
  -> cancel_redeem(redeem_id)
  -> check caller == configured res_contract
  -> remove pending redeem
  -> locked_balance -= payout
  -> reserve_balance += payout
  -> emit RedeemCanceled(redeem_id, player, amounts, payout)
```

`redeem_id` is required because the burn happens through a second contract and the reply comes later. It is the correlation key that prevents a callback from paying or canceling the wrong pending operation.

Manual admin recovery for stuck pending redeems:

```text
admin
  -> force_cancel_redeem(redeem_id)
  -> check caller is admin
  -> remove pending redeem
  -> locked_balance -= payout
  -> reserve_balance += payout
  -> emit PendingRedeemForceCanceled(redeem_id, player, amounts, payout)
```

```text
admin
  -> force_pay_redeem(redeem_id)
  -> check caller is admin
  -> remove pending redeem
  -> locked_balance -= payout
  -> total_paid += payout and redeemed totals += amounts
  -> transfer payout VARA to the admin caller
  -> emit PendingRedeemForcePaid(redeem_id, player, amounts, payout)
```

Use `force_cancel_redeem` when the RES burn did not complete and the locked payout should return to available reserve. Use `force_pay_redeem` only when the operator has verified that the player-side redeem should be treated as paid; the payout is sent to the admin caller so the operator can manually settle the stuck case off-chain or through a separate transfer.

### Admin Flow

Admin actions emit explicit events:

- `set_res_contract(new_res_contract)` -> `ResContractUpdated(old, new)`;
- `set_rates(scrst_rate, bcrst_rate, hcrst_rate)` -> `RatesUpdated(scrst_rate, bcrst_rate, hcrst_rate)`;
- `set_rate_config(vara_unit, scrst_rate, bcrst_rate, hcrst_rate)` -> `RateConfigUpdated(vara_unit, scrst_rate, bcrst_rate, hcrst_rate)`;
- `pause()` -> `Paused(admin)`;
- `unpause()` -> `Unpaused(admin)`;
- `withdraw_funds(amount)` -> `FundsWithdrawn(admin, amount, reserve_after)`;
- `force_cancel_redeem(redeem_id)` -> `PendingRedeemForceCanceled(redeem_id, player, scrst, bcrst, hcrst, payout)`;
- `force_pay_redeem(redeem_id)` -> `PendingRedeemForcePaid(redeem_id, player, scrst, bcrst, hcrst, payout)`.

Pause blocks new redeems. It does not slash or mutate already banked RES balances in `digger-res-vmt`. Force recovery also does not call `digger-res-vmt`; it only clears the local pending redeem record and locked VARA accounting.

### Events

The redeem service emits:

- `ReserveDeposited(admin, amount, reserve_after)`;
- `ReserveSynced(previous, current)` when direct top-ups are observed;
- `RedeemRequested(redeem_id, player, scrst, bcrst, hcrst, payout)`;
- `Redeemed(player, scrst, bcrst, hcrst, payout)`;
- `RedeemCanceled(redeem_id, player, scrst, bcrst, hcrst, payout)`.

The program workspace includes the following packages:
- `digger-redeem` is the package allowing to build WASM binary for the program and IDL file for it.
  The package also includes integration tests for the program in the `tests` sub-folder
- `digger-redeem-app` is the package containing business logic for the program represented by the `DiggerRedeem` structure.

### 🏗️ Building

```bash
cargo build --release
```

Expected Vara.eth artifacts:

- `target/wasm32-gear/release/digger_redeem.wasm`
- `target/wasm32-gear/release/digger_redeem.opt.wasm`
- `target/wasm32-gear/release/digger_redeem.idl`

### IDL Consumers

After changing any public service, event, constructor, or return type, rebuild
the release artifacts and refresh downstream consumers:

- `frontend/src/chain/digger_redeem.idl` must match
  `contracts/target/wasm32-gear/release/digger_redeem.idl`;
- `backend/src/modules/indexer/idlRegistry.js` reads the release IDL directly;
- `contracts/l1-adapter/src/generated` should be regenerated if the L1 adapter
  is being compiled against the new interface.

Frontend guard:

```bash
cd frontend
npm run check:idl
```

### ✅ Testing

```bash
cargo test --release
```

# License

The source code is licensed under the [MIT license](LICENSE).
