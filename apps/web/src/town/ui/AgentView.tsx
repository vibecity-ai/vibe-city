/* Agent View pieces (feature spec 2.2): the character header, the chat transcript and the record. Everything shown is
   read from the backend (persona, stored chat, quests and tasks Hermes reports); numbers the game cannot know yet
   (cost, review grades) say so instead of guessing. */
import { useEffect, useMemo, useState } from 'react';
import type { AgentSession, Character, ChatHistory, ChatMessage } from '@vibe-city/shared';
import { useStore } from '../store';
import type { Dept, AgentStatus } from '../data/types';
import { api, ApiError } from '../../api';
import { loadAgent } from '../data/live';
import { lookFor, quirkProp } from '../world/sprites';
import { PortraitCanvas } from './Dialogue';
import { formatTime } from './format';
import { agentLabel, taskStatusView } from '../data/views';
import { Glyph } from './kit';

/** Loads personas into the store (one request per seat, cached for the session). */
const loading = new Set<string>();
export function loadPersonas(deptId: string, keys: string[]) {
  for (const k of keys) {
    const key = `${deptId}:${k}`;
    if (useStore.getState().personas[key] || loading.has(key)) continue;
    loading.add(key);
    api.character(deptId, k)
      .then((c) => useStore.setState((s) => ({ personas: { ...s.personas, [key]: c } })))
      .catch(() => undefined).finally(() => loading.delete(key));
  }
}
export function usePersona(deptId: string, agentKey: string) {
  const key = `${deptId}:${agentKey}`;
  const ch = useStore((s) => s.personas[key] ?? null);
  useEffect(() => { loadPersonas(deptId, [agentKey]); }, [deptId, agentKey]);
  return ch;
}


/** An agent's name as the user knows it; `agentKey` null = an assignee outside the floor. */
export function AgentName({ deptId, agentKey }: { deptId: string; agentKey: string | null }) {
  const key = `${deptId}:${agentKey}`;
  const ch = useStore((s) => (agentKey ? s.personas[key] ?? null : null));
  useEffect(() => { if (agentKey) loadPersonas(deptId, [agentKey]); }, [deptId, agentKey]);
  return <>{agentLabel(agentKey, ch)}</>;
}

export function AgentPortrait({ deptId, agentKey, shirt, status }: { deptId: string; agentKey: string; shirt: string; status: AgentStatus }) {
  const ch = usePersona(deptId, agentKey);
  const look = useMemo(() => ({ ...lookFor(deptId + ':' + agentKey, shirt, agentKey === 'chief'), prop: quirkProp(ch?.quirk) }), [deptId, agentKey, shirt, ch?.quirk]);
  return (
    <div className="agent-face" style={{ ['--who' as string]: ch?.color ?? '#FFC75A' }}>
      <PortraitCanvas look={look} mood={status === 'failed' ? 'worried' : status === 'running' ? 'focused' : 'neutral'} talking={false} size={96} className="agent-portrait" />
    </div>
  );
}

export function PersonaLine({ deptId, agentKey }: { deptId: string; agentKey: string }) {
  const ch = usePersona(deptId, agentKey);
  if (!ch) return null;
  return (
    <p className="persona"><b style={{ color: ch.color }}>{ch.name}</b> · {ch.traits.join(', ')} · <span className="muted">{ch.quirk}</span></p>
  );
}

/** A chat's name: its Hermes title (the opening line), or its date for chats titled before that ("CEO chat 1a2b3c"). */
export const chatTitle = (x: AgentSession) => (x.title && !/^CEO chat [0-9a-f]{6}$/.test(x.title) ? x.title : `Chat from ${formatTime(x.startedAt)}`);

