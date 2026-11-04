/* Dialogue-window chat with one agent. The agent answers in character, with what Vibe City knows about its
   department (purpose, its Hermes instructions, live quests) as context. Chat never starts work: if the user asks for
   work, the agent returns a quest proposal, and the user's Accept creates an ordinary quest through the quest API. */
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  ChatMessageSchema, ChatProposalSchema, MOODS, profileNameForAgent,
  type Character, type ChatHistory, type ChatMessage, type ChatReply, type ChatSend, type Mood, type QuestSummary,
} from '@vibe-city/shared';
import type { ChatModel, ChatTurn } from '../model/chatModel.ts';
import { ModelUnavailableError } from '../model/chatModel.ts';
import type { HermesRuntime } from '../hermes/ports.ts';
import type { DepartmentService } from './departmentService.ts';
import type { CharacterService } from './characters.ts';
import { scrubPaths } from './scrub.ts';

const HISTORY_TURNS = 12;
const MAX_INSTRUCTIONS = 1800;

export interface ChatDeps {
  db: DatabaseSync;
  departments: DepartmentService;
  characters: CharacterService;
  model: ChatModel;
  hermes: HermesRuntime;
  /** Live quests of the department (best effort; failures just leave them out of the context). */
  quests: (departmentId: string) => Promise<QuestSummary[]>;
  companyName: () => string;
}

export class ChatService {
  private d: ChatDeps;
  constructor(d: ChatDeps) { this.d = d; }

  character(departmentId: string, agentKey: string): Character {
    const dept = this.d.departments.get(departmentId);
    return this.d.characters.get(departmentId, dept.name, agentKey);
  }

  history(departmentId: string, agentKey: string): ChatHistory {
    return { character: this.character(departmentId, agentKey), messages: this.load(departmentId, agentKey, 200), modelReady: this.d.model.ready };
  }

  async send(departmentId: string, agentKey: string, input: ChatSend): Promise<ChatReply> {
    if (!this.d.model.ready) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const dept = this.d.departments.get(departmentId);
    const ch = this.d.characters.get(departmentId, dept.name, agentKey);
    const past = this.load(departmentId, agentKey, HISTORY_TURNS);

    const system = await this.systemPrompt(departmentId, ch, input.taskTitle);
    const turns: ChatTurn[] = [
      { role: 'system', content: system },
      ...past.map((m): ChatTurn => (m.from === 'user'
        ? { role: 'user', content: m.text }
        : { role: 'assistant', content: JSON.stringify({ say: m.text, mood: m.mood, replies: m.replies, proposal: m.proposal }) })),
      { role: 'user', content: input.message },
    ];
    const raw = await this.d.model.complete(turns);
    const now = new Date().toISOString();
    const user = ChatMessageSchema.parse({ id: randomUUID(), from: 'user', text: input.message, mood: null, replies: [], proposal: null, at: now });
    const agent = ChatMessageSchema.parse({ id: randomUUID(), from: 'agent', ...parseAgentReply(raw), at: new Date().toISOString() });
    this.store(departmentId, agentKey, user);
    this.store(departmentId, agentKey, agent);
    return { user, agent };
  }

