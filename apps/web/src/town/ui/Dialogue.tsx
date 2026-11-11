/* The dialogue window (feature spec 2.1): letterbox bars, the live office on the left with the camera on the speaker,
   a slanted portrait panel on the right, and big typed-out pixel text in the bottom bar. It is a real chat: what the
   speaker says comes from the model through the backend; nothing here is scripted except greetings, which only state
   what the city already shows. `DialogueFrame` is the shared window; agents (here), AR and job candidates (Hiring.tsx)
   each feed it their own lines and cards. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Character, ChatMessage, ChatProgress, ChatProposal, Mood } from '@vibe-city/shared';
import { useStore, type BlockedTalk } from '../store';
import { api, ApiError } from '../../api';
import { answerTask, createQuest } from '../data/live';
import { agentLabel, farewellLine, nameProfiles } from '../data/views';
import { lookFor, quirkProp, type Look } from '../world/sprites';
import { portrait, type Gag } from '../world/portrait';
import { Icon } from './kit';

/** Answers longer than this are a report, not a line of dialogue: smaller type, typed faster, with a copy button. */
const LONG = 280;
const CPS = 42;

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
export function DialogueFrame({ who, look, gag = null, lines, ready, waiting, status = null, error, greeting, notReady, baseMood = 'neutral', defaultReplies = [],
  onSend, onClose, onProfile, onNewChat, cards, below, hideInput, inputHint, farewell }: {
  who: Who | null; look: Look; gag?: Gag | null; lines: Line[]; ready: boolean; waiting: boolean; error: string | null;
  /** What the speaker is doing while the user waits ("checking the board…"). */
  status?: string | null;
  greeting: string; notReady?: string; baseMood?: Mood; defaultReplies?: string[];
  /** Resolves false when sending failed: the typed text goes back into the box. */
  onSend: (msg: string) => Promise<boolean>;
  onClose: () => void; onProfile?: () => void;
  /** Starts a fresh chat with the same speaker. */
  onNewChat?: () => void;
  /** Shown once the speaker has finished talking (proposal cards, brief cards…). */
  cards?: (lastAgent: Line | null) => ReactNode;
  /** A small line under the text bar (stats, notes). */
  below?: ReactNode;
  hideInput?: boolean; inputHint?: string;
  /** Said when the CEO ends a chat they took part in: the speaker signs off before the window closes. */
  farewell?: string;
}) {
  const [input, setInput] = useState('');
  const [shown, setShown] = useState(0);
  const [muted, setMuted] = useState(readMuted);
  // Ending a chat: the speaker types a sign-off, then the window closes by itself (a second Esc or click closes now).
  const [leaving, setLeaving] = useState(false);
  const spoke = lines.some((l) => l.from === 'user');
  const end = () => { if (leaving || !farewell || !spoke || waiting || error || !ready) onClose(); else setLeaving(true); };
  const inputRef = useRef<HTMLInputElement>(null);

  const lastAgent = [...lines].reverse().find((m) => m.from === 'agent') ?? null;
  const speech = leaving ? farewell! : error ?? (!ready ? (notReady ?? 'No chat model is set up yet. Finish the first quest (your NEAR AI key and the Chief of Staff model), then we can talk.')
    : lastAgent?.text ?? greeting);
  // A long answer (Hermes agents report results in full) stays in this one box: it grows, then scrolls.
  const long = speech.length > LONG, cps = long ? CPS * 4 : CPS;
  const [copied, setCopied] = useState(false);
  const copy = async () => { try { await navigator.clipboard.writeText(speech); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  // The whole reply types into one box that follows the text as it goes (no clicking through pages).
  const text = speech;
  const typing = !waiting && shown < text.length;
  const done = !waiting && !typing;
  const mood: Mood = leaving ? 'happy' : waiting ? 'focused' : error ? 'worried' : lastAgent?.mood ?? baseMood;

  useEffect(() => { setShown(0); }, [speech]);
  // a modal: Tab stays inside, and closing hands focus back to whatever opened it (captured before the input takes it)
  const root = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => { if (opener?.isConnected) opener.focus(); }, [opener]);
  const textBox = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = textBox.current; if (el) el.scrollTop = el.scrollHeight; }, [shown, waiting, text]);
  useEffect(() => { if (!waiting) inputRef.current?.focus(); }, [waiting, who]);
  // Time-based typing: on a busy main thread a tick can add several characters, so the speed never drops.
  const typeStart = useRef(0);
  useEffect(() => { typeStart.current = performance.now(); }, [text, waiting]);
  useEffect(() => {
    if (!typing) return;
    const id = window.setTimeout(() => {
      const n = Math.min(text.length, Math.max(shown + 1, Math.floor(((performance.now() - typeStart.current) / 1000) * cps)));
      setShown(n);
      if (!muted && who && /\S/.test(text.slice(shown, n))) blip(who.voice);
    }, 1000 / CPS * 2);
    return () => window.clearTimeout(id);
  }, [typing, shown, text, muted, who, cps]);

  const advance = () => { if (typing) setShown(text.length); else if (leaving) onClose(); };
  useEffect(() => {
    if (!leaving || typing) return;
    const id = window.setTimeout(onClose, 1500);
    return () => window.clearTimeout(id);
  }, [leaving, typing, onClose]);
  const send = async (msg: string) => {
    const m = msg.trim(); if (!m || waiting || !ready) return;
    setInput('');
    if (!(await onSend(m))) setInput(m);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); end(); }
      else if (e.key === 'Tab' && root.current) {
        const f = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]')];
        const first = f[0], last = f.at(-1), at = document.activeElement;
        if (!first || !last) return;
        if (!root.current.contains(at)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
      } else if ((e.key === ' ' || e.key === 'Enter') && typing && (document.activeElement !== inputRef.current || !input.trim())) { e.preventDefault(); advance(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const color = who?.color ?? '#FFC75A';
  const replies = done && !leaving && !error && ready ? (lastAgent?.replies.length ? lastAgent.replies : lines.length ? [] : defaultReplies) : [];
  const shownText = waiting ? '' : text.slice(0, shown);

  return (
    <div className="dlg" ref={root} role="dialog" aria-modal="true" aria-label={`Talking to ${who?.name ?? 'agent'}`} style={{ ['--who' as string]: color }}>
      <div className="dlg-bar dlg-top" />
      <div className="dlg-band" onClick={advance}>
        <div className="dlg-side">
          <PortraitCanvas look={look} mood={mood} talking={typing} size={384} gag={gag} />
        </div>
      </div>
      <div className="dlg-bar dlg-bottom">
        <div className="dlg-plate"><b>{who?.name ?? '…'}</b><span>{who?.title ?? ''}</span></div>
        <div className={`dlg-text${long ? ' long' : ''}`} ref={textBox} onClick={advance} aria-live="polite">
          <span className="sr">{waiting ? status ?? 'Thinking' : speech}</span>
          <p aria-hidden="true">{shownText}{waiting && <span className="dlg-wait"><span className="dlg-status">{status ?? 'thinking'}</span><span className="dlg-dots"><i /><i /><i /></span></span>}{!waiting && !typing && <span className="dlg-caret">■</span>}</p>
        </div>
        {done && long && !leaving && !error && <button type="button" className="dlg-copy" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy answer'}</button>}
        {below}
        {done && !leaving && !error && cards?.(lastAgent)}
        <div className="dlg-replies">{replies.map((r) => <button key={r} className="dlg-chip" onClick={() => void send(r)}>{r}</button>)}</div>
        <form className="dlg-input" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          {!hideInput && !leaving && <>
            <span className="dlg-you">YOU&gt;</span>
            <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000} disabled={!ready || waiting} placeholder={ready ? (inputHint ?? 'Say something…') : 'Chat is off right now'} aria-label={`Message ${who?.name ?? 'agent'}`} />
            <button className="btn primary small" type="submit" disabled={!ready || waiting || !input.trim()}>Send</button>
          </>}
          {(hideInput || leaving) && <span className="dlg-spacer" />}
          <button type="button" className="dlg-icon" onClick={() => { const v = !muted; setMuted(v); saveMuted(v); }} aria-label={muted ? 'Turn voice blips on' : 'Turn voice blips off'} title={muted ? 'Sound off' : 'Sound on'}>{muted ? '♪̸' : '♪'}</button>
          {onNewChat && <button type="button" className="dlg-icon" onClick={onNewChat} disabled={waiting} title="New chat" aria-label="Start a new chat"><Icon n="plus" size={14} /></button>}
          {onProfile && <button type="button" className="dlg-icon" onClick={onProfile} title="Open profile" aria-label="Open agent profile"><Icon n="sliders" size={14} /></button>}
          <button type="button" className="dlg-icon" onClick={end} aria-label="End chat (Esc)" title="End chat (Esc)"><Icon n="x" size={14} /></button>
        </form>
      </div>
    </div>
  );
}

/* ---------- talking to a department agent (chief or worker desk) ---------- */

/** The agent's work while it answers, in the dialogue's words. */
export function progressLabel(p: ChatProgress): string {
  if (p.kind === 'thinking') return 'thinking';
  if (p.kind === 'approval') return `waiting for approval${p.command ? `: ${p.command.slice(0, 60)}` : ''}`;
  const name = p.name.replace(/^mcp_[a-z0-9]+_/, '').replace(/_/g, ' ');
  return /kanban/.test(p.name) ? 'checking the board' : `using ${name}`;
}

const SEE_BOARD = 'Show me the board';

export function DialogueWindow() {
  const talk = useStore((s) => s.ui.talk);
  if (!talk) return null;
  return <AgentDialogue key={`${talk.deptId}:${talk.agentKey}:${talk.session ?? ''}:${talk.blocked?.taskId ?? ''}`} deptId={talk.deptId} agentKey={talk.agentKey} session={talk.session} blocked={talk.blocked} />;
}

function AgentDialogue({ deptId, agentKey, session, blocked }: { deptId: string; agentKey: string; session?: string; blocked?: BlockedTalk }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId) ?? (s.chiefOfStaff?.id === deptId ? s.chiefOfStaff : undefined));
  const personas = useStore((s) => s.personas);
  const quests = useStore((s) => s.quests);
  const worker = agentKey === 'chief' ? null : d?.workers.find((w) => w.id === agentKey) ?? null;
  const close = useCallback(() => useStore.getState().ui$({ talk: null }), []);

  const [ch, setCh] = useState<Character | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [proposalDone, setProposalDone] = useState<Record<string, 'started' | 'dismissed'>>({});
  const [resumed, setResumed] = useState<Record<string, 'sending' | 'sent' | 'dismissed'>>({});

  useEffect(() => {
    let live = true;
    api.chatHistory(deptId, agentKey, session).then((h) => { if (!live) return; setCh(h.character); setSessionId(h.sessionId); setMessages(h.messages); setReady(h.modelReady); })
      .catch((e: ApiError) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [deptId, agentKey, session]);

  const look = useMemo(() => ({ ...lookFor(deptId + ':' + agentKey, worker?.shirt ?? '#FFFFFF', agentKey === 'chief'), prop: quirkProp(ch?.quirk) }), [deptId, agentKey, worker?.shirt, ch?.quirk]);
  const status = agentKey === 'chief' ? d?.chief?.status : worker?.status;
  const greeting = !ch ? '' : blocked
    ? `${ch.name} here. I'm stuck on "${blocked.title}" and need your input before I can carry on.`
    : agentKey === 'chief'
    ? `${ch.name}. ${d?.chief?.activity && d.chief.activity !== 'Waiting for a job' ? d.chief.activity + '.' : 'Nothing on my desk right now.'} What do you need, boss?`
    : `${ch.name} here. ${worker ? `Working on "${worker.task}".` : ''} What's up, boss?`;

  const onSend = async (m: string) => {
    if (m === SEE_BOARD) { close(); useStore.getState().openPanel('board', { composer: false, boardDept: deptId, boardFilter: 'all', boardQuest: null }); return true; }
    setError(null); setWaiting(true); setProgress(null);
    setMessages((xs) => [...xs, { id: 'pending', from: 'user', text: m, mood: null, replies: [], proposal: null, at: new Date().toISOString() }]);
    try {
      const r = await api.chatStream(deptId, agentKey, { message: m, ...(worker ? { taskTitle: worker.task } : {}), ...(sessionId ? { sessionId } : {}), ...(blocked ? { blockedTask: { title: blocked.title, reason: blocked.reason } } : {}) }, (p) => setProgress(progressLabel(p)));
      setMessages((xs) => [...xs.filter((x) => x.id !== 'pending'), r.user, r.agent]);
      return true;
    } catch (e) {
      setMessages((xs) => xs.filter((x) => x.id !== 'pending'));
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return false;
    } finally { setWaiting(false); setProgress(null); }
  };

  const startQuest = async (msgId: string, p: ChatProposal) => {
    setProposalDone((x) => ({ ...x, [msgId]: 'started' }));
    const id = await createQuest(deptId, { clientRequestId: crypto.randomUUID(), title: p.title, objective: p.objective });
    if (!id) { setProposalDone((x) => { const { [msgId]: _, ...rest } = x; return rest; }); return; }
    // the agent acknowledges, so the proposal's old reply chips ("say the word…") are gone
    setMessages((xs) => [...xs, { id: `ack:${msgId}`, from: 'agent', text: `On it, boss: "${p.title}" is on the board. I'll report back when it's done. Anything else?`,
      mood: 'happy', replies: [SEE_BOARD, 'I have another job for you'], proposal: null, at: new Date().toISOString() }]);
  };

  if (!d) return null;
  const last = [...messages].reverse().find((m) => m.from === 'agent') ?? null;
  // agents name teammates by profile id; the scene says their names
  const named = (t: string) => nameProfiles(t, d.view.agents, (k) => agentLabel(k, personas[`${deptId}:${k}`]));
  const lines = messages.map((m) => (m.from === 'agent' ? { ...m, text: named(m.text) } : m));
  return (
    <DialogueFrame
      who={ch} look={look} lines={lines} ready={ready} waiting={waiting} status={progress} error={error} greeting={greeting}
      notReady="I don't have a desk in Hermes yet. Sync this floor with Hermes first, then we can talk."
      baseMood={status === 'failed' ? 'worried' : status === 'running' ? 'focused' : 'neutral'}
      defaultReplies={blocked ? ["What's the problem?", 'What do you need from me?'] : ['What are you working on?', 'How is the floor doing?', 'I have a job for you']}
      onSend={onSend} onClose={close}
      {...(agentKey === 'chief' ? {} : { farewell: farewellLine({ task: worker?.status === 'running' ? worker.task : null, n: messages.length }) })}
      onNewChat={() => useStore.getState().ui$({ talk: { deptId, agentKey, session: 'new' } })}
      onProfile={() => { close(); useStore.getState().ui$({ agent: agentKey, panel: 'agent' }); }}
      cards={() => {
        if (!last) return null;
        if (blocked && resumed[last.id] === 'sent') return <p className="dlg-note">Sent. "{blocked.title}" is back in the queue.</p>;
        if (blocked && last.resume && resumed[last.id] !== 'dismissed') {
          const r = last.resume;
          const go = async () => {
            setResumed((x) => ({ ...x, [last.id]: 'sending' }));
            const ok = await answerTask(deptId, blocked.questId, blocked.taskId, r);
            setResumed((x) => (ok ? { ...x, [last.id]: 'sent' } : (({ [last.id]: _, ...rest }) => rest)(x)));
          };
          return (
            <div className="dlg-prop">
              <div><span className="dlg-tag">Resume the task</span><b>{blocked.title}</b><span>{r}</span></div>
              <div className="dlg-prop-act">
                <button className="btn primary small" disabled={resumed[last.id] === 'sending'} onClick={() => void go()}>{resumed[last.id] === 'sending' ? 'Sending…' : 'Resume with this'}</button>
                <button className="btn small" onClick={() => setResumed((x) => ({ ...x, [last.id]: 'dismissed' }))}>Not yet</button>
              </div>
            </div>
          );
        }
        if (proposalDone[last.id] === 'started') return <p className="dlg-note">Job sent to the board. Watch the Ops board.</p>;
        if (!last.proposal || proposalDone[last.id]) return null;
        const p = last.proposal;
        // a resumed chat forgets that its proposal was started: the board remembers, so never offer a duplicate
        const same = (t: string) => t.trim().toLowerCase() === p.title.trim().toLowerCase();
        if (quests.some((q) => q.deptId === deptId && same(q.summary.title))) return <p className="dlg-note">"{p.title}" is already on the board.</p>;
        return (
          <div className="dlg-prop">
            <div><span className="dlg-tag">Job proposal</span><b>{p.title}</b><span>{p.objective}</span></div>
            <div className="dlg-prop-act">
              <button className="btn primary small" onClick={() => void startQuest(last.id, p)}>Start job</button>
              <button className="btn small" onClick={() => setProposalDone((x) => ({ ...x, [last.id]: 'dismissed' }))}>Not now</button>
            </div>
          </div>
        );
      }}
    />
  );
}
