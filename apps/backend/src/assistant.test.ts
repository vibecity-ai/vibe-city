import { test } from 'node:test';
import assert from 'node:assert/strict';
import { questApp } from './testUtils.ts';
import { FakeChatModel } from './model/chatModel.ts';
import { clampDraft } from './domain/assistantService.ts';

test('the assistant drafts a floor limited to what Hermes has, and creates nothing', async () => {
  const model = new FakeChatModel(() => JSON.stringify({
    say: 'A Legal floor. Here is my pitch.', mood: 'happy', replies: ['Looks good'],
    draft: { name: 'Legal', purpose: 'Review contracts.', skills: ['pdf', 'contract-wizard'], toolsets: ['web', 'file', 'delegation'], model: 'near-ai/model-a', teammates: 2 },
  }));
  const { app } = questApp({ chatModel: model });
  const view = (await app.inject('/api/assistant')).json();
  assert.equal(view.character.title, 'Executive assistant');
  assert.equal(view.modelReady, true);
  const before = (await app.inject('/api/departments')).json().departments.length;
  const r = await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'We need legal help' }] } });
  assert.equal(r.statusCode, 200);
  const d = r.json().draft;
  assert.equal(d.name, 'Legal');
  assert.deepEqual(d.skills, ['pdf']);
  assert.deepEqual(d.toolsets, ['web', 'file']);
  assert.deepEqual(d.model, { provider: 'near-ai', id: 'model-a' });
  assert.equal(d.teammates, 2);
  assert.ok(d.creditsPerDay > 0);
  assert.ok(d.dropped.some((x: string) => x.includes('contract-wizard')));
  assert.ok(d.dropped.some((x: string) => x.includes('delegation')));
  assert.equal((await app.inject('/api/departments')).json().departments.length, before, 'drafting creates nothing');
  // The system prompt lists what Hermes really has.
  assert.match(model.calls[0]![0]!.content, /Skills installed in Hermes.*pdf/);
});

test('without a model the draft is 503; malformed drafts are dropped', async () => {
  const { app } = questApp();
  const r = await app.inject({ method: 'POST', url: '/api/assistant/department-draft', payload: { messages: [{ from: 'user', text: 'hi' }] } });
  assert.equal(r.statusCode, 503);
  assert.equal(clampDraft({ purpose: 'x' }, { skills: [], toolsets: [], offered: [] }), null);
  assert.equal(clampDraft({ name: 'Ops', model: 'nope/never' }, { skills: [], toolsets: [], offered: [] })!.model, null);
});
