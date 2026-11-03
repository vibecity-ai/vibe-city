/* The dialogue window (feature spec 2.1): letterbox bars, the live office on the left with the camera on the speaker,
   a slanted portrait panel on the right, and big typed-out pixel text in the bottom bar. It is a real chat: what the
   speaker says comes from the model through the backend; nothing here is scripted except greetings, which only state
   what the city already shows. `DialogueFrame` is the shared window; agents (here), AR and job candidates (Hiring.tsx)
   each feed it their own lines and cards. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Character, ChatMessage, ChatProposal, Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { createQuest } from '../data/live';
import { lookFor, quirkProp, type Look } from '../world/sprites';
import { portrait, type Gag } from '../world/portrait';
import { Icon } from './kit';

const PAGE = 92;
const CPS = 42;

/** Split text into pages that fit the text bar: whole sentences where they fit, whole words otherwise. */
export function paginate(text: string): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  const pages: string[] = []; let cur = '';
  const push = () => { if (cur.trim()) pages.push(cur.trim()); cur = ''; };
  for (const raw of sentences) {
    const sen = raw.trim(); if (!sen) continue;
    if ((cur + ' ' + sen).trim().length <= PAGE) { cur = (cur + ' ' + sen).trim(); continue; }
    push();
    if (sen.length <= PAGE) { cur = sen; continue; }
    for (const w of sen.split(' ')) {
      if ((cur + ' ' + w).trim().length > PAGE && cur) push();
      cur = (cur + ' ' + w).trim();
    }
  }
  push();
  return pages.length ? pages : [''];
}

let audio: AudioContext | null = null;
export function blip(freq: number, vol = 0.035, len = 0.05) {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = 'square'; o.frequency.value = freq * (0.94 + Math.random() * 0.12);
    g.gain.setValueAtTime(vol, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + len);
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + len + 0.01);
  } catch { /* audio blocked: silent */ }
}
export const readMuted = () => { try { return localStorage.getItem('vc-dialogue-muted') === '1'; } catch { return false; } };
const saveMuted = (v: boolean) => { try { localStorage.setItem('vc-dialogue-muted', v ? '1' : '0'); } catch { /* ignore */ } };

export function PortraitCanvas({ look, mood, talking, size, gag = null, className = 'dlg-portrait' }: { look: Look; mood: Mood; talking: boolean; size: number; gag?: Gag | null; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0; const t0 = performance.now();
    const draw = (t: number) => {
      const el = ref.current; if (!el) return;
      const e = (t - t0) / 1000;
      const blink = (e % 3.4) > 3.25;
      const mouth = talking && Math.floor(e * 9) % 2 === 0;
      const g = el.getContext('2d')!; g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, el.width, el.height);
      g.drawImage(portrait(look, mood, mouth, blink, gag), 0, 0, el.width, el.height);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [look, mood, talking, gag]);
  return <canvas ref={ref} width={size} height={size} className={className} aria-hidden="true" />;
}

export interface Line { id: string; from: 'user' | 'agent'; text: string; mood: Mood | null; replies: string[] }
export interface Who { name: string; title: string; color: string; voice: number }

