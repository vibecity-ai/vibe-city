/* AR (Agent Resources): scouting and hiring (feature spec 7.1).
   AR watches the boards with a few plain rules and calls the CEO when a floor needs people. The talk is the Chief of
   Staff's own Hermes chat (chatService), which ends in a brief; confirming it shows two serious candidates (loadouts
   built from what Hermes really has: its models and installed skills) and two joke candidates (an original, curated cast
   whose numbers are honestly bad). `facts()` is what the Chief of Staff knows while hiring: the offered models with NEAR
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
/** Size class from real daily cost (credits = cents): under $0.30, under $3, above. */
export const priceTier = (credits: number): 1 | 2 | 3 => (credits <= 30 ? 1 : credits <= 300 ? 2 : 3);

/* The joke cast: original personas played for laughs, never real people or groups. */
const JOKES = [
  { gag: 'intern', title: 'Overconfident intern', pitch: "I've used AI for three whole weeks, so I'm basically a founder. I'll need the corner office and a ring light.", style: 'hype, buzzwords, zero substance', quirk: 'films a vlog during every task', traits: ['overconfident', 'loud'], cost: 900, fit: 8, note: 'Demands equity. Has never finished a task.' },
  { gag: 'frazzled', title: 'Burned-out veteran', pitch: 'Per my last email, I can do the job. Please do not schedule a sync about it.', style: 'tired, passive-aggressive, everything is "per my last email"', quirk: 'answers every question with a forwarded email', traits: ['exhausted', 'passive-aggressive'], cost: 70, fit: 17, note: 'Cheap, but only ever replies with "noted".' },
  { gag: 'shades', title: 'Visionary disruptor', pitch: 'Every task is a token launch if you believe hard enough. I only work in moonshots.', style: 'grandiose, says "paradigm" a lot', quirk: 'wears sunglasses at night, indoors', traits: ['grandiose', 'unfocused'], cost: 4200, fit: 3, note: 'Costs more than the whole floor. Brought no relevant skills.' },
  { gag: 'guru', title: 'Productivity guru', pitch: "I don't do tasks, I do frameworks. Here's a 40-slide deck about your to-do list.", style: 'motivational poster energy', quirk: 'rebrands every task as a "journey"', traits: ['preachy', 'slow'], cost: 1500, fit: 11, note: 'Will turn one task into a five-week workshop.' },
] as const;


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
    const cands = brief ? this.candidates(open!.id).map((c) => `- ${c.character.name} (${c.serious ? 'serious' : `joke candidate, your honest concern: ${c.note}`}): model ${c.loadout.model?.id ?? 'floor default'}, about ${usd(c.costPerDay)} a day, fit ${c.fitScore}/100, skills ${c.loadout.skills.join(', ') || 'none'}`) : [];
    return [
      modelFacts.length ? `Models Hermes offers (NEAR AI list prices; a day = 1M input + 100k output tokens, an estimate; "Private TEE"/"Incognito" is how sealed the model runs):\n${modelFacts.join('\n')}` : 'The list of models Hermes offers is unavailable right now: say so if asked, do not guess prices.',
      brief ? `Candidates on the boss's screen for "${brief.focus}" on ${brief.departmentName} (budget ${usd(brief.budgetPerDay)} a day), each with a Hire button; the boss hires, you never do. These cards are the only candidates: describe only these models, never claim a card has a model it does not:\n${cands.join('\n')}` : 'No candidates are on screen yet.',
    ].join('\n');
  }

  // ---- offer ------------------------------------------------------------------------------------------------------

  async offer(id: string, candidateId: string, acceptConcerns = false): Promise<HiringRequestView> {
    const r = this.row(id);
    if (r.state !== 'shortlist') throw new ConflictError(`no shortlist to hire from (request is ${r.state})`);
    const c = CandidateSchema.parse(JSON.parse(this.candidateRow(id, candidateId).candidate_json));
    if (!c.serious && !acceptConcerns) throw new ConflictError('The Chief of Staff has concerns about this candidate: confirm to hire anyway');
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

  /** Builds the four candidates. Serious loadouts only use models Hermes offers and skills Hermes has installed. */
  private async scout(requestId: string, brief: HiringBrief): Promise<Candidate[]> {
    const inv = this.d.departments.getInventory(brief.departmentId);
    const { all, prices } = await this.offeredModels();
    let installed: string[] = [];
    try { installed = (await this.d.provisioning.hermesDefaults()).skills.map((s) => s.name); } catch { /* unknown */ }
    const pool = all.length ? all : inv.model ? [inv.model] : [];
    const seed = hash(`${requestId}:${brief.departmentId}`);
    const pickOne = <T>(xs: T[], salt: string) => (xs.length ? xs[hash(`${seed}:${salt}`) % xs.length]! : null);
    // Real prices: only models Hermes offers that NEAR AI prices and that can run an agent (text + tools), cheapest first.
    const priced = prices && prices.size ? pool.filter((m) => prices!.has(m.id)) : [];
    const price = (m: ModelChoice | null) => (m && prices?.get(m.id)) || null;
    const daily = (m: ModelChoice) => dailyCredits(price(m)!);
    let cheapest: ModelChoice | null, balanced: ModelChoice | null, premium: ModelChoice | null;
    if (priced.length) {
      const ranked = [...priced].sort((a, b) => daily(a) - daily(b));
      const within = ranked.filter((m) => daily(m) <= brief.budgetPerDay);
      const vendor = (m: ModelChoice | null) => m?.id.split('/')[0];
      // Seeded picks so every shortlist differs: balanced from the cheaper half of what fits, premium from above it.
      cheapest = pickOne(ranked.slice(0, 5), 'cheap');
      // The model the Chief of Staff recommended in the brief, when Hermes offers it, is the balanced pick.
      balanced = ranked.find((m) => m.id === brief.model) ?? pickOne(within.slice(0, Math.ceil(within.length / 2)), 'bal') ?? ranked[0]!;
      const up = ranked.filter((m) => daily(m) > daily(balanced!));
      premium = pickOne(up.filter((m) => daily(m) <= brief.budgetPerDay && vendor(m) !== vendor(balanced)), 'prem')
        ?? pickOne(up.filter((m) => daily(m) <= brief.budgetPerDay), 'prem') ?? pickOne(up.slice(0, 3), 'prem') ?? balanced;
    } else {
      const byTier = (t: number) => pool.filter((m) => modelTier(m.id) === t);
      cheapest = byTier(1)[0] ?? byTier(2)[0] ?? pool[0] ?? null;
      balanced = pool.find((m) => m.id === brief.model) ?? byTier(2)[0] ?? byTier(1)[0] ?? pool[0] ?? null;
      premium = byTier(3)[0] ?? [...byTier(2)].reverse().find((m) => m.id !== balanced?.id) ?? balanced;
    }
    const tierOf = (m: ModelChoice | null) => { const p = price(m); return p ? priceTier(dailyCredits(p)) : m ? modelTier(m.id) : 2; };

    const known = installed.length ? new Set(installed) : null;
    const wanted = brief.skills.filter((s) => !known || known.has(s));
    const words = brief.focus.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const related = installed.filter((s) => !wanted.includes(s) && words.some((w) => s.toLowerCase().includes(w))).slice(0, 2);
    const baseSkills = [...new Set([...wanted, ...inv.allowedSkillIds.filter((s) => !known || known.has(s))])].slice(0, 6);
    const premiumSkills = [...new Set([...baseSkills, ...related])].slice(0, 8);
    const offBrief = installed.filter((s) => !brief.skills.includes(s) && !inv.allowedSkillIds.includes(s));

    const fit = (skills: string[], cost: number, tier: number) => {
      const need = brief.skills.length ? brief.skills.filter((s) => skills.includes(s)).length / brief.skills.length : 0.8;
      const budget = cost <= brief.budgetPerDay ? 1 : Math.max(0, 1 - (cost - brief.budgetPerDay) / brief.budgetPerDay);
      return Math.round(Math.min(98, 30 * need + 30 * budget + 12 * tier + 20));
    };
    const serious = [
      { model: balanced, skills: baseSkills, label: 'balanced' },
      { model: premium, skills: premiumSkills, label: 'premium' },
    ].map((s, i) => {
      const tier = tierOf(s.model);
      const p = price(s.model);
      // Priced: the model's real cost at DAY_TOKENS. Unpriced guess: the premium hire asks more (more skills, senior rate).
      const cost = p ? dailyCredits(p) : Math.round(TIER_COST[tier] * (s.label === 'premium' ? 1.6 : 1)) + 10 * s.skills.length;
      return { ...s, tier, cost, fit: fit(s.skills, cost, tier), i };
    });
    const personas = await this.seriousPersonas(brief, serious.map((s) => ({ model: s.model?.id ?? 'unknown', skills: s.skills, label: s.label })));

    const out: Candidate[] = serious.map((s, i) => {
      const p = personas[i];
      const ch = this.persona(`${seed}:s${i}`, p?.name, p?.traits, p?.speechStyle, p?.quirk, `${s.label === 'premium' ? 'Senior' : 'Steady'} ${brief.departmentName} specialist`.slice(0, 80));
      const overBudget = s.cost > brief.budgetPerDay;
      return CandidateSchema.parse({
        id: randomUUID(), serious: true, character: ch, gag: null,
        pitch: p?.pitch ?? (s.label === 'premium' ? `Bigger model, more skills. I'll take the hard ${brief.departmentName} jobs and get them right the first time.` : `Reliable and affordable. I'll keep ${brief.departmentName}'s queue moving without burning the budget.`),
        loadout: { model: s.model, skills: s.skills, toolsets: [] }, tier: s.tier, costPerDay: s.cost, fitScore: s.fit,
        note: `${s.label === 'premium' ? 'Premium' : 'Balanced'} pick.${overBudget ? ` Over the $${(brief.budgetPerDay / 100).toFixed(2)} a day budget.` : ' Within budget.'}${s.model ? '' : ' Hermes offered no model list, so the floor keeps its model.'}${price(s.model) ? ` NEAR AI price: ${priceNote(price(s.model)!)}.` : ' Price unknown, cost guessed from the model name.'}`,
      });
    });
    const a = seed % JOKES.length, b = (a + 1 + (seed >>> 4) % (JOKES.length - 1)) % JOKES.length;
    for (const [k, j] of [a, b].map((x, k) => [k, JOKES[x]!] as const)) {
      const ch = this.persona(`${seed}:j${k}`, undefined, [...j.traits], j.style, j.quirk, j.title);
      const skills = offBrief.length ? [offBrief[(seed >>> (k + 3)) % offBrief.length]!] : [];
      out.push(CandidateSchema.parse({
        id: randomUUID(), serious: false, character: ch, gag: j.gag, pitch: j.pitch,
        loadout: { model: cheapest, skills, toolsets: [] }, tier: cheapest ? tierOf(cheapest) : 1,
        costPerDay: j.cost, fitScore: j.fit, note: j.note,
      }));
    }
    // Shuffle so the jokes are not always last.
    return out.map((c, i) => ({ c, k: hash(`${seed}:${i}`) })).sort((x, y) => x.k - y.k).map((x) => x.c);
  }

  /** Asks AR's model to write the two serious personas. Falls back to the generated pools. */
  private async seriousPersonas(brief: HiringBrief, slots: { model: string; skills: string[]; label: string }[]) {
    type P = { name?: string; pitch?: string; traits: string[]; speechStyle: string; quirk: string };
    if (!this.d.model.ready) return [] as P[];
    try {
      const raw = await this.d.model.complete([
        { role: 'system', content: 'You write short, fun but professional candidate personas for a game where employees are AI agents. Original invented names only, never real people. Reply with JSON only.' },
        { role: 'user', content: `Role: ${brief.focus} for the ${brief.departmentName} floor. Two candidates:\n${slots.map((s, i) => `${i + 1}. ${s.label}: model ${s.model}, skills ${s.skills.join(', ') || 'none'}`).join('\n')}\nReturn {"candidates": [{"name": "First Last", "pitch": "<one sentence, first person, under 25 words>", "traits": ["<two adjectives>"], "speechStyle": "<few words>", "quirk": "<a visible desk habit>"}, ...]} in the same order.` },
      ], { maxTokens: 500, temperature: 0.9 });
      const obj = JSON.parse(extractJson(raw) ?? 'null') as { candidates?: unknown } | null;
      const list = Array.isArray(obj?.candidates) ? obj!.candidates as Record<string, unknown>[] : [];
      return list.slice(0, 2).map((c): P => ({
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
