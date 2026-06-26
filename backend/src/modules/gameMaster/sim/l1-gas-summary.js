#!/usr/bin/env node
import { createPublicClient, formatEther, http } from 'viem';

const rpc = process.env.ETH_RPC || process.argv[2] || 'http://127.0.0.1:8545';
const router = (process.env.ROUTER_ADDRESS || process.argv[3] || '').toLowerCase();
const fromBlock = BigInt(process.env.FROM_BLOCK || process.argv[4] || '0');
const toBlockArg = process.env.TO_BLOCK || process.argv[5] || 'latest';
const actions = Number(process.env.ACTIONS || process.argv[6] || '0');
const ethPrices = String(process.env.ETH_PRICES || '1600,1900,2200').split(',').map(Number).filter(Number.isFinite);
const gasPrices = String(process.env.GAS_PRICES_GWEI || '1,3,5').split(',').map(Number).filter(Number.isFinite);

if (!router || !/^0x[0-9a-f]{40}$/.test(router)) {
  console.error('usage: ETH_RPC=http://... ROUTER_ADDRESS=0x... FROM_BLOCK=123 [TO_BLOCK=latest] [ACTIONS=4200] node l1-gas-summary.js');
  process.exit(1);
}

const client = createPublicClient({ transport: http(rpc) });
const latest = toBlockArg === 'latest' ? await client.getBlockNumber() : BigInt(toBlockArg);
const selectorGroups = new Map();
const txs = [];

for (let blockNumber = fromBlock; blockNumber <= latest; blockNumber += 1n) {
  const block = await client.getBlock({ blockNumber, includeTransactions: true });
  for (const tx of block.transactions) {
    if (String(tx.to || '').toLowerCase() !== router) continue;
    const receipt = await client.getTransactionReceipt({ hash: tx.hash });
    const selector = tx.input?.slice(0, 10) || '0x';
    const current = selectorGroups.get(selector) || { txs: 0, gas: 0n };
    current.txs += 1;
    current.gas += receipt.gasUsed;
    selectorGroups.set(selector, current);
    txs.push({
      blockNumber: Number(blockNumber),
      hash: tx.hash,
      from: tx.from,
      selector,
      gasUsed: receipt.gasUsed.toString(),
      logs: receipt.logs.length,
    });
  }
}

const totalGas = txs.reduce((sum, tx) => sum + BigInt(tx.gasUsed), 0n);
const totalGasNumber = Number(totalGas);
const gasPerAction = actions > 0 ? totalGasNumber / actions : null;

const cost = [];
for (const gwei of gasPrices) {
  const eth = Number(formatEther(totalGas * BigInt(Math.round(gwei * 1e9))));
  const usd = Object.fromEntries(ethPrices.map((price) => [`eth_${price}`, Number((eth * price).toFixed(2))]));
  cost.push({ gwei, eth: Number(eth.toFixed(9)), usd });
}

const summary = {
  rpc,
  router,
  fromBlock: Number(fromBlock),
  toBlock: Number(latest),
  txCount: txs.length,
  totalGas: totalGas.toString(),
  gasPerAction: gasPerAction == null ? null : Number(gasPerAction.toFixed(2)),
  selectors: Object.fromEntries(
    [...selectorGroups.entries()].map(([selector, value]) => [
      selector,
      { txs: value.txs, gas: value.gas.toString() },
    ]),
  ),
  cost,
  txs,
};

console.log(JSON.stringify(summary, null, 2));
