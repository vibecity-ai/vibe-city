/* NEAR AI Cloud's public model list (GET /v1/model/list, no key needed): real per-token prices and capabilities.
   AR only shortlists models a Hermes agent can run: text in, text out, and tool calling (Hermes' agent loop is tools).
   Claude models are left out: Hermes always sends reasoning_effort and NEAR AI rejects it for them ("Extra inputs are
   not permitted", any level, checked 2026-11-11). `privacy`: NEAR AI's `verifiable` flag, the model runs sealed in an
   attested TEE: "private" when NEAR AI runs it (owner `nearai`), "confidential" at an attested partner (Chutes, Tinfoil).
   Image input is not required; it is kept as a flag for the card. */

export interface ModelPrice { inPerM: number; outPerM: number; context: number; vision: boolean; privacy?: 'private' | 'confidential'; icon?: string }
export type PriceList = Map<string, ModelPrice>;
export interface ModelPrices { list(): Promise<PriceList> }

/** Assumed day of one agent: agent loops resend their context every step, so input dominates. */
export const DAY_TOKENS = { input: 1_000_000, output: 100_000 } as const;
/** Credits per day at DAY_TOKENS. 1 credit = 1 US cent of NEAR AI usage. */
export const dailyCredits = (p: ModelPrice) => Math.max(1, Math.round((p.inPerM * DAY_TOKENS.input + p.outPerM * DAY_TOKENS.output) / 1e4));
export const priceNote = (p: ModelPrice) => `$${p.inPerM.toFixed(2)} in / $${p.outPerM.toFixed(2)} out per 1M tokens${p.vision ? ', sees images' : ''}${p.privacy === 'private' ? ', Private TEE: sealed in NEAR AI\'s TEE' : p.privacy === 'confidential' ? ', Incognito: sealed in an attested partner TEE' : ', Incognito: relayed to the vendor, not sealed'}`;

type Money = { amount?: number; scale?: number } | null | undefined;
const perM = (c: Money) => (c && typeof c.amount === 'number' && typeof c.scale === 'number' ? (c.amount / 10 ** c.scale) * 1e6 : NaN);

/** Keeps only models Hermes can drive, with a known price. */
export function parsePriceList(body: unknown): PriceList {
  const out: PriceList = new Map();
  const models = (body as { models?: unknown })?.models;
  if (!Array.isArray(models)) return out;
  for (const m of models as Record<string, any>[]) {
    const md = m?.metadata ?? {};
    const inM: string[] = md.architecture?.inputModalities ?? [];
    const outM: string[] = md.architecture?.outputModalities ?? [];
    const feats: string[] = md.supportedFeatures ?? [];
    const p = { inPerM: perM(m.inputCostPerToken), outPerM: perM(m.outputCostPerToken), context: Number(md.contextLength) || 0, vision: inM.includes('image'),
      ...(md.verifiable === true ? { privacy: md.ownedBy === 'nearai' ? 'private' as const : 'confidential' as const } : {}),
      ...(typeof md.modelIcon === 'string' && md.modelIcon.startsWith('https://') ? { icon: md.modelIcon } : {}) };
    if (typeof m.modelId !== 'string' || m.modelId.startsWith('anthropic/') || !inM.includes('text') || outM.join() !== 'text' || !feats.includes('tools')) continue;
    if (!Number.isFinite(p.inPerM) || !Number.isFinite(p.outPerM)) continue;
    out.set(m.modelId, p);
  }
  return out;
}

const TTL_MS = 10 * 60_000;

export class NearModelPrices implements ModelPrices {
  private o: { baseUrl: string; fetch?: typeof fetch };
  private cache: { at: number; list: PriceList } | null = null;
  constructor(o: { baseUrl: string; fetch?: typeof fetch }) { this.o = o; }

  async list(): Promise<PriceList> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.list;
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl.replace(/\/+$/, '')}/model/list`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`NEAR AI Cloud model list answered HTTP ${res.status}.`);
      const list = parsePriceList(await res.json());
      if (list.size) this.cache = { at: Date.now(), list };
      return list;
    } catch (e) {
      if (this.cache) return this.cache.list; // stale prices beat no prices
      throw e;
    }
  }
}
