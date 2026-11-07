/* The Chief of Staff (the executive assistant and AR merged into one person, brief 02). One door for everything about
   the company's shape: hire a team from a template, find one specialist for a floor (AR's shortlist flow), or design a
   custom floor in conversation; the last answers with a proposal card built only from what Hermes has. "Looks good"
   creates the floor through the normal department API (and syncs it when Hermes is up). The form stays one click away
   for keyboard and screen-reader users, so nothing depends on the animation or the model. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssistantView, DeptDraft, Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { createDepartment } from '../data/live';
import { lookFor } from '../world/sprites';
import { DialogueFrame, type Line } from './Dialogue';
import { callAr } from './Hiring';

/** Floors to draft in conversation (the hiring paths are buttons, so they work without a chat model). */
const IDEAS = ['A floor that handles invoices', 'A floor that answers support tickets', 'A floor that writes our newsletter'];

export function NewDeptWindow() {
  const open = useStore((s) => s.ui.newDept);
  return open ? <NewDept /> : null;
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
  useEffect(() => { api.assistant().then(setMe).catch((e: ApiError) => setError(e.message)); }, []);
  const look = useMemo(() => lookFor(`assistant:${me?.character.name ?? ''}`, '#9B5CFF', true), [me?.character.name]);

  const onSend = async (m: string) => {
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
    await createDepartment({
      name: d.name, purpose: d.purpose,
      inventory: { allowedSkillIds: d.skills, allowedToolsets: d.toolsets, model: d.model }, teammates: d.teammates,
    }, hermesUp);
    // createDepartment opens the new floor on success; the dialogue is done either way unless it failed.
    if (!useStore.getState().busy.create) close();
  };
  /** The hire grid (its "blank floor" link is the plain form). */
  const toForm = () => useStore.getState().ui$({ newDept: false, modal: 'create' });
  const last = [...lines].reverse().find((t) => t.from === 'agent') ?? null;

  return (
    <DialogueFrame
      who={me?.character ?? null} look={look} lines={lines} ready={me?.modelReady ?? true} waiting={waiting} error={error}
      greeting="What do you need, boss? I can hire a whole team from our templates, find one specialist for a floor, or design a new floor with you: just describe it."
      notReady="I can't draft floors without a chat model. Put NEAR_AI_API_KEY in the .env file and restart; templates and the form still work."
      baseMood="happy" defaultReplies={IDEAS} onSend={onSend} onClose={close}
      inputHint="Or describe a floor, e.g. “handles invoices and chases late payments”"
      below={
        <div className="cos-actions" role="group" aria-label="What the Chief of Staff can do">
          <button type="button" className="btn primary small" onClick={toForm}>Hire a team</button>
          <button type="button" className="btn secondary small" onClick={() => { close(); void callAr(); }}>Find a specialist</button>
        </div>
      }
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
                <span><i>Agents</i>{1 + d.teammates} ({d.teammates ? `a lead + ${d.teammates} teammate${d.teammates > 1 ? 's' : ''}, each its own Hermes agent` : 'a lead working alone'}) · ~{d.creditsPerDay} credits/day <small>estimate</small></span>
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
