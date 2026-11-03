/* AR (Agent Resources): scouting and hiring (feature spec 7.1).
   AR watches the boards with a few plain rules and calls the CEO when a floor needs people. The intake is a chat with
   AR's head that ends in a brief; AR then scouts two serious candidates (loadouts built from what Hermes really has:
   its models and installed skills) and two joke candidates (an original, curated cast whose numbers are honestly bad).
   Nothing changes in Hermes until the offer. An offer adds one worker seat, the candidate's skills and model to the
   department inventory, then re-provisions the department through the normal path. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  CandidateSchema, HiringBriefSchema, HiringMessageSchema, MAX_WORKERS_CEILING, MOODS,
  type Candidate, type Character, type HiringBrief, type HiringMessage, type HiringRequestView, type HiringState,
  type HiringTrigger, type HermesModelsView, type InterviewReply, type ChatMessage, type Mood, type ModelChoice, type QuestSummary,
} from '@vibe-city/shared';
import type { ChatModel, ChatTurn } from '../model/chatModel.ts';
import { ModelUnavailableError } from '../model/chatModel.ts';
import type { DepartmentService } from './departmentService.ts';
import type { ProvisioningService } from './provisioningService.ts';
import { COLORS, FIRST, LAST, QUIRKS, STYLES, TRAITS, hash, pick } from './characters.ts';
import { ConflictError, InvalidInputError, NotFoundError } from './errors.ts';

export interface HiringDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  provisioning: Pick<ProvisioningService, 'hermesModels' | 'hermesDefaults' | 'provision'>;
  quests: (departmentId: string) => Promise<QuestSummary[]>;
  model: ChatModel;
  companyId: () => string;
  companyName: () => string;
  /** How long scouting takes before the shortlist shows (the demo theatre). Default 45 s. */
  scoutMs?: number;
  /** Store the hire's persona on its new seat so the office and dialogue window show the same person. */
  savePersona?: (departmentId: string, agentKey: string, c: Character) => void;
  now?: () => Date;
}

const ACTIVE = new Set(['queued', 'planning', 'running', 'awaiting_input', 'in_review']);
/** Don't call again about the same floor and reason within this window. */
const QUIET_MS = 6 * 3600_000;

interface Row {
  id: string; state: HiringState; trigger_json: string; department_id: string | null; brief_json: string | null;
  messages_json: string; scouting_until: string | null; hired_candidate_id: string | null; applied_json: string | null;
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

/* The joke cast: original personas played for laughs, never real people or groups. */
const JOKES = [
  { gag: 'intern', title: 'Overconfident intern', pitch: "I've used AI for three whole weeks, so I'm basically a founder. I'll need the corner office and a ring light.", style: 'hype, buzzwords, zero substance', quirk: 'films a vlog during every task', traits: ['overconfident', 'loud'], cost: 900, fit: 8, note: 'Demands equity. Has never finished a task.' },
  { gag: 'frazzled', title: 'Burned-out veteran', pitch: 'Per my last email, I can do the job. Please do not schedule a sync about it.', style: 'tired, passive-aggressive, everything is "per my last email"', quirk: 'answers every question with a forwarded email', traits: ['exhausted', 'passive-aggressive'], cost: 70, fit: 17, note: 'Cheap, but only ever replies with "noted".' },
  { gag: 'shades', title: 'Visionary disruptor', pitch: 'Every task is a token launch if you believe hard enough. I only work in moonshots.', style: 'grandiose, says "paradigm" a lot', quirk: 'wears sunglasses at night, indoors', traits: ['grandiose', 'unfocused'], cost: 4200, fit: 3, note: 'Costs more than the whole floor. Brought no relevant skills.' },
  { gag: 'guru', title: 'Productivity guru', pitch: "I don't do tasks, I do frameworks. Here's a 40-slide deck about your to-do list.", style: 'motivational poster energy', quirk: 'rebrands every task as a "journey"', traits: ['preachy', 'slow'], cost: 1500, fit: 11, note: 'Will turn one task into a five-week workshop.' },
] as const;

const AR_TRAITS = ['sharp', 'blunt'];

export class HiringService {
  private d: HiringDeps;
  private scoutMs: number;
  private now: () => Date;
  constructor(d: HiringDeps) { this.d = d; this.scoutMs = d.scoutMs ?? 45_000; this.now = d.now ?? (() => new Date()); }