/** The shared window. The parent owns the conversation (lines, waiting, error); the frame owns paging, typing and input. */
export function DialogueFrame({ who, look, gag = null, lines, ready, waiting, error, greeting, notReady, baseMood = 'neutral', defaultReplies = [],
  onSend, onClose, onProfile, cards, below, hideInput, inputHint }: {
  who: Who | null; look: Look; gag?: Gag | null; lines: Line[]; ready: boolean; waiting: boolean; error: string | null;
  greeting: string; notReady?: string; baseMood?: Mood; defaultReplies?: string[];
  /** Resolves false when sending failed: the typed text goes back into the box. */
  onSend: (msg: string) => Promise<boolean>;
  onClose: () => void; onProfile?: () => void;
  /** Shown once the speaker has finished talking (proposal cards, brief cards…). */
  cards?: (lastAgent: Line | null) => ReactNode;
  /** A small line under the text bar (interview stats, scouting timer). */
  below?: ReactNode;
  hideInput?: boolean; inputHint?: string;
}) {
  const [input, setInput] = useState('');
  const [page, setPage] = useState(0);
  const [shown, setShown] = useState(0);
  const [muted, setMuted] = useState(readMuted);
  const inputRef = useRef<HTMLInputElement>(null);

  const lastAgent = [...lines].reverse().find((m) => m.from === 'agent') ?? null;
  const speech = error ?? (!ready ? (notReady ?? 'No chat model is set up. Put NEAR_AI_API_KEY in the .env file and restart the container, then we can talk.') : lastAgent?.text ?? greeting);
  const pages = useMemo(() => paginate(speech), [speech]);
  const text = pages[Math.min(page, pages.length - 1)] ?? '';
  const typing = !waiting && shown < text.length;
  const lastPage = page >= pages.length - 1;
  const done = !waiting && !typing && lastPage;
  const mood: Mood = waiting ? 'focused' : error ? 'worried' : lastAgent?.mood ?? baseMood;

  useEffect(() => { setPage(0); setShown(0); }, [speech]);
  useEffect(() => { setShown(0); }, [page]);
  useEffect(() => { if (!waiting) inputRef.current?.focus(); }, [waiting, who]);
  // Time-based typing: on a busy main thread a tick can add several characters, so the speed never drops.
  const typeStart = useRef(0);
  useEffect(() => { typeStart.current = performance.now(); }, [text, waiting]);
  useEffect(() => {
    if (!typing) return;
    const id = window.setTimeout(() => {
      const n = Math.min(text.length, Math.max(shown + 1, Math.floor(((performance.now() - typeStart.current) / 1000) * CPS)));
      setShown(n);
      if (!muted && who && /\S/.test(text.slice(shown, n))) blip(who.voice);
    }, 1000 / CPS * 2);
    return () => window.clearTimeout(id);
  }, [typing, shown, text, muted, who]);

  const advance = () => { if (typing) setShown(text.length); else if (!lastPage) setPage((p) => p + 1); };
  const send = async (msg: string) => {
    const m = msg.trim(); if (!m || waiting || !ready) return;
    setInput('');
    if (!(await onSend(m))) setInput(m);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if ((e.key === ' ' || e.key === 'Enter') && (typing || !lastPage) && (document.activeElement !== inputRef.current || !input.trim())) { e.preventDefault(); advance(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const color = who?.color ?? '#FFC75A';
  const replies = done && !error && ready ? (lastAgent?.replies.length ? lastAgent.replies : lines.length ? [] : defaultReplies) : [];
  const shownText = waiting ? '' : text.slice(0, shown);

  return (
    <div className="dlg" role="dialog" aria-modal="true" aria-label={`Talking to ${who?.name ?? 'agent'}`} style={{ ['--who' as string]: color }}>
      <div className="dlg-bar top" />
      <div className="dlg-band" onClick={advance}>
        <div className="dlg-side" style={{ background: `linear-gradient(160deg, ${color} 0%, ${color} 30%, #3a1240 100%)` }}>
          <PortraitCanvas look={look} mood={mood} talking={typing} size={384} gag={gag} />
          <div className="dlg-name"><b>{who?.name ?? '…'}</b><span>{who?.title ?? ''}</span></div>
        </div>
      </div>
      <div className="dlg-bar bottom">
        <div className="dlg-text" onClick={advance} aria-live="polite">
          <span className="sr">{waiting ? 'Thinking' : speech}</span>
          <p aria-hidden="true">{shownText}{waiting && <span className="dlg-dots"><i>.</i><i>.</i><i>.</i></span>}{!waiting && !typing && <span className={`dlg-caret${lastPage ? '' : ' more'}`}>{lastPage ? '■' : '▼'}</span>}</p>
        </div>
        {below}
        {done && !error && cards?.(lastAgent)}
        <div className="dlg-replies">{replies.map((r) => <button key={r} className="dlg-chip" onClick={() => void send(r)}>{r}</button>)}</div>
        <form className="dlg-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          {!hideInput && <>
            <span className="dlg-you">YOU&gt;</span>
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} disabled={!ready || waiting} placeholder={ready ? (inputHint ?? 'Say something…') : 'Chat is off until a model is configured'} aria-label={`Message ${who?.name ?? 'agent'}`} />
            <button className="btn primary small" type="submit" disabled={!ready || waiting || !input.trim()}>Send</button>
          </>}
          {hideInput && <span className="dlg-spacer" />}
          <button type="button" className="dlg-icon" onClick={() => { const v = !muted; setMuted(v); saveMuted(v); }} aria-label={muted ? 'Turn voice blips on' : 'Turn voice blips off'} title={muted ? 'Sound off' : 'Sound on'}>{muted ? '♪̸' : '♪'}</button>
          {onProfile && <button type="button" className="dlg-icon" onClick={onProfile} title="Open profile" aria-label="Open agent profile"><Icon n="sliders" size={14} /></button>}
          <button type="button" className="dlg-icon" onClick={onClose} aria-label="Close dialogue (Esc)" title="Close (Esc)"><Icon n="x" size={14} /></button>
        </form>
      </div>
    </div>
  );
}

/* ---------- talking to a department agent (chief or worker desk) ---------- */

export function DialogueWindow() {
  const talk = useStore((s) => s.ui.talk);
  if (!talk) return null;
  return <AgentDialogue key={`${talk.deptId}:${talk.agentKey}`} deptId={talk.deptId} agentKey={talk.agentKey} />;
}

function AgentDialogue({ deptId, agentKey }: { deptId: string; agentKey: string }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId));
  const worker = agentKey === 'chief' ? null : d?.workers.find((w) => w.id === agentKey) ?? null;
  const close = useCallback(() => useStore.getState().ui$({ talk: null }), []);

  const [ch, setCh] = useState<Character | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [proposalDone, setProposalDone] = useState<Record<string, 'started' | 'dismissed'>>({});

  useEffect(() => {
    let live = true;
    api.chatHistory(deptId, agentKey).then((h) => { if (!live) return; setCh(h.character); setMessages(h.messages); setReady(h.modelReady); })
      .catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [deptId, agentKey]);

  const look = useMemo(() => ({ ...lookFor(deptId + ':' + agentKey, worker?.shirt ?? '#FFFFFF', agentKey === 'chief'), prop: quirkProp(ch?.quirk) }), [deptId, agentKey, worker?.shirt, ch?.quirk]);
  const status = agentKey === 'chief' ? d?.chief?.status : worker?.status;
  const greeting = !ch ? '' : agentKey === 'chief'
    ? `${ch.name}. ${d?.chief?.activity && d.chief.activity !== 'Waiting for a quest' ? d.chief.activity + '.' : 'Nothing on my desk right now.'} What do you need, boss?`
    : `${ch.name}, desk ${agentKey}. ${worker ? `Working on "${worker.task}".` : ''} What's up, boss?`;

  const onSend = async (m: string) => {
    setError(null); setWaiting(true);
    setMessages((xs) => [...xs, { id: 'pending', from: 'user', text: m, mood: null, replies: [], proposal: null, at: new Date().toISOString() }]);
    try {
      const r = await api.chat(deptId, agentKey, { message: m, ...(worker ? { taskTitle: worker.task } : {}) });
      setMessages((xs) => [...xs.filter((x) => x.id !== 'pending'), r.user, r.agent]);
      return true;
    } catch (e) {
      setMessages((xs) => xs.filter((x) => x.id !== 'pending'));
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return false;
    } finally { setWaiting(false); }
  };

  const startQuest = async (msgId: string, p: ChatProposal) => {
    setProposalDone((x) => ({ ...x, [msgId]: 'started' }));
    const id = await createQuest(deptId, { clientRequestId: crypto.randomUUID(), title: p.title, objective: p.objective });
    if (!id) setProposalDone((x) => { const { [msgId]: _, ...rest } = x; return rest; });
  };

  if (!d) return null;
  const last = [...messages].reverse().find((m) => m.from === 'agent') ?? null;
  return (
    <DialogueFrame
      who={ch} look={look} lines={messages} ready={ready} waiting={waiting} error={error} greeting={greeting}
      baseMood={status === 'failed' ? 'worried' : status === 'running' ? 'focused' : 'neutral'}
      defaultReplies={['What are you working on?', 'How is the floor doing?', 'I have a job for you']}
      onSend={onSend} onClose={close}
      onProfile={() => { close(); useStore.getState().ui$({ agent: agentKey, panel: 'agent' }); }}
      cards={() => {
        if (!last) return null;
        if (proposalDone[last.id] === 'started') return <p className="dlg-note">Quest sent to the board. Watch the Kanban wall.</p>;
        if (!last.proposal || proposalDone[last.id]) return null;
        const p = last.proposal;
        return (
          <div className="dlg-prop">
            <div><span className="dlg-tag">Quest proposal</span><b>{p.title}</b><span>{p.objective}</span></div>
            <div className="dlg-prop-act">
              <button className="btn primary small" onClick={() => void startQuest(last.id, p)}>Start quest</button>
              <button className="btn small" onClick={() => setProposalDone((x) => ({ ...x, [last.id]: 'dismissed' }))}>Not now</button>
            </div>
          </div>
        );
      }}
    />
  );
}
