/* AR (Agent Resources): scouting and hiring (feature spec 7.1).
   AR watches the boards with a few plain rules and calls the CEO when a floor needs people. The talk is the Chief of
   Staff's own Hermes chat (chatService), which ends in a brief; confirming it shows three candidates that fit it (loadouts
   built from what Hermes really has: its models and installed skills, priced at NEAR AI's list prices). `facts()` is what the Chief of Staff knows while hiring: the offered models with NEAR
   AI prices and the candidates on screen. Nothing changes in Hermes until the offer. An offer adds one agent to the
   department, with the candidate's own model and skills, then re-provisions the department through the normal path,
   which creates the agent's Hermes profile. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  CandidateSchema, HiringBriefSchema, MAX_TEAMMATES, MOODS, profileNameForAgent,
  type Candidate, type Character, type HiringBrief, type HiringRequestView, type HiringState,
  type HiringTrigger, type HermesModelsView, type Mood, type ModelChoice, type QuestSummary,
} from '@vibe-city/shared';
import type { ChatModel } from '../model/chatModel.ts';
import { dailyCredits, priceNote, type ModelPrices, type PriceList } from '../model/nearPrices.ts';
import type { DepartmentService } from './departmentService.ts';
import type { ProvisioningService } from './provisioningService.ts';
import { COLORS, FIRST, LAST, QUIRKS, STYLES, TRAITS, chiefOfStaff, hash, pick } from './characters.ts';
import { ConflictError, NotFoundError } from './errors.ts';

export interface HiringDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  provisioning: Pick<ProvisioningService, 'hermesModels' | 'hermesDefaults' | 'provision'>;
  quests: (departmentId: string) => Promise<QuestSummary[]>;
  model: ChatModel;
  companyId: () => string;
  companyName: () => string;
  /** NEAR AI Cloud prices. Omit: costs are guessed from model names and every offered model is eligible. */
  prices?: ModelPrices;
  /** Store the hire's persona on its new seat so the office and dialogue window show the same person. */
  savePersona?: (departmentId: string, agentKey: string, c: Character) => void;
  now?: () => Date;
}

const ACTIVE = new Set(['queued', 'planning', 'running', 'awaiting_input', 'in_review']);
/** Don't call again about the same floor and reason within this window. */
const QUIET_MS = 6 * 3600_000;

interface Row {
  id: string; state: HiringState; trigger_json: string; department_id: string | null; brief_json: string | null;
  scouting_until: string | null; hired_candidate_id: string | null; applied_json: string | null;
  created_at: string; updated_at: string;
}

/** Model size class from its name. A guess, labelled as such in the UI. */
export function modelTier(id: string): 1 | 2 | 3 {
  const s = id.toLowerCase();
  if (/(nano|mini|small|flash|lite|haiku|tiny|\b[1-9]b\b|-[1-9]b)/.test(s)) return 1;
  if (/(pro|large|max|opus|ultra|405b|235b|120b|72b|70b|reasoner|r1\b)/.test(s)) return 3;
  return 2;
}
const TIER_COST = { 1: 40, 2: 140, 3: 420 } as const;
const TIER = ['', 'Small', 'Mid-size', 'Large'] as const;
/** Size class from real daily cost (credits = cents): under $0.30, under $3, above. */
export const priceTier = (credits: number): 1 | 2 | 3 => (credits <= 30 ? 1 : credits <= 300 ? 2 : 3);


export class HiringService {
  private d: HiringDeps;
  private now: () => Date;
  constructor(d: HiringDeps) { this.d = d; this.now = d.now ?? (() => new Date()); }

  /** Who runs hiring: the Chief of Staff (AR merged into it), the same person who drafts floors. */
  ar(): Character {
    return chiefOfStaff(this.d.companyId());
  }

  // ---- requests ---------------------------------------------------------------------------------------------------

  /** The open request, if any; otherwise run the trigger rules and ring when one fires. */
  async current(): Promise<HiringRequestView | null> {
    const open = this.openRow();
    if (open) return this.view(open);
    const t = await this.checkTriggers();
    return t ? this.view(this.insert(t, 'ringing')) : null;
  }

  get(id: string): HiringRequestView { return this.view(this.row(id)); }