  /** AR's head: a recurring character, the same for the whole company. */
  ar(): Character {
    const seed = hash(`${this.d.companyId()}:ar`);
    return {
      departmentId: 'company', agentKey: 'ar', role: 'chief',
      name: `${pick(FIRST, seed, 1)} ${pick(LAST, seed, 2)}`, title: 'Head of Agent Resources',
      traits: AR_TRAITS, speechStyle: 'brisk headhunter, dry humour, calls you "boss"', quirk: 'never without the clipboard',
      color: '#7CF5B4', voice: 250 + (seed % 60),
    };
  }

  // ---- requests ---------------------------------------------------------------------------------------------------

  /** The open request, if any; otherwise run the trigger rules and ring when one fires. */
  async current(): Promise<HiringRequestView | null> {
    const open = this.openRow();
    if (open) return this.view(open);
    const t = await this.checkTriggers();
    return t ? this.view(this.insert(t, 'ringing')) : null;
  }

  /** The CEO calls AR (from the Exec Office or a floor). Reuses an open request. */
  start(departmentId?: string): HiringRequestView {
    const open = this.openRow();
    if (open) return this.view(open.state === 'ringing' ? this.setState(open.id, 'intake') : open);
    let reason = 'You called AR.';
    if (departmentId) { const dept = this.d.departments.get(departmentId); reason = `You called AR about ${dept.name}.`; }
    return this.view(this.insert({ kind: 'manual', departmentId: departmentId ?? null, reason }, 'intake'));
  }

  get(id: string): HiringRequestView { return this.view(this.row(id)); }

  answer(id: string): HiringRequestView {
    const r = this.row(id);
    if (r.state !== 'ringing') return this.view(r);
    return this.view(this.setState(id, 'intake'));
  }

  decline(id: string): HiringRequestView {
    const r = this.row(id);
    if (r.state === 'hired' || r.state === 'closed') return this.view(r);
    return this.view(this.setState(id, 'closed'));
  }

  // ---- intake chat ------------------------------------------------------------------------------------------------

  async send(id: string, message: string): Promise<HiringRequestView> {
    const r = this.row(id);
    if (r.state !== 'intake' && r.state !== 'ringing') throw new ConflictError(`the intake is over (request is ${r.state})`);
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const past = this.messages(r);
    const system = await this.intakePrompt(r);
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...past.slice(-14).map((m): ChatTurn => (m.from === 'user' ? { role: 'user', content: m.text }
        : { role: 'assistant', content: JSON.stringify({ say: m.text, mood: m.mood, replies: m.replies, brief: m.brief }) })),
      { role: 'user', content: message },
    ];
    const raw = await this.d.model.complete(turns, { maxTokens: 700 });
    const user = HiringMessageSchema.parse({ id: randomUUID(), from: 'user', text: message, mood: null, replies: [], brief: null, at: this.iso() });
    const parsed = parseJsonReply(raw);
    const brief = parsed.obj ? this.resolveBrief(parsed.obj.brief, r) : null;
    const agent = HiringMessageSchema.parse({
      id: randomUUID(), from: 'agent', text: parsed.say, mood: parsed.mood, replies: parsed.replies, brief, at: this.iso(),
    });
    this.d.db.prepare("UPDATE hiring_request SET messages_json = ?, state = 'intake', brief_json = COALESCE(?, brief_json), updated_at = ? WHERE id = ?")
      .run(JSON.stringify([...past, user, agent]), brief ? JSON.stringify(brief) : null, this.iso(), id);
    return this.get(id);
  }

