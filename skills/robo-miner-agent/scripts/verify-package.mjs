#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const requiredFiles = [
  "README.md",
  "SKILL.md",
  "agents/openai.yaml",
  "assets/examples/agent.env.example",
  "assets/idl/digger_world.idl",
  "assets/idl/digger_res_vmt.idl",
  "assets/idl/digger_redeem.idl",
  "references/backend-api.md",
  "references/contract-api.md",
  "references/digger-proxy-interface.md",
  "references/game-and-economy.md",
  "references/wallet-and-signing.md",
  "references/workflow.md",
  "scripts/actor-id.mjs",
];

async function assertFile(relativePath) {
  const file = path.join(root, relativePath);
  await access(file);
}

async function main() {
  await Promise.all(requiredFiles.map(assertFile));

  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  const files = new Set(packageJson.files || []);
  for (const requiredEntry of ["README.md", "SKILL.md", "agents", "assets", "references", "scripts"]) {
    if (!files.has(requiredEntry)) {
      throw new Error(`package.json files[] is missing ${requiredEntry}`);
    }
  }

  const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  for (const reference of [
    "references/workflow.md",
    "references/wallet-and-signing.md",
    "references/backend-api.md",
    "references/contract-api.md",
    "references/digger-proxy-interface.md",
    "references/game-and-economy.md",
  ]) {
    if (!skill.includes(reference)) {
      throw new Error(`SKILL.md does not mention ${reference}`);
    }
  }

  console.log("robo-miner-agent skill package is complete");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
