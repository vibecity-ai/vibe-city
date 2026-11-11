/* Dialogue-window chat with one agent: the CEO talks to the agent's own Hermes profile (its model, tools, skills,
   memory and SOUL.md) through the gateway API server. Each chat is one Hermes session of the profile; the window opens on
   the last one used, and any earlier chat can be reopened and continued.
   Vibe City adds the persona, a snapshot of the department's board and the dialogue conventions, as an ephemeral system
   message, and keeps its own copy of the transcript for the window. Chat only talks (provisioning leaves it no tools that
   act): work is proposed as a quest, and the user's Accept creates it through the quest API. */
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CHIEF_OF_STAFF, isInternalOnly, type ChatBriefing, ChatMessageSchema, ChatProposalSchema, MOODS,
  type Character, type ChatHistory, type ChatMessage, type ChatReply, type ChatSend, type Mood,
} from '@vibe-city/shared';
import { ModelUnavailableError } from '../model/chatModel.ts';
import { HermesAuthError, HermesRejectedError, HermesUnavailableError, type HermesRuntime } from '../hermes/ports.ts';
import type { AgentChat, AgentChatEvent } from '../hermes/agentChat.ts';
import type { KanbanApi, RawTask } from '../hermes/kanbanApi.ts';
import type { FloorKit } from './assistantService.ts';
import type { DepartmentService } from './departmentService.ts';
import type { CharacterService } from './characters.ts';
import { ConflictError } from './errors.ts';

export interface ChatDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  characters: CharacterService;
  /** The gateway API server client. Omit: chat is unavailable (history still loads). */
  agentChat?: AgentChat;
  /** Extra variables every agent profile needs in its .env to answer through the gateway (its model provider's key). */
  /** Read on each first chat: the NEAR AI key can be pasted in the game after the backend started. */
  agentEnv?: (profile: string) => Record<string, string>;
  hermes: HermesRuntime;
  /** Reads the department's board for the chat's snapshot. Omit: the agent is told the board cannot be read. */
  kanban?: KanbanApi;
  companyName: () => string;
  /** The company's state in a few lines (CEO quests, money, decisions waiting), for the Chief of Staff's briefing. */
  companyStatus?: () => Promise<string>;
  /** What a custom floor may be built from, and the filter for the Chief of Staff's floor draft (assistantService). */
  floorKit?: () => Promise<FloorKit>;
}

interface ChatCreds { profile: string; api_key: string; session_id: string }

const newKey = () => randomBytes(24).toString('hex');
const newSession = () => `vibecity-ceo-${randomBytes(4).toString('hex')}`;

export class ChatService {
  private d: ChatDeps;
  /** Profiles answering right now: one turn at a time per agent (Hermes refuses a second write to a live session). */
  private busy = new Set<string>();
  /** Profiles whose .env was written by this process: credentials are re-synced once per start (a rotated key propagates). */
  private synced = new Set<string>();
  /** Task id -> title, from every board read for a prompt. ponytail: grows with the boards' tasks for the process's life. */
  private titles = new Map<string, string>();
  constructor(d: ChatDeps) { this.d = d; }

  character(departmentId: string, agentKey: string): Character {
    const dept = this.d.departments.get(departmentId);
    return this.d.characters.get(departmentId, dept.name, agentKey);
  }

  /**
   * One chat: `session` (a Hermes session id), or 'new' for a fresh one, or omitted for the last one used. Messages come
   * from Vibe City's copy; a chat it has no copy of (started before it kept one, or outside it) is read from Hermes.
   */
  async history(departmentId: string, agentKey: string, session?: string): Promise<ChatHistory> {
    const character = this.character(departmentId, agentKey);
    const profile = this.profileOf(departmentId, agentKey);
    const sessionId = session === 'new' ? newSession() : session ?? (profile && this.currentSession(profile)) ?? newSession();
    let messages = session === 'new' ? [] : this.load(departmentId, agentKey, sessionId, 200);
    if (!messages.length && session && session !== 'new' && profile) messages = await this.fromHermes(profile, sessionId);
    return { character, sessionId, messages, modelReady: profile !== null };
  }

