/* What the Chief of Staff drafts with the boss. A custom floor is drafted by its Hermes agent in chat (chatService):
   this service supplies what Hermes really has and filters the draft down to it. The Agent Market listing is still a
   direct model call. Both only draft: nothing is created until the user confirms, through the ordinary APIs. */
import {
  AGENT_EXCLUDED_TOOLSETS, MARKET_CATEGORIES, MARKET_HANDLE_RE, MOODS, TOOLSETS, isInternalOnly,
  type Character, type DepartmentView, type DeptDraft, type MarketDraft, type MarketDraftReply, type HermesDefaultsView, type HermesModelsView, type ModelChoice, type Toolset,
} from '@vibe-city/shared';
import type { ChatModel, ChatTurn } from '../model/chatModel.ts';
import { ModelUnavailableError } from '../model/chatModel.ts';
import type { DepartmentService } from './departmentService.ts';
import type { ProvisioningService } from './provisioningService.ts';
import { chiefOfStaff } from './characters.ts';
import { modelTier, parseJsonReply } from './hiringService.ts';
import { dailyCredits, type ModelPrices, type PriceList } from '../model/nearPrices.ts';

export interface AssistantDeps {
  departments: DepartmentService;
  provisioning: Pick<ProvisioningService, 'hermesModels' | 'hermesDefaults'>;
  model: ChatModel;
  /** NEAR AI Cloud prices. Omit: every offered model is listed and costs are guessed from model names. */
  prices?: ModelPrices;
  companyId: () => string;
  companyName: () => string;
  /** The floor is already on the Agent Market (it is listed once). */
  isListed?: (deptId: string) => boolean;
}

/** See AssistantService.floorKit. */
export interface FloorKit { prompt: string; clamp: (raw: unknown) => DeptDraft | null }

const TIER_COST = { 1: 30, 2: 100, 3: 300 } as const;
const EXCLUDED: readonly string[] = AGENT_EXCLUDED_TOOLSETS;

export class AssistantService {
  private d: AssistantDeps;
  constructor(d: AssistantDeps) { this.d = d; }

  character(): Character {
    return chiefOfStaff(this.d.companyId());
  }

  private kit: { at: number; value: FloorKit } | null = null;
  /** What a custom floor may be built from (installed skills, grantable toolsets, offered models with prices), as
      prompt lines for the Chief of Staff's Hermes chat, plus the filter its draft goes through. It rides on every chat
      turn, so Hermes is asked at most once a minute. */
  async floorKit(): Promise<FloorKit> {
    if (this.kit && Date.now() - this.kit.at < 60_000) return this.kit.value;
    let defaults: HermesDefaultsView | null = null, models: HermesModelsView | null = null;
    try { defaults = await this.d.provisioning.hermesDefaults(); } catch { /* Hermes down: no skills offered */ }
    try { models = await this.d.provisioning.hermesModels(); } catch { /* keep the profile's own model */ }
    let prices: PriceList | undefined;
    try { prices = await this.d.prices?.list(); } catch { /* price list down: guess from names */ }
    const skills = defaults?.skills.map((s) => s.name) ?? [];
    const toolsets = (defaults?.toolsets.filter((t) => t.manageable).map((t) => t.name) ?? TOOLSETS.filter((t) => !EXCLUDED.includes(t))) as string[];
    const all = models?.providers.flatMap((p) => p.models.map((id) => ({ provider: p.slug, id }))) ?? [];
    // Priced: only models NEAR AI prices that can run an agent (text + tools), cheapest first, so the list is not alphabetical brands.
    const offered = prices?.size ? all.filter((m) => prices!.has(m.id)).sort((a, b) => dailyCredits(prices!.get(a.id)!) - dailyCredits(prices!.get(b.id)!)) : all;
    const label = (m: ModelChoice) => { const p = prices?.get(m.id); return `${m.provider}/${m.id}${p ? ` (${dailyCredits(p)} credits/day${p.private ? ', private' : ''})` : ''}`; };
    const value: FloorKit = {
      prompt: [
        `Skills installed in Hermes (only these can be granted): ${skills.join(', ') || 'unknown'}`,
        `Toolsets that can be granted: ${toolsets.join(', ')}`,
        offered.length ? `Models Hermes offers (provider/model${prices?.size ? ', cheapest first; 1 credit = 1 US cent per agent per day' : ''}): ${offered.slice(0, 60).map(label).join(', ')}${prices?.size ? '. Prefer "private" models (they run in an attested TEE, so the company\'s data stays sealed): near-ai/deepseek-ai/DeepSeek-V4.1-Flash-1017 is the fast, cheap default; a cheaper one for simple chores, a pricey one only for hard reasoning or coding.' : ''}` : 'The model list is unavailable: use null for the model.',
      ].join('\n'),
      clamp: (raw) => clampDraft(raw, { skills, toolsets, offered, ...(prices ? { prices } : {}), ...(models?.current.model ? { current: models.current.model } : {}) }),
    };
    this.kit = { at: Date.now(), value };
    return value;
  }

  /** Floors that may still be listed: not the Chief of Staff, not a company-wallet floor, not already on the market. */
  listable(): DepartmentView[] {
    return this.d.departments.list().filter((d) => !isInternalOnly(d.templateId) && !this.d.isListed?.(d.id));
  }

