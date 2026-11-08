/* The reasoning_effort a profile runs with, by model. Hermes sends one value for every model behind the NEAR AI
   provider, and the models disagree (checked live on NEAR AI Cloud, 2026-11-08):
     Qwen 3.x            low, medium, xhigh (its default)   rejects high   (HTTP 400)
     DeepSeek V4.1 1017  low, high, xhigh                   rejects medium (Hermes' own default)
     GLM 5.3, GPT-5.5    any level
   'high' is what the container sets everywhere (docker/cont-init.d/03-vibe-city-near); Qwen gets its own default.
   Claude models on NEAR reject the field in any form, and Hermes cannot omit it for this provider: not handled. */
export const reasoningEffortFor = (modelId: string): string => (/qwen3/i.test(modelId) ? 'xhigh' : 'high');
