/* The Chief of Staff (the executive assistant and AR merged into one person, brief 02). Every visit is a fresh chat
   that opens on what they can do: add a department (a template, or a custom floor designed in conversation), hire one
   specialist (AR's call), or list a floor on the Agent Market while one is not listed yet. A custom floor the last answers with a proposal card built only from what Hermes has. "Looks good"
   creates the floor through the normal department API (and syncs it when Hermes is up). The form stays one click away
   for keyboard and screen-reader users, so nothing depends on the animation or the model. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isInternalOnly, type AssistantView, type DeptDraft, type Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { createDepartment } from '../data/live';
import { lookFor } from '../world/sprites';
import { DialogueFrame, type Line } from './Dialogue';
import { callAr } from './Hiring';

/** The menu every visit opens on (handled here, no model). */
const ADD = 'Add a new floor', HIRE = 'Hire a new agent', LIST = 'List a floor on the Agent Market';
/** Adding a department: a ready template (opens the hire grid, no model needed) or a custom floor drafted in conversation. */
const USE_TEMPLATE = 'Show me the templates', CUSTOM = 'Design a custom floor';
/** After a floor is built: what the boss can do next (handled here, no model). */
const FIRST_JOB = 'Give them a first job', SEE_FLOOR = 'Show me the floor';

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

interface Turn extends Line { draft: DeptDraft | null }

function NewDept() {
  const close = useCallback(() => useStore.getState().ui$({ newDept: false }), []);
  const hermesUp = useStore((s) => s.conn.hermes);
  const creating = useStore((s) => !!s.busy.create);
  const [me, setMe] = useState<AssistantView | null>(null);
  const [lines, setLines] = useState<Turn[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [built, setBuilt] = useState<string | null>(null);
  // listing is offered while some floor can still go on the market (not a company-wallet floor, not listed yet)
  const canList = useStore((s) => s.depts.some((d) => !isInternalOnly(d.view.templateId) && !s.market?.agents.some((a) => a.departmentId === d.id)));
  const menu = [ADD, HIRE, ...(canList ? [LIST] : [])];
  const say = (user: string, text: string, replies: string[]) => setLines((xs) => [...xs,
    { id: crypto.randomUUID(), from: 'user', text: user, mood: null, replies: [], draft: null },
    { id: crypto.randomUUID(), from: 'agent', text, mood: 'happy', replies, draft: null }]);
  useEffect(() => { api.assistant().then(setMe).catch((e: ApiError) => setError(e.message)); }, []);
  const look = useMemo(() => lookFor(`assistant:${me?.character.name ?? ''}`, '#9B5CFF', true), [me?.character.name]);

  const onSend = async (m: string) => {
    const s = useStore.getState();
    if (m === ADD) { say(m, 'A new floor, boss? We can hire a ready team from our templates, or I design a custom one with you. Which will it be?', [USE_TEMPLATE, CUSTOM]); return true; }
    if (m === HIRE) { close(); void callAr(); return true; }
    if (m === LIST) { s.ui$({ newDept: false, marketDraft: true }); return true; }
    if (m === USE_TEMPLATE) { s.ui$({ newDept: false, modal: 'create' }); return true; }
    if (built && m === SEE_FLOOR) { close(); return true; }
    if (built && m === FIRST_JOB) { close(); s.openPanel('board', { composer: true, composerDept: built, boardDept: built, boardQuest: null }); return true; }
    setError(null); setWaiting(true);
    const user: Turn = { id: crypto.randomUUID(), from: 'user', text: m, mood: null, replies: [], draft: null };
    const next = [...lines, user];
    setLines(next);
    try {
      const r = await api.departmentDraft(next.map((t) => ({ from: t.from, text: t.draft ? `${t.text}\n(Proposed: ${JSON.stringify(t.draft)})` : t.text })));
      setLines([...next, { id: crypto.randomUUID(), from: 'agent', text: r.say, mood: r.mood as Mood, replies: r.replies, draft: r.draft }]);
      return true;
    } catch (e) {
      setLines(lines);
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      return false;
    } finally { setWaiting(false); }
  };

  const build = async (d: DeptDraft) => {
    const v = await createDepartment({
      name: d.name, purpose: d.purpose,
      inventory: { allowedSkillIds: d.skills, allowedToolsets: d.toolsets, model: d.model }, teammates: d.teammates, agents: d.agents.map(({ name, title }) => (name ? { name, title } : { title })),
    }, hermesUp);
    if (!v) return; // the toast says why; the proposal stays to try again
    setBuilt(v.id);
    const crew = d.agents.map((a) => a.name || a.title).join(', ');
    const text = hermesUp
      ? `${v.name} is under construction, boss: Hermes is setting up ${crew} right now. What do you want me to do next?`
      : `${v.name} is on the plans, boss, but Hermes is not reachable: it will be built once you sync it. What do you want me to do next?`;
    setLines([...lines, { id: crypto.randomUUID(), from: 'agent', text, mood: 'happy', replies: [FIRST_JOB, LIST, SEE_FLOOR], draft: null }]);
  };
  const last = [...lines].reverse().find((t) => t.from === 'agent') ?? null;

  return (
    <DialogueFrame
      who={me?.character ?? null} look={look} lines={lines} ready={me?.modelReady ?? true} waiting={waiting} error={error}
      greeting="What do you need, boss? I can add a floor, hire a specialist for a floor, or put a floor on the Agent Market."
      notReady="I can't think yet: finish the first quest (your NEAR AI key and my model). The templates still work."
      baseMood="happy" defaultReplies={menu} onSend={onSend} onClose={close}
      inputHint="Or describe a floor, e.g. “handles invoices and chases late payments”"
      cards={() => {
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
                <span><i>Model</i><span className="mono">{d.model ? d.model.id : 'Hermes default'}</span></span>
                <span><i>Agents</i>{d.agents.length}, each its own Hermes agent · ~{d.creditsPerDay} credits/day <small>estimate</small></span>
                <ul className="nd-agents">{d.agents.map((a, i) => (
                  <li key={i}><b>{a.name || a.title}</b><em>{a.name ? a.title : ''}{i === 0 ? (a.name ? ' · lead' : 'lead') : ''}</em>{a.does && <span>{a.does}</span>}</li>
                ))}</ul>
              </span>
              {d.dropped.length > 0 && <span className="nd-dropped">Left out: {d.dropped.join('; ')}.</span>}
              {!hermesUp && <span className="nd-dropped">Hermes is not reachable: the floor will be added now and synced with Hermes later.</span>}
            </div>
            <div className="dlg-prop-act">
              <button className="btn primary small" disabled={creating} onClick={() => void build(d)}>{creating ? 'Building…' : 'Looks good'}</button>
              <button className="btn small" disabled={creating} onClick={() => setLines([])}>Start over</button>
            </div>
          </div>
        );
      }}
    />
  );
}
