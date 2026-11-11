import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from './domain/scrub.ts';
import { parseAgentReply } from './domain/chatService.ts';

test('an agent chat reply is scrubbed like any Hermes text', () => {
  const r = parseAgentReply(`My token is Bearer vc_${'ab12'.repeat(12)}, saved in /home/hermes/.hermes/profiles/x/config.yaml\n<vc>{"mood":"happy","replies":[]}</vc>`);
  assert.doesNotMatch(r.text, /ab12|\/home\/hermes/);
  assert.match(r.text, /Bearer <secret>.*<path>\/config\.yaml/);
});

test('scrub hides credentials an agent prints: bearer headers, MCP tokens, wallet and API keys, even cut short', () => {
  const token = `vc_${'71e93c1b'.repeat(6)}`;
  const out = scrub([
    `curl -H "Authorization: Bearer ${token}" http://127.0.0.1:4100/mcp`,
    'the value is `vc_71e93c1b...501`',
    'grep found Bearer vc_71e8 in config.yaml',
    'wallet wk_abcdef0123456789abcd and key sk-proj-AbCdEf0123456789',
    'skill risk-metrics-calc and task t_9394a9e9 stay as they are',
  ].join('\n'))!;
  assert.doesNotMatch(out, /71e9|71e8|abcdef0123|AbCdEf0123/);
  assert.match(out, /Bearer <secret>/);
  assert.match(out, /risk-metrics-calc/);
  assert.match(out, /t_9394a9e9/);
});
