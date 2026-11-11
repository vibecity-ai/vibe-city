/* The Chief of Staff (the executive assistant and AR merged into one person, brief 02): the CEO's first stop. Anything
   typed here goes to their Hermes agent, which answers from a briefing of the whole company and proposes jobs for the
   floors (one click starts one). Every visit is a fresh chat that also opens on the guided flows: add a department (a template, or a custom floor designed in conversation), hire one
   specialist (AR's call), or list a floor on the Agent Market while one is not listed yet. A custom floor is drafted by the same agent and arrives as a proposal card built only from what Hermes has. "Looks good"
   creates the floor through the normal department API (and syncs it when Hermes is up). The form stays one click away
   for keyboard and screen-reader users, so nothing depends on the animation or the model. */
import { useCallback, useEffect, useState } from 'react';
import { isInternalOnly, type AssistantView, type ChatBriefing, type ChatProposal, type DeptDraft } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { createDepartment, createQuest } from '../data/live';
import { COS_LOOK } from '../world/sprites';
import { DialogueFrame, progressLabel, type Line } from './Dialogue';
import { callAr } from './Hiring';
import { ModelName } from './ModelBadge';

/** The menu every visit opens on (handled here, no model). */
const ADD = 'Add a new floor', HIRE = 'Hire a new agent', LIST = 'List a floor on the Agent Market';
/** Adding a department: a ready template (opens the hire grid, no model needed) or a custom floor drafted in conversation. */
const USE_TEMPLATE = 'Show me the templates', CUSTOM = 'Design a custom floor';
/** After a floor is built: what the boss can do next. A first job is thought up by the Chief of Staff; the floor is shown here. */
const FIRST_JOB = 'Give them a first job', SEE_FLOOR = 'Show me the floor';
/** Free talk with the Hermes agent: the opener, and after a job it proposed was started. */
const BRIEF = 'Brief me', SEE_BOARD = 'Show me the board';
/** The Chief of Staff thinks of a job for a floor and offers it as a Start job card. */
const JOB = 'Give a floor a job';

export function NewDeptWindow() {
  const open = useStore((s) => s.ui.newDept);
  // locked until the first quest sets the Chief of Staff up: every door here sends you to that quest instead
  const locked = useStore((s) => s.game?.quests.some((q) => q.id === 'connect-ai' && !q.done) ?? false);
  useEffect(() => {
    if (!open || !locked) return;
    const s = useStore.getState();
    s.ui$({ newDept: false, questLog: true });
    s.toast('Your Chief of Staff starts work once you finish the first quest: set them up.');
  }, [open, locked]);
  return open && !locked ? <NewDept /> : null;
}

interface Turn extends Line { draft: DeptDraft | null; proposal?: ChatProposal | null; briefing?: ChatBriefing }