  decline(id: string): HiringRequestView {
    const r = this.row(id);
    if (r.state === 'hired' || r.state === 'closed') return this.view(r);
    return this.view(this.setState(id, 'closed'));
  }

  /** The boss confirmed the Chief of Staff's brief: a fresh request with its candidates right away. An open request
      (a call, or candidates for an earlier brief) is closed: the newest brief is the one on screen. */
  async create(input: Omit<HiringBrief, 'departmentName'>): Promise<HiringRequestView> {
    const open = this.openRow();
    if (open) this.setState(open.id, 'closed');
    const dept = this.d.departments.get(input.departmentId);
    const brief = HiringBriefSchema.parse({ ...input, departmentName: dept.name });
    const r = this.insert({ kind: 'manual', departmentId: dept.id, reason: `You asked the Chief of Staff to hire for ${dept.name}.` }, 'shortlist');
    const candidates = await this.scout(r.id, brief);
    this.d.db.prepare('UPDATE hiring_request SET brief_json = ? WHERE id = ?').run(JSON.stringify(brief), r.id);
    const ins = this.d.db.prepare('INSERT INTO hiring_candidate (id, request_id, idx, candidate_json) VALUES (?, ?, ?, ?)');
    candidates.forEach((c, i) => ins.run(c.id, r.id, i, JSON.stringify(c)));
    return this.get(r.id);
  }

  /** What the Chief of Staff knows while hiring: the models Hermes offers with NEAR AI's prices (cheapest first) and,
      once a brief was confirmed, the candidates on the boss's screen. Real facts only. */
  async facts(): Promise<string> {
    const { all, prices } = await this.offeredModels();
    const usd = (credits: number) => `$${(credits / 100).toFixed(2)}`;
    const SIZE = ['', 'small', 'mid-size', 'large'];
    const daily = (m: ModelChoice) => { const p = prices?.get(m.id); return p ? dailyCredits(p) : Infinity; };
    const modelFacts = [...all].sort((a, b) => daily(a) - daily(b)).slice(0, 40).map((m) => {
      const p = prices?.get(m.id);
      return p ? `- ${m.id} (${m.provider}): about ${usd(dailyCredits(p))} a day for one busy agent, ${SIZE[priceTier(dailyCredits(p))]} by price; ${priceNote(p)}; context ${p.context} tokens`
        : `- ${m.id} (${m.provider}): price unknown; ${SIZE[modelTier(m.id)]} going by its name (a guess)`;
    });
    const open = this.openRow();
    const brief = open?.state === 'shortlist' && open.brief_json ? HiringBriefSchema.parse(JSON.parse(open.brief_json)) : null;
    const cands = brief ? this.candidates(open!.id).map((c) => `- ${c.character.name} (${c.note}): model ${c.loadout.model?.id ?? 'floor default'}, about ${usd(c.costPerDay)} a day, fit ${c.fitScore}/100, skills ${c.loadout.skills.join(', ') || 'none'}`) : [];
    return [
      modelFacts.length ? `Models Hermes offers (NEAR AI list prices; a day = 1M input + 100k output tokens, an estimate; "Private TEE"/"Incognito" is how sealed the model runs):\n${modelFacts.join('\n')}` : 'The list of models Hermes offers is unavailable right now: say so if asked, do not guess prices.',
      brief ? `Candidates on the boss's screen for "${brief.focus}" on ${brief.departmentName} (budget ${usd(brief.budgetPerDay)} a day), each with a Hire button; the boss hires, you never do. These cards are the only candidates: describe only these models, never claim a card has a model it does not:\n${cands.join('\n')}` : 'No candidates are on screen yet.',
    ].join('\n');
  }

  // ---- offer ------------------------------------------------------------------------------------------------------