  private currentSession(profile: string): string | null {
    return (this.d.db.prepare('SELECT session_id FROM agent_chat WHERE profile = ?').get(profile) as { session_id: string } | undefined)?.session_id ?? null;
  }

  private async fromHermes(profile: string, sessionId: string): Promise<ChatMessage[]> {
    try {
      const said = (await this.d.hermes.sessionMessages(profile, sessionId, 500)).filter((m) => m.role !== 'tool' && m.content.trim());
      return said.slice(-200).map((m, i) => ChatMessageSchema.parse({
        id: `${sessionId}:${i}`, from: m.role === 'user' ? 'user' : 'agent', at: m.at ?? new Date(0).toISOString(),
        ...(m.role === 'user' ? { text: m.content.slice(0, 4000), mood: null, replies: [], proposal: null } : parseAgentReply(m.content)),
      }));
    } catch (e) {
      // Not found or Hermes away: the chat shows empty and can still be continued.
      if (e instanceof HermesRejectedError || e instanceof HermesUnavailableError || e instanceof HermesAuthError) return [];
      throw e;
    }
  }

  /** The agent's Hermes profile, once provisioning has created it; null when chat cannot reach the agent. */
  private profileOf(departmentId: string, agentKey: string): string | null {
    if (!this.d.agentChat || !this.d.hermes.setProfileEnv) return null;
    return this.d.departments.get(departmentId).agents.find((a) => a.key === agentKey)?.profileRef ?? null;
  }

  async send(departmentId: string, agentKey: string, input: ChatSend, onEvent?: (e: AgentChatEvent) => void): Promise<ChatReply> {
    const profile = this.profileOf(departmentId, agentKey);
    if (!profile || !this.d.agentChat) {
      throw new ModelUnavailableError(this.d.agentChat ? 'This agent has no Hermes profile yet: sync the floor first.' : 'Chat with agents is not configured (no Hermes API server).');
    }
    if (this.busy.has(profile)) throw new ConflictError('The agent is still answering your last message.');
    this.busy.add(profile);
    try {
      const ch = this.character(departmentId, agentKey);
      const cos = this.d.departments.get(departmentId).templateId === CHIEF_OF_STAFF;
      const kit = cos ? await this.d.floorKit?.().catch(() => null) ?? null : null;
      const system = cos ? await this.chiefOfStaffMessage(ch, kit) : await this.systemMessage(departmentId, ch, input.taskTitle, input.blockedTask);
      let creds = await this.creds(profile, input.sessionId);
      // Hermes titles are unique per profile: the session suffix lets two chats open with the same line.
      const turn = (c: ChatCreds) => this.d.agentChat!.turn({ profile, key: c.api_key, sessionId: c.session_id, title: `${input.message.slice(0, 50)} · ${c.session_id.slice(-8)}`, message: input.message, system }, onEvent);
      let raw: string;
      try {
        raw = await turn(creds);
      } catch (e) {
        // The profile's .env lost or changed the key (re-created profile, manual edit): set a fresh one and retry once.
        if (!(e instanceof HermesAuthError)) throw e;
        creds = await this.creds(profile, input.sessionId, true);
        raw = await turn(creds);
      }
      const at = new Date().toISOString();
      const user = ChatMessageSchema.parse({ id: randomUUID(), from: 'user', text: input.message, mood: null, replies: [], proposal: null, at });
      // the Chief of Staff's own board is not shown anywhere: its proposals name the floor that takes the job
      const said = parseAgentReply(raw, cos ? { floors: this.d.departments.list(), ...(kit ? { clampFloor: kit.clamp } : {}) } : undefined);
      said.text = taskTitles(said.text, this.titles);
      said.replies = said.replies.map((r) => taskTitles(r, this.titles));
      const agent = ChatMessageSchema.parse({ id: randomUUID(), from: 'agent', ...said, at: new Date().toISOString() });
      this.store(departmentId, agentKey, creds.session_id, user);
      this.store(departmentId, agentKey, creds.session_id, agent);
      return { user, agent };
    } finally {
      this.busy.delete(profile);
    }
  }