  /** The CEO confirms the brief (optionally edited). AR leaves to scout; the shortlist shows after the timer. */
  async confirmBrief(id: string, edited?: Omit<HiringBrief, 'departmentName'>): Promise<HiringRequestView> {
    const r = this.row(id);
    if (r.state !== 'intake') throw new ConflictError(`cannot confirm a brief now (request is ${r.state})`);
    let brief = r.brief_json ? HiringBriefSchema.parse(JSON.parse(r.brief_json)) : null;
    if (edited) {
      const dept = this.d.departments.get(edited.departmentId);
      brief = HiringBriefSchema.parse({ ...edited, departmentName: dept.name });
    }
    if (!brief) throw new InvalidInputError('AR has no brief yet: tell AR what you need first');
    const candidates = await this.scout(r.id, brief);
    const until = new Date(this.now().getTime() + this.scoutMs).toISOString();
    this.d.db.prepare("UPDATE hiring_request SET state = 'scouting', brief_json = ?, department_id = ?, scouting_until = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(brief), brief.departmentId, until, this.iso(), id);
    const ins = this.d.db.prepare('INSERT INTO hiring_candidate (id, request_id, idx, candidate_json) VALUES (?, ?, ?, ?)');
    candidates.forEach((c, i) => ins.run(c.id, id, i, JSON.stringify(c)));
    return this.get(id);
  }

  // ---- interviews -------------------------------------------------------------------------------------------------

  candidateHistory(id: string, candidateId: string): { candidate: Candidate; messages: ChatMessage[] } {
    const c = this.candidateRow(id, candidateId);
    return { candidate: CandidateSchema.parse(JSON.parse(c.candidate_json)), messages: JSON.parse(c.interview_json) as ChatMessage[] };
  }

  async interview(id: string, candidateId: string, message: string): Promise<InterviewReply> {
    const r = this.row(id);
    if (r.state !== 'shortlist') throw new ConflictError(`interviews happen on the shortlist (request is ${r.state})`);
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const { candidate: c, messages } = this.candidateHistory(id, candidateId);
    const brief = HiringBriefSchema.parse(JSON.parse(r.brief_json!));
    const system = [
      `You are ${c.character.name}, a job candidate interviewing with the CEO of ${this.d.companyName()}, a company in the game Vibe City whose employees are AI agents.`,
      `The role: ${brief.focus} on the ${brief.departmentName} floor.`,
      `Your personality: ${c.character.traits.join(', ')}. Way of speaking: ${c.character.speechStyle}. Quirk: ${c.character.quirk}.`,
      `Your pitch: "${c.pitch}". Your loadout: model ${c.loadout.model ? c.loadout.model.id : 'unknown'}, skills ${c.loadout.skills.join(', ') || 'none'}.`,
      c.serious
        ? 'You are a serious candidate. If asked a test question, actually answer it well and briefly. Stay in character.'
        : 'You are a joke candidate, played for laughs: stay in character, be confidently unhelpful, never answer a test question properly. Keep it light: no insults about real people or groups.',
      'Rules: at most 3 short sentences, under 60 words. Never claim to have done work for this company.',
      `Reply with JSON only: {"say": "<what you say>", "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 short things the CEO might ask next]}`,
    ].join('\n');
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...messages.slice(-10).map((m): ChatTurn => (m.from === 'user' ? { role: 'user', content: m.text } : { role: 'assistant', content: JSON.stringify({ say: m.text, mood: m.mood, replies: m.replies }) })),
      { role: 'user', content: message },
    ];
    // A serious candidate answers on its own model when that model is served by the chat provider (NEAR AI Cloud).
    const own = c.serious && c.loadout.model && /near/i.test(c.loadout.model.provider) ? c.loadout.model.id : undefined;
    const t0 = Date.now();
    const run = this.d.model.run
      ? await this.d.model.run(turns, { maxTokens: 400, ...(own ? { model: own } : {}) })
      : { content: await this.d.model.complete(turns, { maxTokens: 400 }), tokens: null, model: 'chat model' };
    const ms = Date.now() - t0;
    const p = parseJsonReply(run.content);
    const user: ChatMessage = { id: randomUUID(), from: 'user', text: message, mood: null, replies: [], proposal: null, at: this.iso() };
    const agent: ChatMessage = { id: randomUUID(), from: 'agent', text: p.say, mood: p.mood, replies: p.replies, proposal: null, at: this.iso() };
    this.d.db.prepare('UPDATE hiring_candidate SET interview_json = ? WHERE id = ?').run(JSON.stringify([...messages, user, agent]), candidateId);
    return {
      user, agent,
      stats: {
        ms, tokens: run.tokens, model: run.model,
        costNote: own ? `Answered on the candidate's own model (${own}).` : `Answered by the chat model (${run.model}); the candidate's model is not served by the chat provider.`,
      },
    };
  }