  async offer(id: string, candidateId: string): Promise<HiringRequestView> {
    const r = this.row(id);
    if (r.state !== 'shortlist') throw new ConflictError(`no shortlist to hire from (request is ${r.state})`);
    const c = CandidateSchema.parse(JSON.parse(this.candidateRow(id, candidateId).candidate_json));
    const brief = HiringBriefSchema.parse(JSON.parse(r.brief_json!));
    const before = this.d.departments.agents(brief.departmentId).length;
    if (before > MAX_TEAMMATES) throw new ConflictError(`${brief.departmentName} already has the maximum of ${MAX_TEAMMATES} teammates`);
    // The hire is its own agent: its own Hermes profile, with the candidate's model and skills (the floor's are untouched).
    const agent = this.d.departments.addAgent(brief.departmentId, { model: c.loadout.model, skills: c.loadout.skills });
    const seat = agent.agent_key;
    this.d.savePersona?.(brief.departmentId, seat, { ...c.character, departmentId: brief.departmentId, agentKey: seat, role: 'worker', title: `${brief.departmentName} specialist` });
    // Re-apply the inventory to Hermes through the normal path. It runs in the background; the floor shows progress.
    let provisioning = 'started';
    try { void this.d.provisioning.provision(brief.departmentId).catch(() => undefined); } catch (e) { provisioning = (e as Error).message; }
    const applied = {
      departmentId: brief.departmentId, seat, profileRef: profileNameForAgent(brief.departmentId, seat), teamBefore: before, teamAfter: before + 1,
      skills: [...new Set(c.loadout.skills)], model: c.loadout.model, provisioning,
    };
    this.d.db.prepare("UPDATE hiring_request SET state = 'hired', hired_candidate_id = ?, applied_json = ?, updated_at = ? WHERE id = ?")
      .run(candidateId, JSON.stringify(applied), this.iso(), id);
    return this.get(id);
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  /** Plain rules over real board numbers. One call at a time; quiet for a while after a call about the same thing. */
  async checkTriggers(): Promise<HiringTrigger | null> {
    for (const dept of this.d.departments.list()) {
      if (dept.state !== 'ready') continue;
      let quests: QuestSummary[] = [];
      try { quests = await this.d.quests(dept.id); } catch { continue; }
      const active = quests.filter((q) => ACTIVE.has(q.status));
      const agents = dept.agents.length;
      const sum = (k: keyof QuestSummary['counts']) => active.reduce((n, q) => n + q.counts[k], 0);
      const failed = quests.reduce((n, q) => n + q.counts.failed, 0);
      let t: HiringTrigger | null = null;
      if (agents === 1 && active.length >= 2) t = { kind: 'no_workers', departmentId: dept.id, reason: `${dept.name} has ${active.length} jobs on the board and one agent doing everything alone.` };
      else if (agents > 1 && sum('pending') >= 3 && sum('running') >= agents) t = { kind: 'queue', departmentId: dept.id, reason: `${dept.name} is drowning: ${sum('pending')} tasks waiting and all ${agents} agents busy.` };
      else if (failed >= 2) t = { kind: 'failures', departmentId: dept.id, reason: `${dept.name} has ${failed} failed tasks. Maybe they need someone with different skills.` };
      if (t && !this.recentlyCalled(t)) return t;
    }
    return null;
  }

  private recentlyCalled(t: HiringTrigger): boolean {
    const since = new Date(this.now().getTime() - QUIET_MS).toISOString();
    const rows = this.d.db.prepare('SELECT trigger_json FROM hiring_request WHERE department_id IS ? AND created_at > ?').all(t.departmentId, since) as { trigger_json: string }[];
    return rows.some((r) => (JSON.parse(r.trigger_json) as HiringTrigger).kind === t.kind);
  }

  /** The models Hermes offers and NEAR AI's prices for them; either is empty when its source is down. */
  private async offeredModels(): Promise<{ all: ModelChoice[]; prices: PriceList | null }> {
    let models: HermesModelsView | null = null;
    try { models = await this.d.provisioning.hermesModels(); } catch { /* Hermes down: keep the floor's model */ }
    let prices: PriceList | null = null;
    try { prices = (await this.d.prices?.list()) ?? null; } catch { /* price list down: guess from names */ }
    return { all: models?.providers.flatMap((p) => p.models.map((id) => ({ provider: p.slug, id }))) ?? [], prices };
  }

  /** Builds three candidates that fit the brief. Loadouts only use models Hermes offers and skills Hermes has installed. */
  private async scout(requestId: string, brief: HiringBrief): Promise<Candidate[]> {
    const inv = this.d.departments.getInventory(brief.departmentId);
    const { all, prices } = await this.offeredModels();
    let installed: string[] = [];
    try { installed = (await this.d.provisioning.hermesDefaults()).skills.map((s) => s.name); } catch { /* unknown */ }
    const pool = all.length ? all : inv.model ? [inv.model] : [];
    const seed = hash(`${requestId}:${brief.departmentId}`);
    // Real prices: only models Hermes offers that NEAR AI prices and that can run an agent (text + tools), cheapest first.
    const priced = prices && prices.size ? pool.filter((m) => prices!.has(m.id)) : [];
    const price = (m: ModelChoice | null) => (m && prices?.get(m.id)) || null;
    // Cost per day: the model's real NEAR AI price, else a guess from the size its name suggests (labelled as one).
    const cost = (m: ModelChoice) => { const p = price(m); return p ? dailyCredits(p) : TIER_COST[modelTier(m.id)]; };
    const ranked = [...(priced.length ? priced : pool)].sort((a, b) => cost(a) - cost(b));
    const within = ranked.filter((m) => cost(m) <= brief.budgetPerDay);
    const vendor = (m: ModelChoice) => m.id.split('/')[0];
    // Three fits: the Chief of Staff's model when Hermes offers it, then the strongest the budget buys (a different
    // vendor each when it can). ponytail: price stands in for strength; a benchmark score would rank better.
    const picks: ModelChoice[] = [];
    const add = (m: ModelChoice | undefined) => { if (m && picks.length < 3 && !picks.some((x) => x.id === m.id)) picks.push(m); };
    add(ranked.find((m) => m.id === brief.model));
    for (const m of [...within].reverse()) if (!picks.some((x) => vendor(x) === vendor(m))) add(m);
    for (const m of [...within].reverse()) add(m);
    for (const m of ranked) add(m); // the budget buys fewer than three: the cheapest above it, marked over budget
    const tierOf = (m: ModelChoice | null) => { const p = price(m); return p ? priceTier(dailyCredits(p)) : m ? modelTier(m.id) : 2; };

    const known = installed.length ? new Set(installed) : null;
    const wanted = brief.skills.filter((s) => !known || known.has(s));
    const words = brief.focus.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const related = installed.filter((s) => !wanted.includes(s) && words.some((w) => s.toLowerCase().includes(w))).slice(0, 2);
    const skills = [...new Set([...wanted, ...inv.allowedSkillIds.filter((s) => !known || known.has(s)), ...related])].slice(0, 8);

    const fit = (cost: number, tier: number) => {
      const need = brief.skills.length ? brief.skills.filter((s) => skills.includes(s)).length / brief.skills.length : 0.8;
      const budget = cost <= brief.budgetPerDay ? 1 : Math.max(0, 1 - (cost - brief.budgetPerDay) / brief.budgetPerDay);
      return Math.round(Math.min(98, 30 * need + 30 * budget + 12 * tier + 20));
    };
    const slots: (ModelChoice | null)[] = picks.length ? picks : [null];
    const fits = slots.map((m) => {
      const tier = tierOf(m), c = m ? cost(m) : TIER_COST[2];
      return { model: m, tier, cost: c, fit: fit(c, tier), mine: !!m && m.id === brief.model };
    }).sort((a, b) => b.fit - a.fit || a.cost - b.cost);
    const personas = await this.seriousPersonas(brief, fits.map((f) => ({ model: f.model?.id ?? 'unknown', skills, label: `${TIER[f.tier]} model` })));
    const usd = (credits: number) => `$${(credits / 100).toFixed(2)}`;
    return fits.map((f, i) => {
      const p = personas[i], pr = price(f.model);
      const ch = this.persona(`${seed}:s${i}`, p?.name, p?.traits, p?.speechStyle, p?.quirk, `${brief.departmentName} specialist`.slice(0, 80));
      return CandidateSchema.parse({
        id: randomUUID(), serious: true, character: ch, gag: null,
        pitch: p?.pitch ?? `I'll keep ${brief.departmentName}'s queue moving and get the ${brief.focus.toLowerCase()} right.`,
        loadout: { model: f.model, skills, toolsets: [] }, tier: f.tier, costPerDay: f.cost, fitScore: f.fit,
        note: [
          f.mine ? 'The model I recommended.' : '',
          f.cost > brief.budgetPerDay ? `Over the ${usd(brief.budgetPerDay)} a day budget.` : 'Within budget.',
          f.model ? '' : 'Hermes offered no model list, so the floor keeps its model.',
          pr ? `NEAR AI price: ${priceNote(pr)}.` : f.model ? 'Price unknown, cost guessed from the model name.' : '',
        ].filter(Boolean).join(' '),
      });
    });
  }

  /** Asks AR's model to write the candidates' personas. Falls back to the generated pools. */
  private async seriousPersonas(brief: HiringBrief, slots: { model: string; skills: string[]; label: string }[]) {
    type P = { name?: string; pitch?: string; traits: string[]; speechStyle: string; quirk: string };
    if (!this.d.model.ready) return [] as P[];
    try {
      const raw = await this.d.model.complete([
        { role: 'system', content: 'You write short, fun but professional candidate personas for a game where employees are AI agents. Original invented names only, never real people. Reply with JSON only.' },
        { role: 'user', content: `Role: ${brief.focus} for the ${brief.departmentName} floor. ${slots.length} candidates:\n${slots.map((s, i) => `${i + 1}. ${s.label}: model ${s.model}, skills ${s.skills.join(', ') || 'none'}`).join('\n')}\nReturn {"candidates": [{"name": "First Last", "pitch": "<one sentence, first person, under 25 words>", "traits": ["<two adjectives>"], "speechStyle": "<few words>", "quirk": "<a visible desk habit>"}, ...]} in the same order.` },
      ], { maxTokens: 500, temperature: 0.9 });
      const obj = JSON.parse(extractJson(raw) ?? 'null') as { candidates?: unknown } | null;
      const list = Array.isArray(obj?.candidates) ? obj!.candidates as Record<string, unknown>[] : [];
      return list.slice(0, slots.length).map((c): P => ({
        ...(typeof c.name === 'string' && c.name.trim() ? { name: c.name.trim().slice(0, 40) } : {}),
        ...(typeof c.pitch === 'string' && c.pitch.trim() ? { pitch: c.pitch.trim().slice(0, 220) } : {}),
        traits: Array.isArray(c.traits) ? c.traits.filter((t): t is string => typeof t === 'string').slice(0, 3).map((t) => t.slice(0, 20)) : [],
        speechStyle: typeof c.speechStyle === 'string' ? c.speechStyle.slice(0, 80) : '',
        quirk: typeof c.quirk === 'string' ? c.quirk.slice(0, 80) : '',
      }));
    } catch { return [] as P[]; }
  }

  private persona(seedKey: string, name?: string, traits?: string[], style?: string, quirk?: string, title = 'Candidate'): Character {
    const seed = hash(seedKey);
    return {
      departmentId: 'candidate', agentKey: `cand-${seed.toString(16)}`, role: 'worker',
      name: name || `${pick(FIRST, seed, 1)} ${pick(LAST, seed, 2)}`, title,
      traits: traits?.length ? traits : [pick(TRAITS, seed, 3), pick(TRAITS, seed, 4)],
      speechStyle: style || pick(STYLES, seed, 5), quirk: quirk || pick(QUIRKS, seed, 6),
      color: pick(COLORS, seed, 7), voice: 180 + (hash(`${seed}:8`) % 260),
    };
  }

  private view(r: Row): HiringRequestView {
    // Rows from before scouting was instant: the first read after their timer moves them to the shortlist.
    if (r.state === 'scouting' && r.scouting_until && Date.parse(r.scouting_until) <= this.now().getTime()) r = this.setState(r.id, 'shortlist');
    const showCandidates = r.state === 'shortlist' || r.state === 'hired';
    return {
      id: r.id, state: r.state, trigger: JSON.parse(r.trigger_json) as HiringTrigger, ar: this.ar(),
      brief: r.brief_json ? HiringBriefSchema.parse(JSON.parse(r.brief_json)) : null,
      scoutingUntil: r.scouting_until, candidates: showCandidates ? this.candidates(r.id) : [], hiredCandidateId: r.hired_candidate_id,
      applied: r.applied_json ? JSON.parse(r.applied_json) : null, createdAt: r.created_at,
    };
  }

  private candidates(id: string): Candidate[] {
    return (this.d.db.prepare('SELECT candidate_json FROM hiring_candidate WHERE request_id = ? ORDER BY idx').all(id) as { candidate_json: string }[])
      .map((c) => CandidateSchema.parse(JSON.parse(c.candidate_json)));
  }
  /** A hiring talk is on: a call, or candidates on the boss's screen. */
  isOpen(): boolean { return !!this.openRow(); }
  private iso() { return this.now().toISOString(); }
  private openRow(): Row | undefined {
    return this.d.db.prepare("SELECT * FROM hiring_request WHERE state NOT IN ('hired', 'closed') ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
  }
  private row(id: string): Row {
    const r = this.d.db.prepare('SELECT * FROM hiring_request WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError('hiring request not found');
    return r;
  }
  private candidateRow(id: string, candidateId: string) {
    const c = this.d.db.prepare('SELECT * FROM hiring_candidate WHERE id = ? AND request_id = ?').get(candidateId, id) as { candidate_json: string } | undefined;
    if (!c) throw new NotFoundError('candidate not found');
    return c;
  }
  private insert(t: HiringTrigger, state: HiringState): Row {
    const id = randomUUID(), now = this.iso();
    this.d.db.prepare('INSERT INTO hiring_request (id, state, trigger_json, department_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, state, JSON.stringify(t), t.departmentId, now, now);
    return this.row(id);
  }
  private setState(id: string, state: HiringState): Row {
    this.d.db.prepare('UPDATE hiring_request SET state = ?, updated_at = ? WHERE id = ?').run(state, this.iso(), id);
    return this.row(id);
  }
}

function extractJson(raw: string): string | null {
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  return a >= 0 && b > a ? clean.slice(a, b + 1) : null;
}

/** Reads {say, mood, replies, ...}; anything unparseable becomes plain speech. */
export function parseJsonReply(raw: string): { say: string; mood: Mood; replies: string[]; obj: Record<string, unknown> | null } {
  let obj: Record<string, unknown> | null = null;
  const j = extractJson(raw);
  if (j) { try { obj = JSON.parse(j) as Record<string, unknown>; } catch { obj = null; } }
  if (!obj || typeof obj.say !== 'string' || !obj.say.trim()) {
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*|```/gi, '').trim();
    // a reply cut off by the token limit (or prose followed by its JSON): never show the JSON, keep its "say"
    const said = /"say"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(clean)?.[1];
    let say = clean.split(/\{\s*"say"/)[0]!.trim();
    if (!say && said) { try { say = JSON.parse(`"${said}"`) as string; } catch { say = said; } }
    return { say: say.slice(0, 1200) || '…', mood: 'neutral', replies: [], obj: null };
  }
  const mood = (MOODS as readonly string[]).includes(obj.mood as string) ? (obj.mood as Mood) : 'neutral';
  const replies = Array.isArray(obj.replies) ? obj.replies.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 3) : [];
  return { say: obj.say.trim().slice(0, 1200), mood, replies, obj };
}

/** The Chief of Staff's `hire` field as a brief for a floor that exists (by exact name, else a close one); null otherwise. */
export function briefOf(raw: unknown, floors: { id: string; name: string }[]): HiringBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const key = String(b.department ?? b.departmentName ?? '').trim().toLowerCase();
  const dept = floors.find((d) => d.name.toLowerCase() === key) ?? floors.find((d) => key && (d.name.toLowerCase().includes(key) || key.includes(d.name.toLowerCase())));
  if (!dept) return null;
  const budget = Math.round(Number(b.budgetPerDay ?? b.budget ?? 150));
  const parsed = HiringBriefSchema.safeParse({
    departmentId: dept.id, departmentName: dept.name,
    focus: String(b.focus ?? '').slice(0, 200) || `Help ${dept.name} with its jobs`,
    skills: Array.isArray(b.skills) ? b.skills.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().slice(0, 100)).slice(0, 10) : [],
    budgetPerDay: Number.isFinite(budget) ? Math.min(100_000, Math.max(1, budget)) : 150,
    notes: String(b.notes ?? '').slice(0, 500),
    ...(typeof b.model === 'string' && b.model.trim() ? { model: b.model.trim().slice(0, 200) } : {}),
  });
  return parsed.success ? parsed.data : null;
}