  /** The profile's API key (set up on first chat, or fresh when `rotate`) and the chat to talk in, which becomes the
      one the window opens on next. The key and the provider credentials are written to the profile's .env on first
      use in this process. */
  private async creds(profile: string, sessionId: string | undefined, rotate = false): Promise<ChatCreds> {
    const row = this.d.db.prepare('SELECT profile, api_key, session_id FROM agent_chat WHERE profile = ?').get(profile) as ChatCreds | undefined;
    const session = sessionId ?? row?.session_id ?? newSession();
    let key = row?.api_key;
    if (!key || rotate || !this.synced.has(profile)) {
      key = key && !rotate ? key : newKey();
      await this.d.hermes.setProfileEnv!(profile, { ...this.d.agentEnv?.(profile), API_SERVER_KEY: key });
      this.synced.add(profile);
    }
    this.d.db.prepare(`INSERT INTO agent_chat (profile, api_key, session_id, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile) DO UPDATE SET api_key = excluded.api_key, session_id = excluded.session_id`).run(profile, key, session, new Date().toISOString());
    return { profile, api_key: key, session_id: session };
  }

  private async systemMessage(departmentId: string, ch: Character, taskTitle?: string, blocked?: ChatSend['blockedTask']): Promise<string> {
    const dept = this.d.departments.get(departmentId);
    const board = await this.boardSnapshot(dept.hermesBoardSlug);
    return [
      `The CEO of ${this.d.companyName()} is talking to you through Vibe City's dialogue window. Vibe City is the game-like office where the company's departments of Hermes agents work; you are an agent of the "${dept.name}" department.`,
      `In this window you appear as ${ch.name}, ${ch.title}. Personality: ${ch.traits.join(', ')}. Way of speaking: ${ch.speechStyle}. Quirk: ${ch.quirk}. You call the CEO "boss". Keep the character light; being right matters more.`,
      taskTitle ? `Your current task on the board: "${taskTitle}".` : '',
      blocked ? [
        `The boss opened this chat about your task "${blocked.title}", which is blocked waiting for their input.${blocked.reason ? ` The reason you gave when blocking it: "${blocked.reason}"` : ''}`,
        'Explain plainly what is wrong and exactly what you need from the boss to carry on. Ask follow-up questions until it is clear.',
        'Once the boss has given you what the task needs, add "resume" to the final tag: their answer, written as a short instruction for the task (it is posted on the task as their comment and the task is resumed). Leave it out until then.',
      ].join(' ') : '',
      // Outside a dispatched task the agent has no board context, and chat has no tools to read it: hand it the board.
      `Your department's Kanban board right now (open tasks first, then the latest finished):\n${board}`,
      '',
      'How to answer:',
      '- In this window you only talk: you cannot run commands, change files, or work on tasks here. Answer from the board above, your memory and what the boss tells you. If the answer is not there, say so plainly; never guess or invent results.',
      '- To see what a task produced, use list_task_files with its task id from the board, then read_task_file to read a file. Read the files before describing or summarising the work.',
      '- Task ids (t_…) are for tools only: the boss never sees them. Call a task by its title.',
      '- When the boss wants something done, however small, propose a job: it goes on the board and the team carries it out. Do not say you will do it yourself. The job shows as a card with its own Start button, so never put a reply that just approves it (like "Ship it") among your "replies".',
      '- Your words appear in a retro game dialogue box: plain text, no markdown headings or tables. Usually 1-4 sentences; when reporting results the boss asked for, give the substance (up to ~150 words).',
      '- End every reply with one final line, exactly in this form (JSON inside the tag):',
      `<vc>{"mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next, each under 40 characters], "proposal": null or {"title": "<quest title, under 80 characters>", "objective": "<1-3 sentences: what to do and what done looks like>"}${blocked ? ', "resume": "<only once the boss has answered>"' : ''}}</vc>`,
    ].filter(Boolean).join('\n');
  }

