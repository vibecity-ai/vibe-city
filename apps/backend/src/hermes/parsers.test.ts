import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillsList, parseToolsList } from './realRuntime.ts';

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

test('parseSkillsList reads the rich table and skips header/borders', () => {
  const out = `                        Installed Skills (enabled only)
┏━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┓
┃ Name                    ┃ Category             ┃ Source  ┃ Trust   ┃ Status  ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━┩
│ diagnose-crash          │                      │ local   │ local   │ enabled │
│ pdf                     │ productivity         │ builtin │ builtin │ disabled │
└─────────────────────────┴──────────────────────┴─────────┴─────────┴─────────┘`;
  assert.deepEqual(parseSkillsList(out), [{ name: 'diagnose-crash', enabled: true }, { name: 'pdf', enabled: false }]);
});

test('parseSkillsList refuses truncated names instead of guessing', () => {
  const out = '│ songwriting-and-ai-mu… │ creative │ builtin │ builtin │ enabled │';
  assert.throws(() => parseSkillsList(out), /truncated/);
});
