import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningEffortFor } from './reasoningEffort.ts';

test('Qwen 3.x runs at xhigh (NEAR rejects high for it); everything else keeps high (DeepSeek rejects medium)', () => {
  for (const m of ['Qwen/Qwen3.8-27B-abliterated', 'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.6-35B-A3B-FP8', 'qwen/qwen3.7-max']) assert.equal(reasoningEffortFor(m), 'xhigh', m);
  for (const m of ['deepseek/deepseek-v4.1-flash', 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', 'z-ai/glm-5.3', 'openai/gpt-5.5']) assert.equal(reasoningEffortFor(m), 'high', m);
});