  /** The Chief of Staff is the CEO's first stop: it answers from a briefing of the whole company (no tool call needed
      to know a floor) and hands work to floors as job proposals the CEO confirms with one click. */
  private async chiefOfStaffMessage(ch: Character, kit: FloorKit | null): Promise<string> {
    const floors = this.d.departments.list();
    const [status, ...boards] = await Promise.all([
      this.d.companyStatus?.().catch(() => '') ?? '',
      ...floors.map((f) => (f.state === 'ready' ? this.boardSnapshot(f.hermesBoardSlug, 8)
        // a floor being built can be given its first job now: the boss starts it once the floor is ready
        : Promise.resolve(f.state === 'provisioning' ? '(being built in Hermes right now: propose its jobs; the boss starts them once it is ready)' : '(not synced with Hermes yet: it cannot take jobs)'))),
    ]);
    const briefing = floors.map((f, i) => [
      `### ${f.name}${isInternalOnly(f.templateId) ? ' (internal: never listed on the market)' : ''}`,
      `Does: ${f.purpose || 'no purpose written'}`,
      `Team: ${f.agents.map((a) => { const c = this.d.characters.get(f.id, f.name, a.key); return `${c.name} (${c.title})`; }).join(', ')}`,
      `Board:\n${boards[i]}`,
    ].join('\n')).join('\n\n');
    return [
      `The CEO of ${this.d.companyName()} is talking to you through Vibe City's dialogue window. Vibe City is the game-like office tower where the company's departments (floors) of Hermes agents work.`,
      `You are ${ch.name}, the Chief of Staff: the CEO's right hand and their first stop for anything about the company. Personality: ${ch.traits.join(', ')}. Way of speaking: ${ch.speechStyle}. You call the CEO "boss". Keep the character light; being right matters more.`,
      '',
      '## Company briefing (live, rebuilt for every message)',
      status,
      briefing || 'There are no floors yet.',
      '',
      'How to answer:',
      '- Be fast: answer from the briefing above. It already holds every floor, its team and its board, so do NOT call a tool to learn about floors or tasks. If the answer is not there, say so plainly; never guess or invent results.',
      '- Tools are only for two things: reading what a task produced (list_task_files then read_task_file, with the task id and the floor name as "department"), and list_on_market after the boss confirmed a listing. One or two calls at most per answer.',
      '- Task ids (t_…) are for tools only: the boss never sees them. Call a task by its title.',
      '- When the boss wants work done, pick the floor whose purpose fits and propose the job with that floor\'s exact name as "department": the boss starts it with one click and it lands on that floor\'s board. Only a floor synced with Hermes, or being built right now, can take a job. Do not say you will do it yourself. A proposed job or floor shows as a card with its own button, so never put a reply that just approves it (like "Looks good") among your "replies".',
      '- When the boss asks how things are going (a briefing, a status, "what needs me"): say ONE headline sentence, and put the rest in "report" so it shows as a card: "needs_you" = what waits on the boss (decisions waiting, blocked or failed tasks, the next CEO quest; [] when nothing does), "in_flight" = one row per job that is moving, "money" = one line, marked as an estimate. Each row is short (under 20 words) and names its floor in "floor" when it is about one. Do not repeat the report in your sentence. For any other question, "report" is null.',
      '- A new floor: first ask "a ready template or a custom floor?" with the replies "Show me the templates" and "Design a custom floor" (templates are picked in their own panel). For a custom floor, if the boss has not said what it should do, ask that one question and make your "replies" 2 or 3 concrete floor ideas built from the installed skills below. Once the purpose is clear, propose the floor right away in "floor": small, granting only what the purpose needs, never duplicating a floor in the briefing. If the boss asks for changes, propose the whole floor again.',
      kit ? kit.prompt : 'What Hermes has installed cannot be read right now: do not propose a floor ("floor": null), say so.',
      '- Hiring one specialist and listing on the Agent Market have their own guided flows here: when the boss wants one, say so in a sentence and put its exact label among your "replies": "Hire a new agent", "List a floor on the Agent Market".',
      '- When a floor sits idle (nothing open on its board), put "Give a floor a job" among your "replies": the boss gets a job from you to start with one click.',
      '- Your words appear in a retro game dialogue box: plain text, no markdown headings or tables. Usually 1-3 sentences; a status report may run to ~120 words.',
      '- End every reply with one final line, exactly in this form (JSON inside the tag):',
      `<vc>{"mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next, each under 40 characters], "proposal": null or {"department": "<exact floor name>", "title": "<quest title, under 80 characters>", "objective": "<1-3 sentences: what to do and what done looks like>"}, "report": null or {"needs_you": [{"text": "<row>", "floor": "<exact floor name, or omit>"}], "in_flight": [{"text": "<row>", "floor": "<exact floor name>"}], "money": "<one line>"}, "floor": null or {"name": "<2-3 words>", "purpose": "<1-2 sentences>", "skills": ["<installed skill>"], "toolsets": ["<toolset>"], "model": "<provider/model or null>", "agents": [lead first, 1 to 5 of {"name": "<a first name>", "title": "<job title, 2-4 words>", "does": "<what they do here, under 15 words>"}]}}</vc>`,
    ].join('\n');
  }

