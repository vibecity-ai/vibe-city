/* Agent View pieces (feature spec 2.2): the character header, the chat transcript and the record. Everything shown is
   read from the backend (persona, stored chat, quests and tasks Hermes reports); numbers the game cannot know yet
   (cost, review grades) say so instead of guessing. */
import { useEffect, useMemo, useState } from 'react';
import type { Character, ChatMessage } from '@vibe-city/shared';
import { useStore } from '../store';
import type { Dept, AgentStatus } from '../data/types';
import { api, ApiError } from '../../api';
import { lookFor, quirkProp } from '../world/sprites';
import { PortraitCanvas } from './Dialogue';
import { formatTime } from './format';
import { taskStatusView } from '../data/views';
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

export function ChatTranscript({ deptId, agentKey, onTalk }: { deptId: string; agentKey: string; onTalk: () => void }) {
  const ch = usePersona(deptId, agentKey);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.chatHistory(deptId, agentKey).then((h) => setMessages(h.messages)).catch((e: ApiError) => setError(e.message)); }, [deptId, agentKey]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (messages ?? []).filter((m) => words.every((w) => m.text.toLowerCase().includes(w)));
  return (
    <section className="pane-sec">
      <div className="head-row"><h3 className="sec-t">Conversations {messages && <span className="count">{messages.length}</span>}</h3><button className="btn primary small" onClick={onTalk}>Talk</button></div>
      <p className="fine">Every dialogue-window conversation with {ch?.name ?? 'this agent'}. Chat never starts work: a request becomes a quest proposal you accept.</p>
      {messages && messages.length > 0 && <input className="input" type="search" placeholder="Search this transcript" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the transcript" />}
      {error && <p className="field-err" role="alert">{error}</p>}
      {!messages && !error && <p className="muted" aria-busy="true">Loading…</p>}
      {messages?.length === 0 && <p className="muted">No conversations yet. Press Talk to start one.</p>}
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

export function AgentRecord({ d, role }: { d: Dept; role: 'chief' | 'worker' }) {
  const quests = useStore((s) => s.quests);
  const details = useStore((s) => s.details);
  const mine = quests.filter((q) => q.deptId === d.id);
  const done = mine.filter((q) => q.summary.status === 'completed');
  const failed = mine.filter((q) => q.summary.status === 'failed');
  const durations = done.map((q) => (q.summary.completedAt && q.summary.createdAt ? Date.parse(q.summary.completedAt) - Date.parse(q.summary.createdAt) : NaN)).filter((x) => Number.isFinite(x) && x >= 0);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const fmt = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86_400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86_400_000).toFixed(1)} days`);
  const workerTasks = Object.values(details).filter((q) => mine.some((x) => x.summary.id === q.id)).flatMap((q) => q.tasks.filter((t) => t.role === 'worker'));
  const wDone = workerTasks.filter((t) => t.status === 'done').length, wFailed = workerTasks.filter((t) => t.failed).length;
  const rate = (f: number, ok: number) => (f + ok ? `${Math.round((100 * f) / (f + ok))}%` : '—');
  const rows: [string, string][] = role === 'chief'
    ? [['Quests on this floor', String(mine.length)], ['Completed', String(done.length)], ['Failed', String(failed.length)], ['Failure rate', rate(failed.length, done.length)], ['Average time to complete', avg != null ? fmt(avg) : '—']]
    : [['Worker tasks seen', String(workerTasks.length)], ['Done', String(wDone)], ['Failed', String(wFailed)], ['Failure rate', rate(wFailed, wDone)]];
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Record</h3>
      <p className="fine">{role === 'chief' ? 'From the quests on this floor’s Hermes board.' : 'From the worker tasks in the quests loaded for this floor. All worker desks share one Hermes profile, so this is the desks’ combined record.'}</p>
      <dl className="record">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {role === 'worker' && workerTasks.length > 0 && (
        <ul className="stack tight">{workerTasks.slice(-6).reverse().map((t) => { const v = taskStatusView(t); return <li key={t.id}><Glyph k={v.k} /> {t.title} <span className="muted small">· {v.label}</span></li>; })}</ul>
      )}
      <p className="muted small">Cost per quest needs usage records (spec 6.3) and review grades come with AR reviews (spec 7.2): neither is tracked yet, so they are not shown.</p>
    </section>
  );
}
