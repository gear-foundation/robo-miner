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

test('backend Docker image dispatches component roles through entrypoint', async () => {
  const dockerfile = await readFile(path.join(REPO_ROOT, 'backend/Dockerfile'), 'utf8');
  const entrypoint = await readFile(path.join(REPO_ROOT, 'backend/docker-entrypoint.sh'), 'utf8');

  assert.match(dockerfile, /backend\/docker-entrypoint\.sh\s+\/app\/backend\/docker-entrypoint\.sh/);
  assert.match(dockerfile, /CMD \["\.\/docker-entrypoint\.sh"\]/);
  assert.doesNotMatch(dockerfile, /CMD \["node", "src\/api\/server\.js"\]/);
  assert.match(entrypoint, /api\)\s+exec node src\/api\/server\.js/s);
  assert.match(entrypoint, /indexer\)\s+exec node src\/jobs\/indexer\.js watch/s);
  assert.match(entrypoint, /scheduler\)\s+exec node src\/jobs\/scheduler\.js/s);
  assert.match(entrypoint, /factory\)\s+exec node src\/modules\/gameMaster\/factory\/index\.js --chain/s);
  assert.doesNotMatch(entrypoint, /operator\.js|gamemaster\.js/);
});
