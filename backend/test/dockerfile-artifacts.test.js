import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

test('backend Dockerfile ships the proxy IDL, not the world IDL, as digger_proxy.idl', async () => {
  const dockerfile = await readFile(path.join(REPO_ROOT, 'backend/Dockerfile'), 'utf8');

  assert.match(
    dockerfile,
    /backend\/src\/chain\/digger_proxy\.idl\s+\/app\/contracts\/target\/wasm32-gear\/release\/digger_proxy\.idl/,
  );
  assert.doesNotMatch(
    dockerfile,
    /frontend\/src\/chain\/world\.idl\s+\/app\/contracts\/target\/wasm32-gear\/release\/digger_proxy\.idl/,
  );
});