  // ---- offer ------------------------------------------------------------------------------------------------------

  async offer(id: string, candidateId: string, acceptConcerns = false): Promise<HiringRequestView> {
    const r = this.row(id);
    if (r.state !== 'shortlist') throw new ConflictError(`no shortlist to hire from (request is ${r.state})`);
    const { candidate: c } = this.candidateHistory(id, candidateId);
    if (!c.serious && !acceptConcerns) throw new ConflictError('AR has concerns about this candidate: confirm to hire anyway');
    const brief = HiringBriefSchema.parse(JSON.parse(r.brief_json!));
    const inv = this.d.departments.getInventory(brief.departmentId);
    const before = inv.limits.maxConcurrentWorkers;
    if (before >= MAX_WORKERS_CEILING) throw new ConflictError(`${brief.departmentName} is already at the ${MAX_WORKERS_CEILING}-worker ceiling`);
    const after = before + 1;
    const skillsAdded = c.loadout.skills.filter((s) => !inv.allowedSkillIds.includes(s));
    this.d.departments.patchInventory(brief.departmentId, {
      limits: { maxConcurrentWorkers: after },
      ...(skillsAdded.length ? { allowedSkillIds: [...inv.allowedSkillIds, ...skillsAdded] } : {}),
      ...(c.loadout.model ? { model: c.loadout.model } : {}),
    });
    const seat = `W-${String(after).padStart(2, '0')}`;
    this.d.savePersona?.(brief.departmentId, seat, { ...c.character, departmentId: brief.departmentId, agentKey: seat, role: 'worker', title: `${brief.departmentName} specialist, desk ${seat}` });
    // Re-apply the inventory to Hermes through the normal path. It runs in the background; the floor shows progress.
    let provisioning = 'started';
    try { void this.d.provisioning.provision(brief.departmentId).catch(() => undefined); } catch (e) { provisioning = (e as Error).message; }
    const applied = { departmentId: brief.departmentId, seat, workersBefore: before, workersAfter: after, skillsAdded, model: c.loadout.model, provisioning };
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
      const workers = this.d.departments.getInventory(dept.id).limits.maxConcurrentWorkers;
      const sum = (k: keyof QuestSummary['counts']) => active.reduce((n, q) => n + q.counts[k], 0);
      const failed = quests.reduce((n, q) => n + q.counts.failed, 0);
      let t: HiringTrigger | null = null;
      if (workers === 0 && active.length >= 2) t = { kind: 'no_workers', departmentId: dept.id, reason: `${dept.name} has no workers and ${active.length} quests on the board. The chief is doing everything alone.` };
      else if (workers > 0 && sum('pending') >= 3 && sum('running') >= workers) t = { kind: 'queue', departmentId: dept.id, reason: `${dept.name} is drowning: ${sum('pending')} tasks waiting and all ${workers} desks busy.` };
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

  private async intakePrompt(r: Row): Promise<string> {
    const ar = this.ar();
    const trigger = JSON.parse(r.trigger_json) as HiringTrigger;
    const depts = this.d.departments.list().map((d) => {
      const inv = this.d.departments.getInventory(d.id);
      return `- "${d.name}" (id ${d.id}): ${d.purpose || 'no purpose written'}; ${inv.limits.maxConcurrentWorkers} worker seats; skills: ${inv.allowedSkillIds.join(', ') || 'none'}`;
    });
    let skills: string[] = [];
    try { skills = (await this.d.provisioning.hermesDefaults()).skills.map((s) => s.name).slice(0, 60); } catch { /* Hermes down */ }
    return [
      `You are ${ar.name}, ${ar.title} at ${this.d.companyName()}, a company in the game Vibe City whose employees are AI agents.`,
      `Personality: ${ar.traits.join(', ')}. Way of speaking: ${ar.speechStyle}. Quirk: ${ar.quirk}.`,
      `You are on a call with the CEO ("boss") about a new hire. Why you are talking: ${trigger.reason}`,
      `Floors:\n${depts.join('\n') || '- none yet'}`,
      skills.length ? `Skills installed in Hermes (a hire can only get these): ${skills.join(', ')}` : 'The list of installed skills is unavailable right now.',
      '',
      'Your job in this call: find out which floor the hire is for, what they should be good at, the daily budget in credits, and any must-have skills. Ask one thing at a time.',
      'When you know enough, sum it up as a brief. The boss confirms it, then you go scouting. You do not hire anyone in this call.',
      '- Your words appear in a retro game dialogue box: at most 3 short sentences, under 60 words.',
      '- Reply with JSON only, no other text:',
      `{"say": "<what you say>", "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short answers the boss might give, each under 40 characters], "brief": null or {"department": "<floor name>", "focus": "<what the hire is good at>", "skills": ["<installed skill names>"], "budgetPerDay": <integer credits>, "notes": "<anything else>"}}`,
    ].join('\n');
  }

  private resolveBrief(raw: unknown, r: Row): HiringBrief | null {
    if (!raw || typeof raw !== 'object') return null;
    const b = raw as Record<string, unknown>;
    const depts = this.d.departments.list();
    const key = String(b.department ?? b.departmentId ?? b.departmentName ?? '').trim().toLowerCase();
    const dept = depts.find((d) => d.id === key || d.name.toLowerCase() === key)
      ?? depts.find((d) => key && (d.name.toLowerCase().includes(key) || key.includes(d.name.toLowerCase())))
      ?? (r.department_id ? depts.find((d) => d.id === r.department_id) : undefined);
    if (!dept) return null;
    const budget = Math.round(Number(b.budgetPerDay ?? b.budget ?? 150));
    const parsed = HiringBriefSchema.safeParse({
      departmentId: dept.id, departmentName: dept.name,
      focus: String(b.focus ?? '').slice(0, 200) || `Help ${dept.name} with its quests`,
      skills: Array.isArray(b.skills) ? b.skills.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim().slice(0, 100)).slice(0, 10) : [],
      budgetPerDay: Number.isFinite(budget) ? Math.min(100_000, Math.max(1, budget)) : 150,
      notes: String(b.notes ?? '').slice(0, 500),
    });
    return parsed.success ? parsed.data : null;
  }

