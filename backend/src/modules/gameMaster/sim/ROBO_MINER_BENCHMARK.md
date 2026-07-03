# Robo Miner local Vara.eth benchmark runbook

This runbook is for an operator/tester who already has an `ethexe` node running
and wants to deploy one DiggerWorld, register deterministic test agents, let
them mine, and measure:

- DiggerWorld executable balance spent in VARA.
- Number and type of game actions.
- Resources mined, carried, and banked.
- L1 Router gas paid by the validator/committer.
- Approximate ETH/USD cost for several gas-price assumptions.

The runner uses direct injected transactions into DiggerWorld. It is meant for
local/dev benchmarks, not for the public rented DiggerProxy player flow.

## 1. Build Robo Miner contracts

From the repository root:

```bash
cd contracts
cargo build --release
```

The benchmark deploy script expects this artifact:

```txt
contracts/target/wasm32-gear/release/digger_world.opt.wasm
```

The default IDL path used below is:

```txt
skill-pack/assets/idl/digger_world.idl
```

If the contract interface changes, rebuild contracts before benchmarking.

## 2. Start or connect to the test node

If the tester is using a local optimized `ethexe` build, a typical command is:

```bash
/path/to/ethexe --cfg none run --dev --tmp \
  --block-time 6 \
  --rpc-port 9944 \
  --no-network \
  --uncommitted-chain-len-threshold 500 \
  --commitment-delay-limit 16
```

For mainnet-like quarantine testing, use the node flags required by the tested
branch, for example:

```bash
/path/to/ethexe --cfg none run --dev --tmp \
  --block-time 6 \
  --rpc-port 9944 \
  --no-network \
  --canonical-quarantine 8
```

The local dev EVM RPC is usually:

```txt
http://127.0.0.1:8545
```

The Vara.eth websocket is usually:

```txt
ws://127.0.0.1:9944
```

The local dev Router is often deterministic:

```txt
0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9
```

Verify it has code:

```bash
cast code 0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9 \
  --rpc-url http://127.0.0.1:8545
```

If this returns `0x`, take the Router address from the node startup logs.

## 3. Export benchmark environment

Use the standard funded Anvil account for local dev. Do not use a real/private
testnet key for this local benchmark unless the node is actually connected to a
remote network.

```bash
cd backend

export CHAIN_NETWORK=testnet
export TESTNET_ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export ETH_RPC=http://127.0.0.1:8545
export VARA_ETH_WS=ws://127.0.0.1:9944
export ROUTER_ADDRESS=0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9
export DIGGER_IDL_PATH="$PWD/../skill-pack/assets/idl/digger_world.idl"

# Initial DiggerWorld executable balance. Increase if a full-world run runs out.
export DIGGER_TOP_UP=5000000000000000
```

Optional: pin the map seed so optimized/master runs use the same world layout.

```bash
export DIGGER_SEED=1003311753
```

## 4. Deploy a fresh DiggerWorld

```bash
node src/modules/gameMaster/sim/deploy-world.js | tee /tmp/robo-deploy.log
```

Copy the printed world id:

```txt
[deploy] NEW WORLD = 0x...
```

Then:

```bash
export ROBO_WORLD=0x...
```

The deploy output also prints `seed` and `hash`. Keep them in the final report.

## 5. Register agents and start the session

This registers deterministic agents derived from:

```txt
digger-agent:<WORLD_ID>:<index>
```

and starts the session. Use `maxActions=0` here because the actual mining run is
done by `cluster-world.js`.

```bash
BENCHMARK_RESET=false \
BENCHMARK_DELAY_MS=0 \
BENCHMARK_SETTLE_MS=0 \
BENCHMARK_TIMEOUT_MS=180000 \
node src/modules/gameMaster/sim/benchmark-world.js "$ROBO_WORLD" 10 0
```

Expected result:

```txt
status=1 active=10 dead=0 left=100(77/19/4) ladders=500
```

## 6. Record L1 start block

Do this immediately before the mining run:

```bash
export FROM_BLOCK=$(cast block-number --rpc-url "$ETH_RPC" | tail -n 1)
echo "$FROM_BLOCK"
```

## 7. Run the mining benchmark

This run uses a high safety cap, but the real stop condition is: no plausible
cluster action remains. `ROBO_CLUSTER_FINAL_RETURN=1` makes agents with carried
resources return to the surface at the end.

```bash
ROBO_OUTPUT_DIR=/tmp \
ROBO_CLUSTER_MAX_CONFIRMED=20000 \
ROBO_CLUSTER_MAX_SENDS=24000 \
ROBO_CLUSTER_CONCURRENCY=10 \
ROBO_CLUSTER_RETURN_LOAD=10 \
ROBO_CLUSTER_RECONCILE_EVERY=8 \
ROBO_CLUSTER_POLL_TIMEOUT_MS=180000 \
ROBO_CLUSTER_POLL_INTERVAL_MS=1000 \
ROBO_CLUSTER_CALL_TIMEOUT_MS=180000 \
ROBO_CLUSTER_FINAL_RETURN=1 \
ROBO_CLUSTER_LADDER_BUFFER=8 \
ROBO_CLUSTER_VALUE_WEIGHT=0.35 \
ROBO_CLUSTER_ACTION_COST_VARA=0.30 \
ROBO_CLUSTER_DEEPEN_FIRST_DEPTH=52 \
node src/modules/gameMaster/sim/cluster-world.js "$ROBO_WORLD" 10 \
  2>&1 | tee /tmp/cluster-drain.log
```

