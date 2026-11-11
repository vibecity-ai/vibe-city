---
name: vibe-city-models
description: "For the Chief of Staff: which NEAR AI Cloud model to give a floor, a hire or yourself, by speed, quality, privacy and cost; which models cannot run a Vibe City agent at all; and how to explain a model choice to the boss."
---

# Picking models in Vibe City

Every Vibe City agent is a Hermes agent that thinks with one model on NEAR AI Cloud (`https://cloud-api.near.ai/v1`,
provider `near-ai` in Hermes). The boss pays per token, so a model choice is a speed, quality and money choice, and
on NEAR AI it is also a privacy choice. Use this when you propose a floor, scout a hire, or the boss asks "which
model should X use?" or "why is this floor so expensive?".

## Hard rules (a wrong pick breaks the agent)

1. **Tool calling is required.** A Hermes agent works only through tools. A model without `tools` in NEAR AI's
   `supportedFeatures` cannot be an agent (today: `openai/gpt-6-*`, `openai/gpt-6.1-sol`, `anthropic/claude-opus-4-8`,
   `google/gemini-3.8-flash`, `moonshotai/kimi-k3.1-pro`).
2. **No Claude models (`anthropic/*`) for agents.** Hermes always sends `reasoning_effort`; NEAR AI rejects it for
   every Claude model ("Extra inputs are not permitted"). Vibe City leaves them out of every list it offers.
3. **Text in, text out.** Image, embedding, speech and "decision" models (`FLUX`, `Qwen3-Embedding`, `whisper`,
   `levanto/sage`, `typesafe/jev`) are not agents.
4. **Only offer what Hermes offers.** The list in your prompt (or the boss's model picker) is the truth; never
   invent a model id. Ids are case-sensitive: `deepseek-ai/DeepSeek-V4.1-Flash-1017`, not `deepseek/...`.
5. **Abliterated models** (`*-abliterated`, refusals removed) only where a template already sets them, for red-team
   or security work. Never propose one on your own.
6. **Private TEE first.** Every model you propose (for a floor, a hire or yourself) is a Private TEE model, unless no
   Private TEE model in the list can do the work or the boss names another model. Then say plainly what is given up:
   "this one is Incognito, not sealed in NEAR AI's TEE".

## Private TEE and Incognito

Vibe City tags every model in its pickers as near.ai/models does, with the vendor's logo. NEAR AI marks a model
`verifiable` when it runs in an attested TEE (Intel TDX + NVIDIA confidential GPUs).

- **Private TEE**: NEAR AI runs it in its own TEE. Prompts stay sealed even from NEAR AI.
- **Incognito** on a `verifiable` model (owner `attested 3p`): an attested partner TEE (Chutes, Tinfoil) that NEAR AI
  verifies. Sealed from the host.
- **Incognito** on any other model: routed to the vendor (OpenAI, Google, xAI, OpenRouter...) with identifying data
  stripped, not sealed.

The order to pick in: **Private TEE, then a partner-TEE Incognito model, then a relayed Incognito one** (only when the
boss asks for that brand). Private TEE is not only for money, wallets, keys, strategy and customers: every floor's
tasks carry the company's data, so it is the default everywhere. Two ids can be the same model and differ only here:
`deepseek-ai/DeepSeek-V4.1-Flash-1017` (Private TEE) vs `deepseek/deepseek-v4.1-flash` (OpenRouter, Incognito), same
price: always take the Private TEE id.

## The roster

Cost per agent-day = Vibe City's estimate of one busy agent (1M input + 100k output tokens), at NEAR AI list prices
of 2026-11-11. Latency = one tool call and one short chat, measured once that day; treat as rough.

| Use | Model | Tag | $/agent-day | Tool call | Notes |
|---|---|---|---|---|---|
| **Default, almost every floor** | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Private TEE | 0.42 | 0.9 s | Reasoning + coding, 1M context, sees images. Vibe City's default. |
| Cheap chores (triage, summaries, monitoring) | `Qwen/Qwen3.6-35B-A3B-FP8` | Private TEE | 0.28 | 0.8 s | Fastest measured. 262K context. |
| | `Qwen/Qwen3.8-27B` | Private TEE | 0.18 | 1.2 s | Cheapest input; vision. 262K context. |
| | `z-ai/glm-5.3-flash` | Private TEE | 0.13 | 1.0 s | Cheapest per day. Slow to answer plain chat (15 s), fine in a task loop. |
| Hard reasoning, long coding, research | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | Private TEE | 0.42 | 0.9 s | Try the default first: strong at reasoning and coding. |
| Only if the default falls short, and the boss agrees | `z-ai/glm-5.3` | Incognito (partner TEE) | 2.38 | 26 s | Strong long-horizon agent, 1M context. Slow: background work only. |
| | `moonshotai/kimi-k3` | Incognito (partner TEE) | 4.95 | 8 s | Frontier agentic model, 1M context. Expensive, slow chat (19 s). |
| Only if the boss asks for a brand | `openai/gpt-5.4-mini` (1.20), `openai/gpt-5.5` (8.00), `google/gemini-3.5-flash` (2.40), `x-ai/grok-4.7` (2.60) | Incognito | | | Relayed to the vendor, not sealed. |

Qwen models need `reasoning_effort` `xhigh` and DeepSeek `high`; Vibe City sets that per profile itself.

## How to choose

1. Start from the default. Move **down** a row for repetitive, low-stakes work the boss wants cheap: every model there
   is Private TEE too. For hard reasoning or long coding (audits, strategy, research) stay on the default; leave the
   Private TEE models only when the boss wants more than it gives, and say what it costs and that it is not sealed in
   NEAR AI's TEE.
2. Multiply by the team: a lead and two teammates on the default is about $1.26 a day. Compare with the floor's
   daily budget; if it does not fit, drop a teammate or a model tier before you suggest raising the budget.
3. A hire's model should match the work it was hired for, not the most impressive name. A balanced hire on the
   default beats a premium hire that burns the budget by noon.
4. Your own model (the boss picks it in the first quest and the Executive Office) answers every dialogue: favour
   speed. The default is right. Avoid `z-ai/glm-5.3-flash` (slow chat) and `openai/gpt-5.6-luna` (rejects the
   temperature Vibe City's drafts use).

## Explaining it to the boss

One sentence: the model, why it fits the work, the daily cost from the list, and its tag (Private TEE or Incognito). E.g. "I'd put
Treasury on DeepSeek V4.1 Flash: quick, good with tools, about 42 cents a day per agent, and it runs sealed in NEAR's
TEE so your wallet data stays private." Costs are estimates; say so. Prices change: the live list is
`GET https://cloud-api.near.ai/v1/model/list` (no key needed).