  /** Builds the four candidates. Serious loadouts only use models Hermes offers and skills Hermes has installed. */
  private async scout(requestId: string, brief: HiringBrief): Promise<Candidate[]> {
    const inv = this.d.departments.getInventory(brief.departmentId);
    let models: HermesModelsView | null = null;
    try { models = await this.d.provisioning.hermesModels(); } catch { /* Hermes down: keep the floor's model */ }
    let installed: string[] = [];
    try { installed = (await this.d.provisioning.hermesDefaults()).skills.map((s) => s.name); } catch { /* unknown */ }
    const all: ModelChoice[] = models?.providers.flatMap((p) => p.models.map((id) => ({ provider: p.slug, id }))) ?? [];
    const pool = all.length ? all : inv.model ? [inv.model] : [];
    const byTier = (t: number) => pool.filter((m) => modelTier(m.id) === t);
    const cheapest = byTier(1)[0] ?? byTier(2)[0] ?? pool[0] ?? null;
    const balanced = byTier(2)[0] ?? byTier(1)[0] ?? pool[0] ?? null;
    const premium = byTier(3)[0] ?? [...byTier(2)].reverse().find((m) => m.id !== balanced?.id) ?? balanced;

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
    const seed = hash(`${requestId}:${brief.departmentId}`);
    const serious = [
      { model: balanced, skills: baseSkills, label: 'balanced' },
      { model: premium, skills: premiumSkills, label: 'premium' },
    ].map((s, i) => {
      const tier = s.model ? modelTier(s.model.id) : 2;
      // Same size class as the balanced pick: the premium hire still asks for more (more skills, senior rate).
      const cost = Math.round(TIER_COST[tier] * (s.label === 'premium' ? 1.6 : 1)) + 10 * s.skills.length;
      return { ...s, tier, cost, fit: fit(s.skills, cost, tier), i };
    });
    const personas = await this.seriousPersonas(brief, serious.map((s) => ({ model: s.model?.id ?? 'unknown', skills: s.skills, label: s.label })));

    const out: Candidate[] = serious.map((s, i) => {
      const p = personas[i];
      const ch = this.persona(`${seed}:s${i}`, p?.name, p?.traits, p?.speechStyle, p?.quirk, `${s.label === 'premium' ? 'Senior' : 'Steady'} ${brief.departmentName} specialist`.slice(0, 80));
      const overBudget = s.cost > brief.budgetPerDay;
      return CandidateSchema.parse({
        id: randomUUID(), serious: true, character: ch, gag: null,
        pitch: p?.pitch ?? (s.label === 'premium' ? `Bigger model, more skills. I'll take the hard ${brief.departmentName} quests and get them right the first time.` : `Reliable and affordable. I'll keep ${brief.departmentName}'s queue moving without burning the budget.`),
        loadout: { model: s.model, skills: s.skills, toolsets: [] }, tier: s.tier, costPerDay: s.cost, fitScore: s.fit,
        note: `${s.label === 'premium' ? 'Premium' : 'Balanced'} pick.${overBudget ? ` Over the ${brief.budgetPerDay} credit budget.` : ' Within budget.'}${s.model ? '' : ' Hermes offered no model list, so the floor keeps its model.'}`,
      });
    });
    const a = seed % JOKES.length, b = (a + 1 + (seed >>> 4) % (JOKES.length - 1)) % JOKES.length;
    for (const [k, j] of [a, b].map((x, k) => [k, JOKES[x]!] as const)) {
      const ch = this.persona(`${seed}:j${k}`, undefined, [...j.traits], j.style, j.quirk, j.title);
      const skills = offBrief.length ? [offBrief[(seed >>> (k + 3)) % offBrief.length]!] : [];
      out.push(CandidateSchema.parse({
        id: randomUUID(), serious: false, character: ch, gag: j.gag, pitch: j.pitch,
        loadout: { model: cheapest, skills, toolsets: [] }, tier: cheapest ? modelTier(cheapest.id) : 1,
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
    // Scouting ends by time: the first read after the timer moves the request to the shortlist.
    if (r.state === 'scouting' && r.scouting_until && Date.parse(r.scouting_until) <= this.now().getTime()) r = this.setState(r.id, 'shortlist');
    const showCandidates = r.state === 'shortlist' || r.state === 'hired';
    const candidates = showCandidates
      ? (this.d.db.prepare('SELECT candidate_json FROM hiring_candidate WHERE request_id = ? ORDER BY idx').all(r.id) as { candidate_json: string }[])
          .map((c) => CandidateSchema.parse(JSON.parse(c.candidate_json)))
      : [];
    return {
      id: r.id, state: r.state, trigger: JSON.parse(r.trigger_json) as HiringTrigger, ar: this.ar(), messages: this.messages(r),
      brief: r.brief_json ? HiringBriefSchema.parse(JSON.parse(r.brief_json)) : null,
      scoutingUntil: r.scouting_until, candidates, hiredCandidateId: r.hired_candidate_id,
      applied: r.applied_json ? JSON.parse(r.applied_json) : null, modelReady: this.d.model.ready, createdAt: r.created_at,
    };
  }

  private messages(r: Row): HiringMessage[] { return (JSON.parse(r.messages_json) as unknown[]).map((m) => HiringMessageSchema.parse(m)); }
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
    const c = this.d.db.prepare('SELECT * FROM hiring_candidate WHERE id = ? AND request_id = ?').get(candidateId, id) as { candidate_json: string; interview_json: string } | undefined;
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
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```[a-z]*|```/gi, '').trim().slice(0, 1200) || '…';
    return { say: text, mood: 'neutral', replies: [], obj: null };
  }
  const mood = (MOODS as readonly string[]).includes(obj.mood as string) ? (obj.mood as Mood) : 'neutral';
  const replies = Array.isArray(obj.replies) ? obj.replies.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 3) : [];
  return { say: obj.say.trim().slice(0, 1200), mood, replies, obj };
}
