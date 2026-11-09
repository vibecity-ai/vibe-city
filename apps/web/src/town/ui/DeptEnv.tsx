/* The Env tab (the key cabinet on every floor): the floor's own env variables, such as an API key a skill needs.
   Values are write-only: they go to the server and into every agent profile's .env, and are never shown again. */
import { useEffect, useState } from 'react';
import type { DepartmentEnv } from '@vibe-city/shared';
import { envNameProblem } from '../data/views.ts';
import type { Dept } from '../data/types';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { formatTime } from './format.ts';
import { Icon } from './kit';

export function DeptEnvTab({ d }: { d: Dept }) {
  const [env, setEnv] = useState<DepartmentEnv | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const toast = useStore((s) => s.toast);
  useEffect(() => { api.deptEnv(d.id).then(setEnv).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not read the variables.')); }, [d.id]);

  const act = async (key: string, fn: () => Promise<DepartmentEnv>, done: string) => {
    setBusy(key); setErr(null);
    try {
      const out = await fn();
      setEnv(out);
      toast(out.warning ?? done, out.warning ? 'warn' : 'good');
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not work.');
      return false;
    } finally { setBusy(null); }
  };
  const problem = envNameProblem(name);
  const taken = !!env?.vars.some((v) => v.name === name);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || problem || taken || !value || busy) return;
    if (await act('add', () => api.setDeptEnv(d.id, name, value), `${name} is on every agent of ${d.name}.`)) { setName(''); setValue(''); }
  };

  return (
    <section className="pane-sec env-tab" aria-busy={!!busy}>
      <h3 className="sec-t">Env variables</h3>
      <p className="fine">Keys and settings the floor’s skills and tools read, like <code>SERPAPI_API_KEY</code>. Each goes into every agent’s Hermes profile (its .env) and stays on the server: a value is never shown again, only replaced.</p>
      {err && <p className="field-err" role="alert">{err}</p>}
      {!env && !err && <p className="muted small" role="status">Reading the variables…</p>}
      {env && (
        <ul className="env-list" aria-label="Variables">
          {env.vars.length === 0 && <li className="muted small">None yet.</li>}
          {env.vars.map((v) => (
            <li key={v.name} className="env-row">
              <span className="env-n"><b className="mono">{v.name}</b>
                <small className="muted">{v.onAgents ? <><Icon n="check" size={11} /> On every agent</> : 'Waiting for the next sync'} · set {formatTime(v.updatedAt)}</small></span>
              {replacing === v.name ? (
                <form className="env-replace" onSubmit={async (e) => { e.preventDefault(); if (draft && await act(v.name, () => api.setDeptEnv(d.id, v.name, draft), `${v.name} replaced.`)) { setReplacing(null); setDraft(''); } }}>
                  <input className="input mono" type="password" autoComplete="off" spellCheck={false} aria-label={`New value for ${v.name}`} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
                  <button className="btn small primary" type="submit" disabled={!draft || !!busy}>Save</button>
                  <button className="btn small" type="button" onClick={() => { setReplacing(null); setDraft(''); }}>Cancel</button>
                </form>
              ) : (
                <span className="env-act">
                  <button className="btn small" disabled={!!busy} onClick={() => { setReplacing(v.name); setDraft(''); }}>Replace</button>
                  <button className="btn small tertiary" disabled={!!busy} aria-busy={busy === v.name || undefined}
                    onClick={() => void act(v.name, () => api.removeDeptEnv(d.id, v.name), `${v.name} removed from every agent.`)}>Remove</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <form className="env-add" onSubmit={add}>
        <h4 className="sk-sub">Add a variable</h4>
        <div className="env-fields">
          <input className="input mono" aria-label="Name" placeholder="NAME" autoComplete="off" spellCheck={false} maxLength={64}
            value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} aria-invalid={!!problem || taken || undefined} />
          <input className="input mono" aria-label="Value" placeholder="value" type="password" autoComplete="off" spellCheck={false} maxLength={4096}
            value={value} onChange={(e) => setValue(e.target.value)} />
          <button className="btn primary small" type="submit" disabled={!name || !!problem || taken || !value || !!busy}>{busy === 'add' ? 'Saving…' : 'Add'}</button>
        </div>
        {(problem || taken) && <small className="field-err">{problem ?? `${name} is already set: use Replace.`}</small>}
        <small className="muted">Tasks started after a save read the new value. A floor that is not synced yet gets it at its first sync.</small>
      </form>
    </section>
  );
}
