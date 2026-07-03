import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js/parser';

import { DEFAULT_WORLD_CONFIG } from '../src/config/networks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDL_PATH = path.resolve(__dirname, '../src/chain/diggerWorld.idl');

test('DiggerWorld IDL encodes Create(config) for factory initialization', async () => {
  const parser = new SailsIdlParser();
  await parser.init();
  const sails = new SailsProgram(parser.parse(await readFile(IDL_PATH, 'utf8')));

  assert.equal(sails.ctors.Create.args.length, 1);
  assert.equal(
    sails.ctors.Create.args[0].type,
    '((u32,u32,u32,u32,u32,u32,u32,u32,u32,u32),(u32,u32,u32,u32,u32,u32))',
  );
  assert.match(sails.ctors.Create.encodePayload(DEFAULT_WORLD_CONFIG), /^0x[0-9a-f]+$/i);
});