  /** One line per task: the open ones, then the most recently finished. */
  private async boardSnapshot(slug: string, cap = 15): Promise<string> {
    if (!this.d.kanban) return '(the board cannot be read right now)';
    let tasks: RawTask[];
    try {
      tasks = await this.d.kanban.listBoardTasks(slug);
    } catch (e) {
      if (e instanceof HermesRejectedError || e instanceof HermesUnavailableError || e instanceof HermesAuthError) return '(the board cannot be read right now)';
      throw e;
    }
    for (const t of tasks) this.titles.set(t.id, t.title);
    const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    // shortcut: a fixed cap keeps the prompt small; older work is out of chat's sight until it can look tasks up on demand.
    const shown = [...open, ...done].slice(0, cap);
    if (!shown.length) return '(the board is empty)';
    return shown.map((t) => {
      const note = (t.result ?? t.latest_summary ?? t.last_failure_error ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      return `- ${t.id} [${t.status}${t.assignee ? `, ${t.assignee}` : ''}] ${t.title}${note ? `: ${note}` : ''}`;
    }).join('\n') + (tasks.length > shown.length ? `\n(${tasks.length - shown.length} older tasks not shown)` : '');
  }

  private load(departmentId: string, agentKey: string, sessionId: string, limit: number): ChatMessage[] {
    const rows = this.d.db.prepare('SELECT message_json FROM chat_message WHERE department_id = ? AND agent_key = ? AND session_id = ? ORDER BY seq DESC LIMIT ?')
      .all(departmentId, agentKey, sessionId, limit) as { message_json: string }[];
    return rows.reverse().map((r) => ChatMessageSchema.parse(JSON.parse(r.message_json)));
  }

  private store(departmentId: string, agentKey: string, sessionId: string, m: ChatMessage) {
    const next = (this.d.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chat_message WHERE department_id = ? AND agent_key = ?')
      .get(departmentId, agentKey) as { n: number }).n;
    this.d.db.prepare('INSERT INTO chat_message (id, department_id, agent_key, seq, session_id, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(m.id, departmentId, agentKey, next, sessionId, JSON.stringify(m), m.at);
  }
}

/** Task ids mean nothing to the boss: an id the agent wrote becomes that task's title in quotes. */
export const taskTitles = (s: string, titles: ReadonlyMap<string, string>) =>
  s.replace(/\bt_[0-9a-z]+\b/gi, (id) => (titles.has(id) ? `"${titles.get(id)}"` : id));

/** Splits the agent's reply into what it says and the trailing <vc>{…}</vc> metadata. A missing or broken tag just
    means plain speech: the agent's words are never lost to a formatting slip. */
export function parseAgentReply(raw: string, cos?: { floors: { id: string; name: string }[]; clampFloor?: FloorKit['clamp'] }): Pick<ChatMessage, 'text' | 'mood' | 'replies' | 'proposal' | 'resume' | 'floorDraft' | 'briefing'> {
  const floors = cos?.floors;
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const tag = /<vc>([\s\S]*?)(?:<\/vc>|$)/i.exec(clean);
  let meta: Record<string, unknown> = {};
  if (tag) {
    const body = tag[1]!.trim().replace(/^```[a-z]*|```$/gi, '').trim();
    try { meta = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as Record<string, unknown>; } catch { meta = {}; }
  }
  const text = (tag ? clean.slice(0, tag.index) + clean.slice(tag.index + tag[0].length) : clean).trim().slice(0, 4000) || '…';
  const mood = (MOODS as readonly string[]).includes(meta.mood as string) ? (meta.mood as Mood) : 'neutral';
  const replies = Array.isArray(meta.replies)
    ? meta.replies.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 3)
    : [];
  // `floors` (the Chief of Staff): the proposal must name one of them, else there is nowhere to put the job
  const mp = (meta.proposal && typeof meta.proposal === 'object' ? meta.proposal : {}) as Record<string, unknown>;
  const floor = floors?.find((f) => f.name.toLowerCase() === String(mp.department ?? '').trim().toLowerCase());
  const p = ChatProposalSchema.safeParse(floors && !floor ? null : { kind: 'quest', title: mp.title, objective: mp.objective, ...(floor ? { departmentId: floor.id, departmentName: floor.name } : {}) });
  const resume = typeof meta.resume === 'string' && meta.resume.trim() ? { resume: meta.resume.trim().slice(0, 4000) } : {};
  const floorDraft = cos?.clampFloor?.(meta.floor) ?? null;
  const briefing = floors && meta.report && typeof meta.report === 'object' ? briefingOf(meta.report as Record<string, unknown>, floors) : null;
  return { text, mood, replies, proposal: meta.proposal && p.success ? p.data : null, ...resume, ...(floorDraft ? { floorDraft } : {}), ...(briefing ? { briefing } : {}) };
}

/** The Chief of Staff's report as rows: strings or {text, floor}; a floor it names that exists becomes a link target.
    An empty report is no report. */
function briefingOf(r: Record<string, unknown>, floors: { id: string; name: string }[]): ChatBriefing | null {
  const rows = (v: unknown, max: number) => (Array.isArray(v) ? v : []).flatMap((x) => {
    const o = (typeof x === 'string' ? { text: x } : x ?? {}) as Record<string, unknown>;
    const text = typeof o.text === 'string' ? o.text.replace(/\s+/g, ' ').trim().slice(0, 240) : '';
    const floor = floors.find((f) => f.name.toLowerCase() === String(o.floor ?? '').trim().toLowerCase());
    return text ? [{ text, ...(floor ? { departmentId: floor.id, departmentName: floor.name } : {}) }] : [];
  }).slice(0, max);
  const needsYou = rows(r.needs_you, 6), inFlight = rows(r.in_flight, 8);
  const money = typeof r.money === 'string' && r.money.trim() ? r.money.trim().slice(0, 240) : null;
  return needsYou.length || inFlight.length || money ? { needsYou, inFlight, money } : null;
}