function NewDept() {
  const close = useCallback(() => useStore.getState().ui$({ newDept: false }), []);
  const hermesUp = useStore((s) => s.conn.hermes);
  const creating = useStore((s) => !!s.busy.create);
  const [me, setMe] = useState<AssistantView | null>(null);
  const [lines, setLines] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<{ id: string; name: string; purpose: string; crew: string } | null>(null);
  const depts = useStore((s) => s.depts);
  const [progress, setProgress] = useState<string | null>(null);
  const [started, setStarted] = useState<{ turn: string; dept: string } | null>(null);
  // ponytail: a fresh Hermes session per visit keeps turns short and fast; pass the last session id to make it remember
  const [sessionId, setSessionId] = useState<string | null>(null);
  const newSession = useCallback(() => {
    const cos = useStore.getState().chiefOfStaff;
    if (cos) api.chatHistory(cos.id, 'chief', 'new').then((h) => setSessionId(h.sessionId)).catch(() => undefined);
  }, []);
  useEffect(newSession, [newSession]);
  // listing is offered while some floor can still go on the market (not a company-wallet floor, not listed yet)
  const canList = useStore((s) => s.depts.some((d) => !isInternalOnly(d.view.templateId) && !s.market?.agents.some((a) => a.departmentId === d.id)));
  const canWork = useStore((s) => s.depts.some((d) => d.provisioning === 'ready'));
  const menu = [BRIEF, ...(canWork ? [JOB] : []), ADD, HIRE, ...(canList ? [LIST] : [])];
  const say = (user: string, text: string, replies: string[]) => setLines((xs) => [...xs,
    { id: crypto.randomUUID(), from: 'user', text: user, mood: null, replies: [], draft: null },
    { id: crypto.randomUUID(), from: 'agent', text, mood: 'happy', replies, draft: null }]);
  useEffect(() => { api.assistant().then(setMe).catch((e: ApiError) => setError(e.message)); }, []);

  const onSend = async (m: string) => {
    const s = useStore.getState();
    if (m === ADD) { say(m, 'A new floor, boss? We can hire a ready team from our templates, or I design a custom one with you. Which will it be?', [USE_TEMPLATE, CUSTOM]); return true; }
    if (m === HIRE) { close(); void callAr(); return true; }
    if (m === LIST) { s.ui$({ newDept: false, marketDraft: true }); return true; }
    if (m === USE_TEMPLATE) { s.ui$({ newDept: false, modal: 'create' }); return true; }
    if (built && m === SEE_FLOOR) { close(); return true; }
    if (started && m === SEE_BOARD) { close(); s.openPanel('board', { composer: false, boardDept: started.dept, boardFilter: 'all', boardQuest: null }); return true; }
    // the boss sees their chip; the Chief of Staff gets what it needs to think of the floor's first job itself
    const message = built && m === FIRST_JOB
      ? `${m}. ${built.name} was just built (${built.crew}); its purpose: ${built.purpose.replace(/\.?\s*$/, '.')} Think of its first job: one concrete task it can do today with its skills and tools, a quick win that shows what it is for. Propose it for "${built.name}" now, even while it is still being built: I start it once the floor is ready.`
      : m === JOB
      ? `${m}. Pick the floor with the most obvious next step (an idle one first), think of one concrete job it can do now with its skills and tools, and propose it for that floor by its exact name. One job, not a list.`
      : m;
    const cos = s.chiefOfStaff;
    if (!cos?.chief) { setError('I have no desk in Hermes yet, boss: start Hermes and I can talk. The templates, hiring and market shortcuts still work.'); return false; }
    setError(null); setWaiting(true); setProgress(null);
    const user: Turn = { id: crypto.randomUUID(), from: 'user', text: m, mood: null, replies: [], draft: null };
    const next = [...lines, user];
    setLines(next);
    try {
      const r = await api.chatStream(cos.id, 'chief', { message, ...(sessionId ? { sessionId } : {}) }, (p) => setProgress(progressLabel(p)));
      setLines([...next, { ...r.agent, draft: r.agent.floorDraft ?? null }]);
      return true;
    } catch (e) {
      setLines(lines);
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return false;
    } finally { setWaiting(false); setProgress(null); }
  };

  const build = async (d: DeptDraft) => {
    const v = await createDepartment({
      name: d.name, purpose: d.purpose,
      inventory: { allowedSkillIds: d.skills, allowedToolsets: d.toolsets, model: d.model }, teammates: d.teammates, agents: d.agents.map(({ name, title }) => (name ? { name, title } : { title })),
    }, hermesUp);
    if (!v) return; // the toast says why; the proposal stays to try again
    const crew = d.agents.map((a) => a.name || a.title).join(', ');
    setBuilt({ id: v.id, name: v.name, purpose: d.purpose, crew });
    const text = hermesUp
      ? `${v.name} is under construction, boss: Hermes is setting up ${crew} right now. What do you want me to do next?`
      : `${v.name} is on the plans, boss, but Hermes is not reachable: it will be built once you sync it. What do you want me to do next?`;
    setLines([...lines, { id: crypto.randomUUID(), from: 'agent', text, mood: 'happy', replies: [FIRST_JOB, LIST, SEE_FLOOR], draft: null }]);
  };
  const startJob = async (turn: string, p: ChatProposal) => {
    setStarted({ turn, dept: p.departmentId! });
    const id = await createQuest(p.departmentId!, { clientRequestId: crypto.randomUUID(), title: p.title, objective: p.objective });
    if (!id) { setStarted(null); return; } // the toast says why; the card stays to try again
    setLines((xs) => [...xs, { id: crypto.randomUUID(), from: 'agent', text: `Done, boss: "${p.title}" is on ${p.departmentName}'s board. Ask me how it is going any time.`, mood: 'happy', replies: [SEE_BOARD, JOB, BRIEF], draft: null }]);
  };
  const last = [...lines].reverse().find((t) => t.from === 'agent') ?? null;

  return (
    <DialogueFrame
      who={me?.character ?? null} look={COS_LOOK} lines={lines} ready={me?.modelReady ?? true} waiting={waiting} status={progress} error={error}
      greeting="What do you need, boss? Ask me anything about the company, or hand me a job for a floor. I can also add a floor, hire a specialist, or put a floor on the Agent Market."
      notReady="I can't think yet: finish the first quest (your NEAR AI key and my model). The templates still work."
      baseMood="happy" defaultReplies={menu} onSend={onSend} onClose={close}
      inputHint="Ask about the company, say what you need done, or describe a new floor"
      cards={() => {
        const job = last?.proposal;
        // a floor still being built cannot take a job yet: the card waits for it
        const ready = depts.find((d) => d.id === job?.departmentId)?.provisioning === 'ready';
        if (job?.departmentId && started?.turn !== last!.id) return (
          <div className="dlg-prop">
            <div><span className="dlg-tag">Job for {job.departmentName}</span><b>{job.title}</b><span>{job.objective}</span></div>
            <div className="dlg-prop-act"><button className="btn primary small" disabled={!ready} title={ready ? undefined : `${job.departmentName} is still being built`} onClick={() => void startJob(last!.id, job)}>{ready ? 'Start job' : 'Waiting for the floor…'}</button></div>
          </div>
        );
        if (job?.departmentId && started?.turn === last!.id) return <p className="dlg-note">Sending the job to {job.departmentName}…</p>;
        const b = last?.briefing;
        if (b) {
          const s = useStore.getState();
          const toFloor = (dept: string) => { close(); s.openFloor(dept); s.openPanel('board', { composer: false, boardDept: dept, boardFilter: 'all', boardQuest: null }); };
          const rows = (list: ChatBriefing['needsYou']) => list.map((r, i) => (
            <li key={i}>{r.departmentId
              ? <button type="button" onClick={() => toFloor(r.departmentId!)} aria-label={`${r.text} Open ${r.departmentName}'s board`}><i>{r.departmentName}</i><span>{r.text}</span><b aria-hidden="true">▸</b></button>
              : <span>{r.text}</span>}</li>
          ));
          return (
            <section className="brief" aria-label="Company briefing">
              <div className={`brief-col needs${b.needsYou.length ? '' : ' none'}`}><h4>Needs you <em>{b.needsYou.length}</em></h4>
                {b.needsYou.length ? <ul>{rows(b.needsYou)}</ul> : <p>Nothing waits on you.</p>}
                <button type="button" className="brief-more" onClick={() => { close(); s.ui$({ questLog: true }); }}>Quest log ▸</button>
              </div>
              <div className="brief-col"><h4>In flight <em>{b.inFlight.length}</em></h4>
                {b.inFlight.length ? <ul>{rows(b.inFlight)}</ul> : <p>No job is running.</p>}
              </div>
              {b.money && <p className="brief-money"><i>Money</i>{b.money}</p>}
            </section>
          );
        }
        const d = last?.draft;
        if (!d) return null;
        return (
          <div className="dlg-prop nd-card">
            <div>
              <span className="dlg-tag">New floor proposal</span>
              <b>{d.name}</b>
              <span>{d.purpose}</span>
              <span className="nd-rows">
                <span><i>Skills</i>{d.skills.length ? <span className="hire-skills">{d.skills.map((s) => <i key={s}>{s}</i>)}</span> : 'none'}</span>
                <span><i>Tools</i>{d.toolsets.length ? <span className="hire-skills">{d.toolsets.map((s) => <i key={s}>{s}</i>)}</span> : 'none'}</span>
                <span><i>Model</i>{d.model ? <ModelName id={d.model.id} /> : <span className="mono">Hermes default</span>}</span>
                <span><i>Agents</i>{d.agents.length}, each its own Hermes agent</span>
                <ul className="nd-agents">{d.agents.map((a, i) => (
                  <li key={i}><b>{a.name || a.title}</b><em>{a.name ? a.title : ''}{i === 0 ? (a.name ? ' · lead' : 'lead') : ''}</em>{a.does && <span>{a.does}</span>}</li>
                ))}</ul>
              </span>
              {d.dropped.length > 0 && <span className="nd-dropped">Left out: {d.dropped.join('; ')}.</span>}
              {!hermesUp && <span className="nd-dropped">Hermes is not reachable: the floor will be added now and synced with Hermes later.</span>}
            </div>
            <div className="dlg-prop-act">
              <button className="btn primary small" disabled={creating} onClick={() => void build(d)}>{creating ? 'Building…' : 'Looks good'}</button>
              <button className="btn small" disabled={creating} onClick={() => { setLines([]); newSession(); }}>Start over</button>
            </div>
          </div>
        );
      }}
    />
  );
}
