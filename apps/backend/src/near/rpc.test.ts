import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NearRpc } from './rpc.ts';

test('NEAR RPC client: view calls are base64 JSON in and bytes out; errors are plain words', async () => {
  const sent: any[] = [];
  const rpc = new NearRpc('https://rpc.example', { fetch: (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body.params);
    if (body.params.request_type === 'view_account') return new Response(JSON.stringify({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    return new Response(JSON.stringify({ result: { result: [...Buffer.from(JSON.stringify({ ok: 1 }))] } }));
  }) as typeof fetch });
  assert.deepEqual(await rpc.view('dao.near', 'get_policy', { a: 1 }), { ok: 1 });
  assert.equal(Buffer.from(sent[0].args_base64, 'base64').toString(), '{"a":1}');
  assert.equal(sent[0].finality, 'final');
  await assert.rejects(rpc.balance('nobody.near'), /does not exist/);
});
