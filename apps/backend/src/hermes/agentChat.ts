/* Talking to an agent's own Hermes profile: the gateway's API server (OpenAI-compatible, plus session chat), with
   profiles multiplexed under /p/<profile>/. Each profile authenticates with its own API_SERVER_KEY (Hermes never lets a
   named profile borrow the owner's key), which Vibe City sets in the profile's .env. The agent answers with its own
   model, tools, skills, memory and SOUL.md; each conversation is one Hermes session of that profile. */
import type { ChatProgress } from '@vibe-city/shared';
import { HermesAuthError, HermesRejectedError, HermesUnavailableError } from './ports.ts';

/** Progress of one agent turn, for the dialogue window. */
export type AgentChatEvent = ChatProgress;

export interface AgentTurn {
  profile: string;
  /** The profile's API_SERVER_KEY. */
  key: string;
  sessionId: string;
  /** The session's title in Hermes, set when this turn creates it. */
  title: string;
  message: string;
  /** Ephemeral system message for this turn (persona and dialogue conventions); not stored in the session. */
  system: string;
}

export interface AgentChat {
  /** One agent turn in the session (created on first use). Resolves with the agent's final reply text.
      HermesAuthError: the key was rejected. HermesUnavailableError: the API server is unreachable. */
  turn(t: AgentTurn, onEvent?: (e: AgentChatEvent) => void): Promise<string>;
}

export interface HermesAgentChatOptions {
  baseUrl: string; // gateway API server, e.g. http://127.0.0.1:8642
  /** Whole-turn limit: tool-using turns can take minutes. */
  turnTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class HermesAgentChat implements AgentChat {
  private o: Required<HermesAgentChatOptions>;
  constructor(o: HermesAgentChatOptions) { this.o = { turnTimeoutMs: 15 * 60_000, fetch: globalThis.fetch, ...o }; }

  async turn(t: AgentTurn, onEvent: (e: AgentChatEvent) => void = () => {}): Promise<string> {
    if (!PROFILE_RE.test(t.profile)) throw new HermesRejectedError('invalid profile name');
    if (!SESSION_RE.test(t.sessionId)) throw new HermesRejectedError('invalid session id');
    const base = `${this.o.baseUrl.replace(/\/+$/, '')}/p/${t.profile}`;
    const headers = { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.turnTimeoutMs);
    try {
      // The session must exist before chatting; 409 = it already does.
      const created = await this.call(`${base}/api/sessions`, { method: 'POST', headers, signal: ctl.signal, body: JSON.stringify({ id: t.sessionId, title: t.title }) });
      if (created.status !== 409) await this.check(created);
      // Disconnecting interrupts the run in Hermes, so the stream is read to the end.
      const res = await this.call(`${base}/api/sessions/${t.sessionId}/chat/stream`, {
        method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, signal: ctl.signal,
        body: JSON.stringify({ message: t.message, system_message: t.system }),
      });
      await this.check(res);
      if (!res.body) throw new HermesUnavailableError('Hermes sent no stream');
      let final: string | null = null;
      for await (const { event, data } of sseFrames(res.body)) {
        if (event === 'tool.progress' && data.tool_name === '_thinking') onEvent({ kind: 'thinking' });
        else if (event === 'tool.started') onEvent({ kind: 'tool', name: str(data.tool_name) ?? 'tool', preview: str(data.preview) });
        else if (event === 'approval.request') onEvent({ kind: 'approval', command: str(data.command) });
        else if (event === 'assistant.completed') {
          // An unfinished turn (model unreachable, iteration budget…) still carries Hermes' own explanation as content.
          if (data.completed === false) throw new HermesRejectedError(`The agent could not finish: ${(str(data.content) ?? str(data.turn_exit_reason) ?? 'unknown reason').slice(0, 300)}`);
          final = str(data.content) ?? '';
        }
        else if (event === 'error') throw new HermesRejectedError(`the agent failed: ${str(data.message) ?? 'unknown error'}`);
        else if (event === 'run.cancelled') throw new HermesRejectedError('the agent run was cancelled');
      }
      if (final === null) throw new HermesUnavailableError('the agent stream ended without a reply');
      return final;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new HermesUnavailableError('the agent took too long to answer');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.o.fetch(url, init);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new HermesUnavailableError('the Hermes API server could not be reached');
    }
  }

  private async check(res: Response): Promise<void> {
    if (res.ok) return;
    const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } | string } | null;
    const msg = typeof body?.error === 'string' ? body.error : str(body?.error?.message) ?? `HTTP ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new HermesAuthError('Hermes rejected the agent API key');
    if (res.status === 429 || res.status >= 500) throw new HermesUnavailableError(`Hermes is busy or failing (${msg})`);
    throw new HermesRejectedError(`Hermes refused the chat: ${msg}`);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parses a text/event-stream body into {event, data} frames (data is JSON; comments and keepalives are skipped). */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (frame: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return null;
    try { return { event, data: JSON.parse(data.join('\n')) as Record<string, unknown> }; } catch { return null; }
  };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const f = parse(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (f) yield f;
    }
  }
  const f = parse(buf);
  if (f) yield f;
}
