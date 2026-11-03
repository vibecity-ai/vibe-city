/* Add Department through the dialogue window (feature spec 4.3). The executive assistant asks what the floor is for
   and answers with a proposal card built only from what Hermes has. "Looks good" creates the floor through the normal
   department API (and provisions it when Hermes is up). The three-step form stays one click away for keyboard and
   screen-reader users, so nothing depends on the animation or the model. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssistantView, DeptDraft, Mood } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { createDepartment } from '../data/live';
import { lookFor } from '../world/sprites';
import { DialogueFrame, type Line } from './Dialogue';

const TEMPLATES = ['A Research floor', 'A Sales floor', 'A Support floor', 'A Finance floor', 'A Legal floor', 'A Trading desk'];

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
      inventory: { allowedSkillIds: d.skills, allowedToolsets: d.toolsets, model: d.model, limits: { maxConcurrentWorkers: d.workers } },
    }, hermesUp);
    // createDepartment opens the new floor on success; the dialogue is done either way unless it failed.
    if (!useStore.getState().busy.create) close();
  };
  const toForm = () => useStore.getState().ui$({ newDept: false, modal: 'create' });
  const last = [...lines].reverse().find((t) => t.from === 'agent') ?? null;

  return (
    <DialogueFrame
      who={me?.character ?? null} look={look} lines={lines} ready={me?.modelReady ?? true} waiting={waiting} error={error}
      greeting="A new floor! What should it do, boss? Pick a template or tell me in your own words."
      notReady="I can't draft floors without a chat model. Put NEAR_AI_API_KEY in the .env file and restart, or use the form for now."
      baseMood="happy" defaultReplies={TEMPLATES} onSend={onSend} onClose={close}
      inputHint="Describe the floor, e.g. “handles invoices and chases late payments”"
      below={<p className="dlg-note dim"><button type="button" className="link" onClick={toForm}>Use the form instead</button></p>}
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
                <span><i>Agents</i>1 chief{d.workers ? ` + ${d.workers} worker${d.workers > 1 ? 's' : ''}` : ', no workers'} · ~{d.creditsPerDay} credits/day <small>estimate</small></span>
              </span>
              {d.dropped.length > 0 && <span className="nd-dropped">Left out: {d.dropped.join('; ')}.</span>}
              {!hermesUp && <span className="nd-dropped">Hermes is not reachable: the floor will be added unconfigured. Provision it later.</span>}
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