  private async systemPrompt(departmentId: string, ch: Character, taskTitle?: string): Promise<string> {
    const dept = this.d.departments.get(departmentId);
    const profile = dept.agents.find((a) => a.key === ch.agentKey)?.profileRef ?? profileNameForAgent(departmentId, ch.agentKey);
    let instructions = '';
    try { instructions = (await this.d.hermes.readInstructions(profile)) ?? ''; } catch { /* Hermes down: talk without them */ }
    let quests: QuestSummary[] = [];
    try { quests = await this.d.quests(departmentId); } catch { /* no board yet, or Hermes down */ }
    const questLines = quests.slice(0, 8).map((q) => `- "${q.title}": ${q.status}, ${q.counts.done}/${q.counts.tasks} tasks done${q.counts.failed ? `, ${q.counts.failed} failed` : ''}`);
    return [
      `You are ${ch.name}, ${ch.title} at ${this.d.companyName()}, a company in the game Vibe City whose employees are AI agents.`,
      `Personality: ${ch.traits.join(', ')}. Way of speaking: ${ch.speechStyle}. Quirk: ${ch.quirk}.`,
      `You are talking to the CEO, whom you call "boss". Stay in character.`,
      `Department purpose: ${dept.purpose || 'not written yet'}.`,
      taskTitle ? `Your current task: "${taskTitle}".` : '',
      questLines.length ? `Your department's quests right now (from the Kanban board):\n${questLines.join('\n')}` : 'Your department has no quests right now.',
      instructions ? `Your standing instructions (from your Hermes profile):\n${scrubPaths(instructions).slice(0, MAX_INSTRUCTIONS)}` : '',
      '',
      'Rules:',
      '- Your words appear one line at a time in a retro game dialogue box: at most 3 short sentences, under 60 words.',
      '- You cannot do work during this conversation and you have not done anything you are not shown above. Never invent results, numbers or progress.',
      '- If the boss asks for work to be done, propose a quest: a clear title and an objective the department can act on. The boss decides whether to start it.',
      '- Reply with JSON only, no other text:',
      `{"say": "<what you say>", "mood": one of ${MOODS.map((m) => `"${m}"`).join(', ')}, "replies": [2 or 3 short things the boss might say next, each under 40 characters], "proposal": null or {"kind": "quest", "title": "<under 80 characters>", "objective": "<1-3 sentences>"}}`,
    ].filter(Boolean).join('\n');
  }

  private load(departmentId: string, agentKey: string, limit: number): ChatMessage[] {
    const rows = this.d.db.prepare('SELECT message_json FROM chat_message WHERE department_id = ? AND agent_key = ? ORDER BY seq DESC LIMIT ?')
      .all(departmentId, agentKey, limit) as { message_json: string }[];
    return rows.reverse().map((r) => ChatMessageSchema.parse(JSON.parse(r.message_json)));
  }

  private store(departmentId: string, agentKey: string, m: ChatMessage) {
    const next = (this.d.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chat_message WHERE department_id = ? AND agent_key = ?')
      .get(departmentId, agentKey) as { n: number }).n;
    this.d.db.prepare('INSERT INTO chat_message (id, department_id, agent_key, seq, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(m.id, departmentId, agentKey, next, JSON.stringify(m), m.at);
  }
}

/** Reads the model's JSON reply. Models wrap JSON in prose or fences, or drop it: anything unparseable becomes plain speech. */
export function parseAgentReply(raw: string): Pick<ChatMessage, 'text' | 'mood' | 'replies' | 'proposal'> {
  const clean = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const start = clean.indexOf('{'), end = clean.lastIndexOf('}');
  let obj: Record<string, unknown> | null = null;
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(clean.slice(start, end + 1)) as Record<string, unknown>; } catch { obj = null; }
  }
  if (!obj || typeof obj.say !== 'string' || !obj.say.trim()) {
    const text = clean.replace(/```[a-z]*|```/gi, '').trim().slice(0, 1200) || '…';
    return { text, mood: 'neutral', replies: [], proposal: null };
  }
  const mood = (MOODS as readonly string[]).includes(obj.mood as string) ? (obj.mood as Mood) : 'neutral';
  const replies = Array.isArray(obj.replies)
    ? obj.replies.filter((r): r is string => typeof r === 'string' && !!r.trim()).map((r) => r.trim().slice(0, 60)).slice(0, 3)
    : [];
  const p = ChatProposalSchema.safeParse({ kind: 'quest', ...(obj.proposal && typeof obj.proposal === 'object' ? obj.proposal : {}) });
  return { text: obj.say.trim().slice(0, 1200), mood, replies, proposal: obj.proposal && p.success ? p.data : null };
}
