import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CONTRACT_IDLS = {
  world: 'contracts/target/wasm32-gear/release/digger_world.idl',
  proxy: 'contracts/target/wasm32-gear/release/digger_proxy.idl',
  resVmt: 'contracts/target/wasm32-gear/release/digger_res_vmt.idl',
  redeem: 'contracts/target/wasm32-gear/release/digger_redeem.idl',
};

export async function loadContractIdls(rootDir) {
  const entries = await Promise.all(
    Object.entries(CONTRACT_IDLS).map(async ([name, relativePath]) => {
      const file = path.resolve(rootDir, '..', relativePath);
      const text = await readFile(file, 'utf8');
      return [name, { name, file, ...parseIdl(text) }];
    }),
  );
  return Object.fromEntries(entries);
}

export function parseIdl(text) {
  const services = [];
  const serviceRe = /service\s+([A-Za-z0-9_]+)@([0-9a-fx]+)\s*\{([\s\S]*?)\n\}/g;
  let match;
  while ((match = serviceRe.exec(text)) !== null) {
    const [, name, interfaceId, body] = match;
    services.push({
      name,
      interfaceId,
      events: parseBlockItems(body, 'events'),
      functions: parseBlockItems(body, 'functions'),
    });
  }

  const programName = text.match(/program\s+([A-Za-z0-9_]+)/)?.[1] || null;
  return { programName, services };
}

function parseBlockItems(body, blockName) {
  const block = body.match(new RegExp(`${blockName}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'))?.[1] || '';
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('@'))
    .map((line) => line.replace(/;$/, ''))
    .filter(Boolean);
}
