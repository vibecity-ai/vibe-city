/* The executive assistant (feature spec 4.3; the permanent assistant of 2.3 grows from here). It drafts new floors in
   the dialogue window. It only drafts: the draft is filtered to what Hermes really has, and nothing is created until
   the user confirms, through the ordinary department API. */
import {
  AGENT_EXCLUDED_TOOLSETS, MOODS, TOOLSETS,
  type Character, type DeptDraft, type DeptDraftReply, type HermesDefaultsView, type HermesModelsView, type ModelChoice, type Toolset,
} from '@vibe-city/shared';
import type { ChatModel, ChatTurn } from '../model/chatModel.ts';
import { ModelUnavailableError } from '../model/chatModel.ts';
import type { DepartmentService } from './departmentService.ts';
import type { ProvisioningService } from './provisioningService.ts';
import { FIRST, LAST, hash, pick } from './characters.ts';
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
}

const TIER_COST = { 1: 30, 2: 100, 3: 300 } as const;
const EXCLUDED: readonly string[] = AGENT_EXCLUDED_TOOLSETS;

export class AssistantService {
  private d: AssistantDeps;
  constructor(d: AssistantDeps) { this.d = d; }

  character(): Character {
    const seed = hash(`${this.d.companyId()}:assistant`);
    return {
      departmentId: 'company', agentKey: 'assistant', role: 'chief',
      name: `${pick(FIRST, seed, 1)} ${pick(LAST, seed, 2)}`, title: 'Executive assistant',
      traits: ['organised', 'upbeat'], speechStyle: 'warm, quick, practical', quirk: 'carries a tablet with the tower blueprint',
      color: '#9B5CFF', voice: 300 + (seed % 80),
    };
  }

  async draftDepartment(messages: { from: 'user' | 'agent'; text: string }[]): Promise<DeptDraftReply> {
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
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
    const label = (m: ModelChoice) => `${m.provider}/${m.id}${prices?.get(m.id) ? ` (${dailyCredits(prices.get(m.id)!)} credits/day)` : ''}`;
    const me = this.character();
    const floors = this.d.departments.list().map((d) => `- ${d.name}: ${d.purpose || 'no purpose written'}`);
    const system = [
      `You are ${me.name}, ${me.title} at ${this.d.companyName()}, a company in the game Vibe City whose employees are AI agents running on Hermes.`,
      `Personality: ${me.traits.join(', ')}. Way of speaking: ${me.speechStyle}. You call the user "boss".`,
      'You are helping the boss add a new department (a floor of the tower). A department has a lead agent and optional teammates; every agent is its own Hermes agent and they work in parallel.',
      `Existing floors (do not duplicate them):\n${floors.join('\n') || '- none yet'}`,
      `Skills installed in Hermes (only these can be granted): ${skills.join(', ') || 'unknown'}`,
      `Toolsets that can be granted: ${toolsets.join(', ')}`,
      offered.length ? `Models Hermes offers (provider/model${prices?.size ? ', cheapest first; 1 credit = 1 US cent per agent per day' : ''}): ${offered.slice(0, 60).map(label).join(', ')}${prices?.size ? '. Pick the cheapest model that can do the purpose well; a pricey one only for hard reasoning or coding.' : ''}` : 'The model list is unavailable: use null for the model.',
      '',
      'Ask at most one short question if the purpose is unclear; otherwise propose the floor right away. Keep it small: grant only what the purpose needs.',
      '- Your words appear in a retro game dialogue box: at most 3 short sentences, under 60 words.',
      '- Reply with JSON only, no other text:',
      `{"say": "<what you say>", "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next], "draft": null or {"name": "<2-3 words>", "purpose": "<1-2 sentences>", "skills": ["<installed skill>"], "toolsets": ["<toolset>"], "model": "<provider/model or null>", "teammates": <0-4>}}`,
    ].join('\n');
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...messages.slice(-16).map((m): ChatTurn => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.text })),
    ];
    const raw = await this.d.model.complete(turns, { maxTokens: 700 });
    const p = parseJsonReply(raw);
    return { say: p.say, mood: p.mood, replies: p.replies, draft: p.obj ? clampDraft(p.obj.draft, { skills, toolsets, offered, ...(prices ? { prices } : {}), ...(models?.current.model ? { current: models.current.model } : {}) }) : null };
  }
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
  const teammates = Math.max(0, Math.min(4, Math.round(Number(r.teammates ?? r.workers ?? 1)) || 0));
  // Null model: the floor runs on Hermes' current default, so that is the one to price.
  const price = have.prices?.get(model?.id ?? have.current ?? '');
  const perAgent = price ? dailyCredits(price) : TIER_COST[model ? modelTier(model.id) : 2];
  return {
    name, purpose: typeof r.purpose === 'string' ? r.purpose.trim().slice(0, 2000) : '',
    skills, toolsets, model, teammates, creditsPerDay: perAgent * (1 + teammates), dropped,
  };
}
