import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db/db.ts';
import { buildServices } from './app.ts';

function withDist() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

test('serves the web app and falls back to the shell for client routes, but API 404s stay JSON', async () => {
  const { app } = buildServices(openDb(':memory:'), undefined, { webDist: withDist() });
  assert.match((await app.inject('/')).body, /shell/);
  assert.equal((await app.inject('/app.js')).statusCode, 200);
  assert.match((await app.inject('/some/client/route')).body, /shell/);
  const chunk = await app.inject('/assets/main-stale123.js');
  assert.equal(chunk.statusCode, 404, 'a missing script is a 404, not the HTML shell');
  assert.doesNotMatch(chunk.body, /shell/);
  const missing = await app.inject('/api/nope');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error, 'not_found');
  assert.equal((await app.inject('/api/company')).statusCode, 200);
  await app.close();
});

test('without webDist the backend serves only the API', async () => {
  const { app } = buildServices(openDb(':memory:'));
  assert.equal((await app.inject('/')).statusCode, 404);
  await app.close();
});
