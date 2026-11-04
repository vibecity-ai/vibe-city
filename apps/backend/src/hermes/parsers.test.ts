import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolsList } from './realRuntime.ts';

test('parseToolsList reads built-in and plugin toolsets', () => {
  const out = `Built-in toolsets (cli):
  ✓ enabled  web  🔍 Web Search & Scraping
  ✗ disabled  video  🎬 Video Analysis
  ✓ enabled  code_execution  ⚡ Code Execution

Plugin toolsets (cli):
  ✗ disabled  a2a  🔌 A2A
`;
  assert.deepEqual(parseToolsList(out), { web: true, video: false, code_execution: true, a2a: false });
});

test('parseToolsList ignores unrelated lines', () => {
  assert.deepEqual(parseToolsList('nothing here\n✓ done'), {});
});

