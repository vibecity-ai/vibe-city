/* Schedules (feature spec 8): recurring quests the Vibe City backend creates on a floor's board. Listed behind the
   calendar in the Executive Office (every floor) and from a floor's panel (that floor). Presets cover the usual
   rhythms; a custom 5-field cron is there for the rest. */
import { useEffect, useState } from 'react';
import type { Schedule } from '@vibe-city/shared';
import { useStore, floorNum } from '../store';
import { api, ApiError } from '../../api';
import { PixelSelect, Glyph, Icon } from './kit';

export const PRESETS = [
  { label: 'Every weekday at 9:00', cron: '0 9 * * 1-5' },
  { label: 'Every day at 18:00', cron: '0 18 * * *' },
  { label: 'Every Monday at 8:30', cron: '30 8 * * 1' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'First day of the month at 9:00', cron: '0 9 1 * *' },
];
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Plain words for the common shapes; the cron itself otherwise. */
export function describeCron(cron: string): string {
  const p = PRESETS.find((x) => x.cron === cron); if (p) return p.label;
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const names: Record<string, string> = { sun: '0', mon: '1', tue: '2', wed: '3', thu: '4', fri: '5', sat: '6', 'mon-fri': '1-5' };
  const [m, h, dom, mon, dow0] = f as [string, string, string, string, string];
  const dow = names[dow0.toLowerCase()] ?? dow0;
  const at = /^\d+$/.test(m) && /^\d+$/.test(h) ? `at ${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (at && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day ${at}`;
    if (dow === '1-5') return `Every weekday ${at}`;
    if (/^[0-6]$/.test(dow)) return `Every ${DOW[Number(dow)]} ${at}`;
  }
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  return `Cron ${cron}`;
}

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso), ms = d.getTime() - Date.now(), m = Math.round(Math.abs(ms) / 60_000);
  const rel = m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  return `${d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${ms >= 0 ? 'in ' + rel : rel + ' ago'})`;
};

/** Keeps the last list on failure and says why, so an empty list is never shown as "no schedules". */
export async function loadSchedules(): Promise<string | null> {
  try { useStore.setState({ schedules: await api.schedules() }); return null; } catch (e) { return e instanceof ApiError ? e.message : 'The schedules could not be loaded.'; }
}

export function SchedulesView({ deptId }: { deptId: string | null }) {
  const depts = useStore((s) => s.depts);
  const all = useStore((s) => s.schedules);
  const list = deptId ? all.filter((x) => x.departmentId === deptId) : all;
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => { void loadSchedules().then(setLoadErr); }, []);
  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await fn(); await loadSchedules(); } catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong.'); } finally { setBusy(null); }
  };
  const name = (id: string) => depts.find((d) => d.id === id)?.name ?? 'archived floor';
  return (
    <div className="sched">
      <p className="fine">Vibe City creates these jobs on the floor's board at the set time, like you would. Agents cannot schedule work themselves (Hermes cron jobs stay off).</p>
      {error && <p className="field-err" role="alert">{error}</p>}
      {loadErr && <p className="field-err" role="alert">{loadErr}</p>}
      {list.length === 0 && !adding && !loadErr && <p className="muted">No schedules yet{deptId ? ` for ${name(deptId)}` : ''}.</p>}
      <ul className="sched-list">
        {list.map((x: Schedule) => (
          <li key={x.id} className={`sched-row${x.enabled ? '' : ' off'}`}>
            <div className="sched-main">
              <b>{x.name}</b>
              <span className="sched-when">{!deptId && <><span className="fkey cyan">F{floorNum(depts, x.departmentId)}</span> {name(x.departmentId)} · </>}{describeCron(x.cron)} <span className="muted">· {x.timezone}</span></span>
              <span className="sched-meta">{x.enabled ? <>Next: {when(x.nextRunAt)}</> : <span className="muted">Paused</span>}{x.lastRunAt && <> · Last: {when(x.lastRunAt)} {x.lastError ? <span className="bad"><Glyph k="failed" /> {x.lastError}</span> : x.lastQuestId ? <Glyph k="completed" /> : null}</>}</span>
            </div>
            <div className="sched-act">
              <button className="btn small" disabled={busy === x.id} onClick={() => void act(x.id, () => api.runSchedule(x.id))}>Run now</button>
              <button className="btn small" disabled={busy === x.id} onClick={() => void act(x.id, () => api.patchSchedule(x.id, { enabled: !x.enabled }))}>{x.enabled ? 'Pause' : 'Resume'}</button>
              <button className="dlg-icon" disabled={busy === x.id} aria-label={`Delete schedule ${x.name}`} title="Delete" onClick={() => void act(x.id, () => api.deleteSchedule(x.id))}><Icon n="x" size={12} /></button>
            </div>
          </li>
        ))}
      </ul>
      {adding ? <ScheduleForm deptId={deptId} onDone={() => { setAdding(false); void loadSchedules(); }} /> : <button className="btn primary small" onClick={() => setAdding(true)} disabled={depts.length === 0}><Icon n="plus" sw={3} />New schedule</button>}
    </div>
  );
}

function ScheduleForm({ deptId, onDone }: { deptId: string | null; onDone: () => void }) {
  const depts = useStore((s) => s.depts);
  const tzLocal = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const [dept, setDept] = useState(deptId ?? depts.find((d) => d.provisioning === 'ready')?.id ?? '');
  const [preset, setPreset] = useState(PRESETS[0]!.cron);
  const [custom, setCustom] = useState('0 9 * * 1-5');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cron = preset === 'custom' ? custom.trim() : preset;
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); if (!dept || !title.trim() || !objective.trim()) return;
    setBusy(true); setError(null);
    try { await api.createSchedule(dept, { name: title.trim().slice(0, 80), cron, timezone: tzLocal, title: title.trim(), objective: objective.trim() }); onDone(); }
    catch (er) { setError(er instanceof ApiError ? er.message : 'Could not save the schedule.'); }
    finally { setBusy(false); }
  };
  return (
    <form className="sched-form" onSubmit={save}>
      {!deptId && <label className="field"><span className="lbl">Floor</span><PixelSelect value={dept} onChange={setDept} options={depts.map((d) => ({ value: d.id, label: `F${floorNum(depts, d.id)} · ${d.name}`, disabled: d.provisioning !== 'ready', ...(d.provisioning !== 'ready' ? { note: 'not ready' } : {}) }))} /></label>}
      <label className="field"><span className="lbl">When</span><PixelSelect value={preset} onChange={setPreset} options={[...PRESETS.map((p) => ({ value: p.cron, label: p.label })), { value: 'custom', label: 'Custom (cron)…' }]} /></label>
      {preset === 'custom' && <label className="field"><span className="lbl">Cron: minute hour day month weekday</span><input className="input mono" value={custom} onChange={(e) => setCustom(e.target.value)} /></label>}
      <label className="field"><span className="lbl">Job title</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Morning digest" /></label>
      <label className="field"><span className="lbl">Objective</span><textarea className="input" rows={2} maxLength={8000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="What the floor should deliver each time" /></label>
      <p className="fine">Times are in your time zone ({tzLocal}). {describeCron(cron)}.</p>
      {error && <p className="field-err" role="alert">{error}</p>}
      <div className="row"><button className="btn primary small" type="submit" disabled={busy || !dept || !title.trim() || !objective.trim()}>{busy ? 'Saving…' : 'Save schedule'}</button><button type="button" className="btn small" onClick={onDone} disabled={busy}>Cancel</button></div>
    </form>
  );
}