/** The agent's chats (its Hermes chat sessions): pick one to read it, resume it in the dialogue window, or start a new one. */
export function ChatTranscript({ deptId, agentKey, sessions, sessionsError }: { deptId: string; agentKey: string; sessions: AgentSession[] | null; sessionsError: string | null }) {
  const ch = usePersona(deptId, agentKey);
  const talking = useStore((s) => !!s.ui.talk);
  const [sel, setSel] = useState<string | undefined>(undefined);
  const [h, setH] = useState<ChatHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Reloaded when the dialogue window closes: the chat just used is now the last one, and Hermes lists it.
  useEffect(() => {
    if (talking) return;
    setError(null);
    api.chatHistory(deptId, agentKey, sel).then(setH).catch((e: ApiError) => setError(e.message));
    void loadAgent(deptId, agentKey);
  }, [deptId, agentKey, sel, talking]);
  const talk = (session?: string) => { setSel(undefined); useStore.getState().ui$({ talk: { deptId, agentKey, ...(session ? { session } : {}) } }); };
  const chats = (sessions ?? []).filter((x) => x.source === 'api_server');
  const messages = h?.messages ?? null;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (messages ?? []).filter((m) => words.every((w) => m.text.toLowerCase().includes(w)));
  return (
    <section className="pane-sec">
      <div className="head-row"><h3 className="sec-t">Chats {sessions && <span className="count">{chats.length}</span>}</h3>
        <span className="row"><button className="btn small" onClick={() => talk('new')}>New chat</button>{h && <button className="btn primary small" onClick={() => talk(h.sessionId)}>{messages?.length ? 'Resume' : 'Talk'}</button>}</span></div>
      <p className="fine">Every chat with {ch?.name ?? 'this agent'} is a session in Hermes, with its memory of what was said. Resume one to carry on where you left off. Chat never starts work: a request becomes a quest proposal you accept.</p>
      {sessionsError && <p className="muted small"><Glyph k="disconnected" /> {sessionsError}</p>}
      {chats.length > 0 && <ul className="stack tight chats">{chats.map((x) => (
        <li key={x.id}><button className={`link session${x.id === h?.sessionId ? ' sel' : ''}`} aria-current={x.id === h?.sessionId || undefined} onClick={() => setSel(x.id)}>
          <Glyph k={x.active ? 'running' : 'idle'} />
          <span><b>{chatTitle(x)}</b><small className="muted">{[formatTime(x.lastActiveAt ?? x.startedAt), x.messageCount != null ? `${x.messageCount} messages` : null, x.active ? 'answering now' : null].filter(Boolean).join(' · ')}</small></span>
        </button></li>
      ))}</ul>}
      {messages && messages.length > 0 && <input className="input" type="search" placeholder="Search this chat" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search this chat" />}
      {error && <p className="field-err" role="alert">{error}</p>}
      {!messages && !error && <p className="muted" aria-busy="true">Loading…</p>}
      {messages?.length === 0 && <p className="muted">{chats.length ? 'Nothing to show for this chat.' : 'No chats yet. Press Talk to start one.'}</p>}
      <ol className="transcript">
        {shown.map((m) => (
          <li key={m.id} className={m.from}>
            <span className="who">{m.from === 'user' ? 'You' : ch?.name ?? 'Agent'}<span className="mono muted"> · {formatTime(m.at)}</span></span>
            <p>{m.text}</p>
            {m.proposal && <span className="tr-prop"><Glyph k="awaiting" /> Proposed quest: <b>{m.proposal.title}</b></span>}
          </li>
        ))}
      </ol>
      {messages && messages.length > 0 && shown.length === 0 && <p className="muted small">Nothing matches “{q}”.</p>}
    </section>
  );
}

export function AgentRecord({ d, agentKey }: { d: Dept; agentKey: string }) {
  const lead = agentKey === 'chief';
  const quests = useStore((s) => s.quests);
  const details = useStore((s) => s.details);
  const mine = quests.filter((q) => q.deptId === d.id);
  const done = mine.filter((q) => q.summary.status === 'completed');
  const failed = mine.filter((q) => q.summary.status === 'failed');
  const durations = done.map((q) => (q.summary.completedAt && q.summary.createdAt ? Date.parse(q.summary.completedAt) - Date.parse(q.summary.createdAt) : NaN)).filter((x) => Number.isFinite(x) && x >= 0);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const fmt = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);
  const workerTasks = Object.values(details).filter((q) => mine.some((x) => x.summary.id === q.id)).flatMap((q) => q.tasks.filter((t) => t.agentKey === agentKey));
  const wDone = workerTasks.filter((t) => t.status === 'done').length, wFailed = workerTasks.filter((t) => t.failed).length;
  const rate = (f: number, ok: number) => (f + ok ? `${Math.round((100 * f) / (f + ok))}%` : '—');
  const rows: [string, string][] = lead
    ? [['Quests on this floor', String(mine.length)], ['Completed', String(done.length)], ['Failed', String(failed.length)], ['Failure rate', rate(failed.length, done.length)], ['Average time to complete', avg != null ? fmt(avg) : '—']]
    : [['Tasks seen', String(workerTasks.length)], ['Done', String(wDone)], ['Failed', String(wFailed)], ['Failure rate', rate(wFailed, wDone)]];
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Record</h3>
      <p className="fine">{lead ? 'From the quests on this floor’s Hermes board.' : 'From the tasks assigned to this agent’s own Hermes profile, in the quests loaded for this floor.'}</p>
      <dl className="record">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {!lead && workerTasks.length > 0 && (
        <ul className="stack tight">{workerTasks.slice(-6).reverse().map((t) => { const v = taskStatusView(t); return <li key={t.id}><Glyph k={v.k} /> {t.title} <span className="muted small">· {v.label}</span></li>; })}</ul>
      )}
      <p className="muted small">Cost per quest needs usage records (spec 6.3) and review grades come with AR reviews (spec 7.2): neither is tracked yet, so they are not shown.</p>
    </section>
  );
}