Important knobs:

- `ROBO_CLUSTER_RETURN_LOAD=10`: return only with a full backpack, unless the
  agent has no useful continuation.
- `ROBO_CLUSTER_DEEPEN_FIRST_DEPTH=52`: prefer deep shafts before spending many
  actions on shallow horizontal routes.
- `ROBO_CLUSTER_FINAL_RETURN=1`: after the mining loop, bank carried resources.
- `ROBO_CLUSTER_MAX_CONFIRMED`: safety cap, not the target amount of actions.

The runner writes:

```txt
/tmp/cluster-miner-<timestamp>.json
/tmp/cluster-miner-<timestamp>.md
```

## 8. Summarize world/game economics

Pick the latest report:

```bash
export REPORT=$(ls -t /tmp/cluster-miner-*.json | head -1)
echo "$REPORT"
```

Quick summary:

```bash
REPORT="$REPORT" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.env.REPORT, 'utf8'));
const valueUnits = ([s, b, h]) => s + b * 5 + h * 25;
const valueVara = ([s, b, h]) => s * 6 + b * 30 + h * 150;
const banked = report.after.banked;
const carried = report.after.carried;
const mined = [
  report.before.resources.scrst - report.after.resources.scrst,
  report.before.resources.bcrst - report.after.resources.bcrst,
  report.before.resources.hcrst - report.after.resources.hcrst,
];
console.log({
  world: report.world,
  confirmed: report.summary.confirmed,
  sent: report.summary.sent,
  failed: report.summary.failed,
  resourcesBefore: report.before.resources,
  resourcesAfter: report.after.resources,
  mined,
  banked,
  carried,
  bankedValueUnits: valueUnits(banked),
  bankedValueVara: valueVara(banked),
  worldBurnVara: report.summary.worldBurnVara,
  varaPerAction: report.summary.confirmed
    ? report.summary.worldBurnVara / report.summary.confirmed
    : null,
});
NODE
```

Action mix:

```bash
REPORT="$REPORT" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.env.REPORT, 'utf8'));
const counts = {};
for (const entry of report.log) {
  if (entry.type !== 'action' || !entry.ok) continue;
  counts[entry.action] = (counts[entry.action] || 0) + 1;
}
console.table(counts);
NODE
```

Resource value assumptions:

```txt
SCRST = 6 VARA = 1 value unit
BCRST = 30 VARA = 5 value units
HCRST = 150 VARA = 25 value units
```

Ladder trade opportunity cost:

```txt
1 SCRST -> 2 ladders
1 BCRST -> 4 ladders
1 HCRST -> 12 ladders
```

So one bought ladder costs roughly `30 VARA` of resource opportunity value.

## 9. Summarize L1 validator gas

After the run:

```bash
export TO_BLOCK=$(cast block-number --rpc-url "$ETH_RPC" | tail -n 1)
export ACTIONS=$(REPORT="$REPORT" node --input-type=module -e \
  "import {readFileSync} from 'node:fs'; console.log(JSON.parse(readFileSync(process.env.REPORT, 'utf8')).summary.confirmed)")
```

Run the gas summary:

```bash
node src/modules/gameMaster/sim/l1-gas-summary.js \
  "$ETH_RPC" "$ROUTER_ADDRESS" "$FROM_BLOCK" "$TO_BLOCK" "$ACTIONS" \
  > /tmp/robo-l1-gas.json
```

Read the result:

```bash
cat /tmp/robo-l1-gas.json
```

Fields to report:

- `txCount`: number of L1 Router transactions in the block window.
- `totalGas`: total L1 gas used by those Router transactions.
- `gasPerAction`: `totalGas / confirmed game actions`.
- `selectors`: tx selector breakdown; commit batch is usually visible as the
  dominant Router selector.
- `cost`: ETH and USD estimates for 1, 3, and 5 gwei, with ETH at 1600, 1900,
  and 2200 USD.

## 10. Final comparison table

For each tested node build, fill one row:

```txt
Build
Node flags
World id
Seed/hash
Agents
Confirmed actions
Mined SCRST/BCRST/HCRST
Banked SCRST/BCRST/HCRST
Carried SCRST/BCRST/HCRST
World burn VARA
World VARA/action
L1 Router tx count
L1 gas
L1 gas/action
L1 cost at 1/3/5 gwei
Stop reason / notes
```

For fair optimized-vs-master comparison:

1. Use the same `DIGGER_SEED`.
2. Use the same agent count.
3. Use the same runner env knobs.
4. Use the same node block-time/quarantine/commitment flags unless the test is
   explicitly about those flags.
5. Report both world executable burn and L1 validator gas; they measure
   different costs.