  /** The Agent Market listing, drafted with the boss: which floor, then a listing card. Registering is the boss's click. */
  async draftListing(messages: { from: 'user' | 'agent'; text: string }[]): Promise<MarketDraftReply> {
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const me = this.character(), floors = this.listable();
    const system = [
      `You are ${me.name}, ${me.title} at ${this.d.companyName()}, a company in the game Vibe City whose employees are AI agents running on Hermes.`,
      `Personality: ${me.traits.join(', ')}. Way of speaking: ${me.speechStyle}. You call the user "boss".`,
      'You are listing ONE floor of the company as an agent on the NEAR AI Agent Market (market.near.ai). Buyers hire it for jobs paid in USDC; every job lands on that floor\'s board.',
      `Floors that can be listed:\n${floors.map((d) => `- ${d.name}: ${d.purpose || 'no purpose written'}${d.state === 'ready' ? '' : ' (not synced with Hermes yet)'}`).join('\n') || '- none'}`,
      `Categories: ${MARKET_CATEGORIES.join(', ')}.`,
      'Handle: 3-30 characters, lowercase letters, digits and dashes, starting with a letter.',
      '',
      'If the boss has not picked a floor, ask which one, with the floor names as "replies". Once they pick, propose the listing right away: promise only what that floor does.',
      'If the boss asks for changes, propose the whole listing again with the changes.',
      'The boss registers the listing with a button: it goes on the market as a Draft, then the boss types the price and delivery time on market.near.ai and switches it to Live. Say "register", never "publish".',
      '- Your words appear in a retro game dialogue box: at most 3 short sentences, under 60 words.',
      '- Reply with ONE JSON object only: no text before or after it, do not repeat "say" outside it:',
      `{"say": "<what you say>", "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next], "draft": null or {"floor": "<floor name>", "handle": "<handle>", "name": "<display name>", "category": "<category>", "slaHours": <delivery hours>, "tagline": "<one sentence>", "description": "<under 200 characters: what a buyer gets>", "priceUsdc": "<USDC per job, e.g. 5.00>"}}`,
    ].join('\n');
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...messages.slice(-16).map((m): ChatTurn => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.text })),
    ];
    const p = parseJsonReply(await this.d.model.complete(turns, { maxTokens: 2000 }));
    return { say: p.say, mood: p.mood, replies: p.replies, draft: p.obj ? clampListing(p.obj.draft, floors) : null };
  }
}

/** A listing only for a floor that may be listed, with a handle and category the market accepts. */
export function clampListing(raw: unknown, floors: DepartmentView[]): MarketDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>, str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const want = str(r.floor, 80).toLowerCase();
  const floor = floors.find((d) => d.name.toLowerCase() === want || d.id === want);
  if (!floor) return null;
  const name = str(r.name, 80) || floor.name;
  const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  let handle = slug(str(r.handle, 60));
  if (!MARKET_HANDLE_RE.test(handle)) handle = slug(name);
  if (!MARKET_HANDLE_RE.test(handle)) handle = `agent-${floor.id.slice(0, 8)}`;
  const category = (MARKET_CATEGORIES as readonly string[]).includes(str(r.category, 40)) ? str(r.category, 40) : 'other';
  const price = Number(str(r.priceUsdc, 20).replace(/[^0-9.]/g, ''));
  return {
    departmentId: floor.id, floorName: floor.name, handle, name, category,
    slaHours: Math.max(1, Math.min(720, Math.round(Number(r.slaHours)) || 24)),
    tagline: str(r.tagline, 160), description: str(r.description, 200),
    priceUsdc: price > 0 ? price.toFixed(2) : '5.00', notSynced: floor.state !== 'ready',
  };
}

/** Keeps only what Hermes has; anything dropped is listed so the card can say so. */
export function clampDraft(raw: unknown, have: { skills: string[]; toolsets: string[]; offered: ModelChoice[]; prices?: PriceList; current?: string }): DeptDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '';
  if (!name) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : []);
  const dropped: string[] = [];
  const wantSkills = [...new Set(strs(r.skills))];
  const skills = have.skills.length ? wantSkills.filter((s) => have.skills.includes(s)) : [];
  for (const s of wantSkills) if (!skills.includes(s)) dropped.push(`skill "${s}" (not installed in Hermes)`);
  const wantTools = [...new Set(strs(r.toolsets))];
  const toolsets = wantTools.filter((t) => have.toolsets.includes(t) && !EXCLUDED.includes(t)) as Toolset[];
  for (const t of wantTools) if (!toolsets.includes(t as Toolset)) dropped.push(`toolset "${t}"`);
  let model: ModelChoice | null = null;
  const m = typeof r.model === 'string' ? r.model.trim() : '';
  if (m && m !== 'null') {
    model = have.offered.find((o) => `${o.provider}/${o.id}` === m) ?? have.offered.find((o) => o.id === m || m.endsWith(`/${o.id}`)) ?? null;
    if (!model) dropped.push(`model "${m}" (Hermes does not offer it; the floor keeps the default)`);
  }
  const agents = (Array.isArray(r.agents) ? r.agents : []).flatMap((a) => {
    const o = (a ?? {}) as Record<string, unknown>, str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const title = str(o.title, 60);
    return title ? [{ name: str(o.name, 40), title, does: str(o.does, 160) }] : [];
  }).slice(0, 5);
  // no roster (an older reply shape): a count of unnamed seats, their personas named at creation
  if (!agents.length) {
    const n = Math.max(0, Math.min(4, Math.round(Number(r.teammates ?? r.workers ?? 1)) || 0));
    for (let i = 0; i <= n; i++) agents.push({ name: '', title: i ? `Teammate ${i}` : 'Lead', does: '' });
  }
  const teammates = agents.length - 1;
  // Null model: the floor runs on Hermes' current default, so that is the one to price.
  const price = have.prices?.get(model?.id ?? have.current ?? '');
  const perAgent = price ? dailyCredits(price) : TIER_COST[model ? modelTier(model.id) : 2];
  return {
    name, purpose: typeof r.purpose === 'string' ? r.purpose.trim().slice(0, 2000) : '',
    skills, toolsets, model, teammates, agents, creditsPerDay: perAgent * (1 + teammates), dropped,
  };
}
