import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KanbanClient } from './kanbanClient.ts';

test('uploadAttachment sends Hermes the multipart form it expects and drops stored_path', async () => {
  let seen: { url: string; token: unknown; form: FormData } | null = null;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type']! } }).formData();
      seen = { url: req.url!, token: req.headers['x-hermes-session-token'], form };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ attachment: { id: 7, task_id: 't_1', filename: 'a.csv', content_type: 'text/csv', size: 3, uploaded_by: 'vibe-city-ceo', stored_path: '/home/x/a.csv', created_at: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = new KanbanClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sessionToken: 'tok' });
    const a = await client.uploadAttachment('eng', 't_1', { filename: 'a.csv', contentType: 'text/csv', bytes: new TextEncoder().encode('x,y') }, 'vibe-city-ceo');
    assert.deepEqual(a, { id: 7, task_id: 't_1', filename: 'a.csv', content_type: 'text/csv', size: 3, created_at: 1, uploaded_by: 'vibe-city-ceo' });
    assert.equal(seen!.url, '/api/plugins/kanban/tasks/t_1/attachments?board=eng');
    assert.equal(seen!.token, 'tok');
    const file = seen!.form.get('file') as File;
    assert.equal(file.name, 'a.csv');
    assert.equal(await file.text(), 'x,y');
    assert.equal(seen!.form.get('uploaded_by'), 'vibe-city-ceo');
  } finally {
    server.close();
  }
});
