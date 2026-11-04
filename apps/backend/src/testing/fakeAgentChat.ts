import { HermesAuthError, HermesRejectedError } from '../hermes/ports.ts';
import type { AgentChat, AgentChatEvent, AgentTurn } from '../hermes/agentChat.ts';
import type { FakeHermes } from './fakeHermes.ts';

/** Scripted agent for tests: checks the key against FakeHermes like the gateway API server would, records each turn,
    and keeps one transcript per profile session. */
export class FakeAgentChat implements AgentChat {
  turns: AgentTurn[] = [];
  sessions = new Map<string, string[]>();
  events: AgentChatEvent[] = [];
  private hermes: FakeHermes;
  private answer: (t: AgentTurn, history: string[]) => string;
  constructor(hermes: FakeHermes, answer: (t: AgentTurn, history: string[]) => string = () => 'On it, boss.\n<vc>{"mood":"happy","replies":["Thanks"],"proposal":null}</vc>') {
    this.hermes = hermes;
    this.answer = answer;
  }

  async turn(t: AgentTurn, onEvent: (e: AgentChatEvent) => void = () => {}): Promise<string> {
    if (!this.hermes.profiles.has(t.profile)) throw new HermesRejectedError('Unknown or unconfigured profile');
    if (this.hermes.env.get(t.profile)?.API_SERVER_KEY !== t.key) throw new HermesAuthError('Hermes rejected the agent API key');
    this.turns.push(t);
    for (const e of this.events) onEvent(e);
    const k = `${t.profile}/${t.sessionId}`;
    const history = this.sessions.get(k) ?? [];
    const reply = this.answer(t, history);
    this.sessions.set(k, [...history, t.message, reply]);
    return reply;
  }
}
