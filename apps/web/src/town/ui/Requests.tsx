/* Quests between departments (feature spec 2.4), browser side. Polls the requests and quest origins, flies a gold
   packet between floors when a chief hands work to another department, lists requests that wait for the CEO's
   approval, and edits a floor's policy (who may give it work, and its own daily cap). */
import { useEffect, useState } from 'react';
import type { QuestPolicy, QuestRequestView } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { refreshOne } from '../data/live';
import { Glyph } from './kit';

const POLL_MS = 8_000;
const seenRuns = new Map<string, string | null>();

async function load(first: boolean) {
  const [requests, origins, schedules] = await Promise.all([api.questRequests(), api.questOrigins(), api.schedules()]);
  const s = useStore.getState();
  // A schedule fired since the last look: the floor holds a stand-up and the quest is announced. Tracked here (not via
  // the store) because the schedules screen also reloads the list into the store.
  for (const x of schedules) {
    const seen = seenRuns.get(x.id);
    seenRuns.set(x.id, x.lastRunAt);
    if (first || seen === undefined && !x.lastRunAt) continue;
    if (x.lastRunAt && x.lastRunAt !== seen && x.lastQuestId && !x.lastError) {
      s.emit({ k: 'standup', dept: x.departmentId });
      s.toast(`Schedule “${x.name}” put a quest on the board.`);
      void refreshOne(x.departmentId);
    }
  }
  const seen = new Set(s.requests.map((r) => `${r.id}:${r.state}`));
  if (!first) {
    for (const r of requests) {
      if (seen.has(`${r.id}:${r.state}`)) continue;
      if (r.state === 'created' && r.toDepartmentId) {
        s.emit({ k: 'questRequest', dept: r.toDepartmentId, from: r.fromDepartmentId });
        s.toast(`${r.fromName} asked ${r.toName}: “${r.title}”`);
        void refreshOne(r.toDepartmentId);
      } else if (r.state === 'pending_approval') s.toast(`${r.fromName} wants ${r.toName} to do “${r.title}”. It needs your OK (Executive office).`, 'warn');
    }
  }
  useStore.setState({ schedules, requests, origins: Object.fromEntries(origins.map((o) => [o.questId, o])) });
}

export function RequestsPoll() {
  useEffect(() => {
    let live = true, first = true;
    const tick = () => load(first).then(() => { first = false; }).catch(() => undefined);
    void tick();
    const id = window.setInterval(() => { if (live) void tick(); }, POLL_MS);
    return () => { live = false; window.clearInterval(id); };
  }, []);
  return null;
}

/** Executive Office: requests over a department's daily cap wait here for the CEO. */
export function PendingRequests() {
  const requests = useStore((s) => s.requests);
  const pending = requests.filter((r) => r.state === 'pending_approval');
  const [busy, setBusy] = useState<string | null>(null);
  if (!pending.length) return null;
  const act = async (r: QuestRequestView, ok: boolean) => {
    setBusy(r.id);
    try { await (ok ? api.approveRequest(r.id) : api.rejectRequest(r.id)); await load(true); if (ok && r.toDepartmentId) { useStore.getState().emit({ k: 'questRequest', dept: r.toDepartmentId, from: r.fromDepartmentId }); void refreshOne(r.toDepartmentId); } }
    catch (e) { useStore.getState().toast(e instanceof ApiError ? e.message : 'Could not update the request.', 'bad'); }
    finally { setBusy(null); }
  };
  return (
    <section className="pane-sec">
      <h3 className="sec-t">Needs your OK <span className="count">{pending.length}</span></h3>
      <ul className="stack req-list">
        {pending.map((r) => (
          <li key={r.id} className="req">
            <div className="req-h"><Glyph k="awaiting" /><b>{r.title}</b></div>
            <p className="req-route">{r.fromName} → {r.toName}{r.reason ? ` · “${r.reason}”` : ''}</p>
            <p className="fine">{r.note}</p>
            <div className="row">
              <button className="btn primary small" disabled={busy === r.id} onClick={() => void act(r, true)}>Approve</button>
              <button className="btn small" disabled={busy === r.id} onClick={() => void act(r, false)}>Decline</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Settings: who may give this floor work, and how many quests its own chief may request per day. */
export function QuestPolicyEditor({ deptId }: { deptId: string }) {
  const allDepts = useStore((s) => s.depts);
  const depts = allDepts.filter((d) => d.id !== deptId);
  const [p, setP] = useState<QuestPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.questPolicy(deptId).then(setP).catch((e: ApiError) => setError(e.message)); }, [deptId]);
  const save = async (patch: Partial<QuestPolicy>) => {
    setSaving(true); setError(null);
    try { setP(await api.setQuestPolicy(deptId, patch)); } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save.'); }
    finally { setSaving(false); }
  };
  if (!p) return error ? <p className="field-err">{error}</p> : <p className="muted" aria-busy="true">Loading…</p>;
  const all = p.allowFrom === '*';
  const allowed = all ? depts.map((d) => d.id) : (p.allowFrom as string[]);
  return (
    <div className="policy" aria-busy={saving}>
      <p className="fine">Agents can hand work to other floors with the Vibe City tool <span className="mono">request_quest</span>. Each request becomes a quest on the other floor’s board.</p>
      <div className="field">
        <span className="lbl">Who can give this floor work</span>
        <div className="seg-row" role="group" aria-label="Who can give this floor work">
          <button aria-pressed={all} className={all ? 'on' : ''} disabled={saving} onClick={() => void save({ allowFrom: '*' })}>Every floor</button>
          <button aria-pressed={!all} className={!all ? 'on' : ''} disabled={saving} onClick={() => void save({ allowFrom: allowed })}>Only these</button>
        </div>
        {!all && (
          <div className="chips-toggle">
            {depts.length === 0 && <span className="muted">No other floors yet.</span>}
            {depts.map((d) => {
              const on = allowed.includes(d.id);
              return <button key={d.id} aria-pressed={on} className={`chip-t${on ? ' on' : ''}`} disabled={saving} onClick={() => void save({ allowFrom: on ? allowed.filter((x) => x !== d.id) : [...allowed, d.id] })}>{on ? '✓ ' : ''}{d.name}</button>;
            })}
          </div>
        )}
      </div>
      <label className="field">
        <span className="lbl">Quests this floor’s agents may request per day without your OK</span>
        <input className="input policy-cap" type="number" min={0} max={100} value={p.dailyCap} disabled={saving}
          onChange={(e) => setP({ ...p, dailyCap: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
          onBlur={(e) => void save({ dailyCap: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
      </label>
      {error && <p className="field-err" role="alert">{error}</p>}
    </div>
  );
}
