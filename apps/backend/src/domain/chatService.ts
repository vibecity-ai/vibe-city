/* Dialogue-window chat with one agent: the CEO talks to the agent's own Hermes profile (its model, tools, skills,
   memory and SOUL.md) through the gateway API server. Each chat is one Hermes session of the profile; the window opens on
   the last one used, and any earlier chat can be reopened and continued.
   Vibe City adds the persona, a snapshot of the department's board and the dialogue conventions, as an ephemeral system
   message, and keeps its own copy of the transcript for the window. Chat only talks (provisioning leaves it no tools that
   act): work is proposed as a quest, and the user's Accept creates it through the quest API. */
import type { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CHIEF_OF_STAFF, ChatMessageSchema, ChatProposalSchema, MOODS,
  type Character, type ChatHistory, type ChatMessage, type ChatReply, type ChatSend, type Mood,
} from '@vibe-city/shared';
import { ModelUnavailableError } from '../model/chatModel.ts';
import { HermesAuthError, HermesRejectedError, HermesUnavailableError, type HermesRuntime } from '../hermes/ports.ts';
import type { AgentChat, AgentChatEvent } from '../hermes/agentChat.ts';
import type { KanbanApi, RawTask } from '../hermes/kanbanApi.ts';
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
  agentEnv?: () => Record<string, string>;
  hermes: HermesRuntime;
  /** Reads the department's board for the chat's snapshot. Omit: the agent is told the board cannot be read. */
  kanban?: KanbanApi;
  companyName: () => string;
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
      throw new ModelUnavailableError(this.d.agentChat ? 'This agent has no Hermes profile yet: sync the department first.' : 'Chat with agents is not configured (no Hermes API server).');
    }
    if (this.busy.has(profile)) throw new ConflictError('The agent is still answering your last message.');
    this.busy.add(profile);
    try {
      const ch = this.character(departmentId, agentKey);
      const system = await this.systemMessage(departmentId, ch, input.taskTitle, input.blockedTask);
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
      // the Chief of Staff's board is not shown anywhere: a job proposed there would vanish, so it never offers one
      const said = parseAgentReply(raw);
      if (this.d.departments.get(departmentId).templateId === CHIEF_OF_STAFF) said.proposal = null;
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
      await this.d.hermes.setProfileEnv!(profile, { ...this.d.agentEnv?.(), API_SERVER_KEY: key });
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
      dept.templateId === CHIEF_OF_STAFF ? [
        '- You run the Executive Office. The one thing you do from this window is list a floor of the company on the NEAR AI Agent Market (market.near.ai), where buyers hire agents for jobs paid in USDC: call list_departments, ask the boss which floor to list, write the listing (name, tagline, description, price in USDC per job, delivery time, deliverables; promise only what that floor does) as plain text the boss can copy, agree the handle, then call list_on_market once the boss confirms. Never call list_on_market before that.',
        '- Price and going live are set by the boss on market.near.ai afterwards: say so.',
      ].join('\n') : '- In this window you only talk: you cannot run commands, change files, or work on tasks here. Answer from the board above, your memory and what the boss tells you. If the answer is not there, say so plainly; never guess or invent results.',
      '- To see what a task produced, use list_task_files with its task id from the board, then read_task_file to read a file. Read the files before describing or summarising the work.',
      dept.templateId === CHIEF_OF_STAFF
        ? '- The Executive Office has no team: never propose a job (always "proposal": null). When the boss wants work done, name the floor that should do it and tell them to give it the job there.'
        : '- When the boss wants something done, however small, propose a job: it goes on the board and the team carries it out. Do not say you will do it yourself.',
      '- Your words appear in a retro game dialogue box: plain text, no markdown headings or tables. Usually 1-4 sentences; when reporting results the boss asked for, give the substance (up to ~150 words).',
      '- End every reply with one final line, exactly in this form (JSON inside the tag):',
      `<vc>{"mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next, each under 40 characters], "proposal": null or {"title": "<quest title, under 80 characters>", "objective": "<1-3 sentences: what to do and what done looks like>"}${blocked ? ', "resume": "<only once the boss has answered>"' : ''}}</vc>`,
    ].filter(Boolean).join('\n');
  }

  /** One line per task: the open ones, then the most recently finished. */
  private async boardSnapshot(slug: string): Promise<string> {
    if (!this.d.kanban) return '(the board cannot be read right now)';
    let tasks: RawTask[];
    try {
      tasks = await this.d.kanban.listBoardTasks(slug);
    } catch (e) {
      if (e instanceof HermesRejectedError || e instanceof HermesUnavailableError || e instanceof HermesAuthError) return '(the board cannot be read right now)';
      throw e;
    }
    const open = tasks.filter((t) => t.status !== 'done').sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.completed_at ?? 0) - (a.completed_at ?? 0));
    // shortcut: a fixed cap keeps the prompt small; older work is out of chat's sight until it can look tasks up on demand.
    const shown = [...open, ...done].slice(0, 15);
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

/** Splits the agent's reply into what it says and the trailing <vc>{…}</vc> metadata. A missing or broken tag just
    means plain speech: the agent's words are never lost to a formatting slip. */
export function parseAgentReply(raw: string): Pick<ChatMessage, 'text' | 'mood' | 'replies' | 'proposal' | 'resume'> {
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
  const p = ChatProposalSchema.safeParse({ kind: 'quest', ...(meta.proposal && typeof meta.proposal === 'object' ? meta.proposal : {}) });
  const resume = typeof meta.resume === 'string' && meta.resume.trim() ? { resume: meta.resume.trim().slice(0, 4000) } : {};
  return { text, mood, replies, proposal: meta.proposal && p.success ? p.data : null, ...resume };
}
