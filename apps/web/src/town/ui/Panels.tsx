import { useEffect, useRef, useState } from 'react';
import { PROVISIONING_STEPS, TOOLSETS, type CapabilityEntry, type QuestStatus } from '@vibe-city/shared';
import { floorNum, useStore, type QuestItem } from '../store';
import type { Dept } from '../data/types';
import { cancelQuest, createDepartment, createQuest, loadDeptInfo, loadQuest, patchInventory, provisionDepartment, reconcileNow, refreshAll } from '../data/live';
import { clock } from '../data/derive';
import { STATUS, canCancel, formatBytes, formatTime, planningNote, requestIdFor, treeRows } from '../../board/format.ts';
import { Btn, Chip, FloorKey, Glyph, Icon, Portrait, Where, deptStatus, questStatus, statusColor, type StatusKey } from './kit';

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/* ============ top bar ============ */
export function TopBar() {
  const company = useStore((s) => s.company);
  const conn = useStore((s) => s.conn);
  const stale = useStore((s) => s.stale);
  const busy = useStore((s) => s.busy);
  const [open, setOpen] = useState(false);
  const pill = (ok: boolean, label: string) => (
    <span className={`led${ok ? '' : ' bad'}`} title={ok ? `${label} connected` : `${label} not responding`}><i aria-hidden="true" />{label}<span className="sr">{ok ? ' connected' : ' not responding'}</span></span>
  );
  return (
    <header className="top">
      <div className="logo"><span className="wordmark" data-t="VIBE CITY">VIBE CITY</span><span className="tag-line">Build your AI empire</span></div>
      <span className="plate" title="Your company">{company?.name ?? '…'}</span>
      <span className="grow" />
      {stale && <span className="demo" title="The last refresh failed; floors show the last data received"><span>Out of date</span></span>}
      <div className="conn">{pill(conn.backend, 'Backend')}{pill(conn.hermes, 'Hermes')}{pill(conn.gateway, 'Gateway')}</div>
      <div className="menu-wrap">
        <button className="btn tertiary sq" aria-label="Settings" aria-expanded={open} onClick={() => setOpen(!open)}><Icon n="sliders" /></button>
        {open && (
          <div className="menu card" role="menu">
            <button className="menu-i" disabled={!!busy.reconcile} onClick={() => { setOpen(false); void reconcileNow(); }}>Reconcile with Hermes now</button>
            <button className="menu-i" onClick={() => { setOpen(false); void refreshAll(); }}>Refresh</button>
            <a className="menu-i" href="#board" role="menuitem">Classic quest board</a>
          </div>
        )}
      </div>
    </header>
  );
}

/* ============ A · executive office ============ */
export function ExecPanel() {
  const { company, depts, ui$, openFloor, loaded } = useStore();
  const running = depts.reduce((n, d) => n + d.workers.filter((w) => w.status === 'running').length + (d.chief?.status === 'running' ? 1 : 0), 0);
  const attention = depts.filter((d) => d.state === 'attention' || d.state === 'offline');
  const unconf = depts.filter((d) => d.state === 'unconfigured');
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <Where n="PH" tone="gold">Executive office</Where>
          <h1 className="display">{company?.name ?? 'Your company'}</h1>
          <p className="sub">{loaded ? 'Everything below is read from Hermes through the Vibe City backend.' : 'Connecting to the backend…'}</p>
        </section>
        <section className="pane-sec">
          <h3 className="sec-t">Company status</h3>
          <div className="tiles">
            <div className="tile" style={{ ['--bar' as string]: '#9B5CFF' }}><b>{depts.length}</b><span>Departments</span></div>
            <div className="tile" style={{ ['--bar' as string]: '#2EE6F0' }}><b>{running}<Glyph k="running" size={12} /></b><span>Agents running</span></div>
            <div className="tile" style={{ ['--bar' as string]: '#FF5C7A' }}><b>{attention.length}<Glyph k="failed" size={12} /></b><span>Need attention</span></div>
            <div className="tile" style={{ ['--bar' as string]: '#FFB547' }}><b>{unconf.length}<Glyph k="awaiting" size={12} /></b><span>Not provisioned</span></div>
          </div>
        </section>
        <section className="pane-sec">
          <h3 className="sec-t">Needs attention</h3>
          {[...attention, ...unconf].length === 0 && <p className="muted">Nothing needs you right now.</p>}
          <div className="stack">
            {[...attention, ...unconf].map((d) => {
              const st = deptStatus(d.state);
              return (
                <button key={d.id} className={`attn ${d.state}`} onClick={() => openFloor(d.id)}>
                  <Glyph k={st.k} size={11} />
                  <span className="attn-t"><b>{d.name}</b><small>{d.attention ?? st.label}</small></span>
                  {d.state === 'unconfigured' ? <span className="btn warn small">Set up</span> : <Icon n="chev" />}
                </button>
              );
            })}
          </div>
        </section>
        <section className="pane-sec">
          <h3 className="sec-t">Departments</h3>
          {loaded && depts.length === 0 && <p className="muted">No departments yet. Add one to build the first floor.</p>}
          <div className="rows">
            {depts.map((d) => {
              const st = deptStatus(d.state);
              return (
                <button key={d.id} className="drow" onClick={() => openFloor(d.id)}>
                  <FloorKey n={'F' + floorNum(depts, d.id)} tone={d.state === 'unconfigured' ? 'amber' : d.state === 'offline' ? 'dim' : 'cyan'} /><b>{d.name}</b>
                  <span className="drow-st" style={{ color: statusColor(st.k) }}><Glyph k={st.k} />{st.label}</span><Icon n="chev" size={14} />
                </button>
              );
            })}
          </div>
        </section>
      </div>
      <div className="pane-foot"><button className="btn primary block lg" onClick={() => ui$({ modal: 'create' })}><Icon n="plus" sw={3} />Add department</button></div>
    </div>
  );
}

/* ============ D · department ============ */
export function DeptPanel() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  if (!d) return <ExecPanel />;
  if (!d.chief) return <SetupPanel d={d} />;
  const st = deptStatus(d.state);
  const quests = s.quests.filter((q) => q.deptId === d.id);
  const active = quests.filter((q) => ACTIVE.has(q.summary.status));
  const log = s.log.filter((l) => l.dept === d.id).slice(0, 8);
  const tab = s.ui.deptTab;
  const sel = s.ui.agent;
  const canWork = s.conn.hermes && s.conn.gateway && d.provisioning === 'ready';
  const running = d.workers.filter((w) => w.status === 'running').length;
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>Department</Where><button className="x" onClick={s.closeFloor} aria-label="Close"><Icon n="x" /></button></div>
          <div className="title-row"><h1 className="display">{d.name}</h1><Chip k={st.k} label={st.label} /></div>
          <p className="sub">{d.purpose}</p>
          <div className="actions">
            <button className="btn primary" disabled={!canWork} title={canWork ? '' : 'Needs a provisioned department and a running Hermes gateway'} onClick={() => s.openPanel('board', { composer: true, boardFilter: 'all' })}><Icon n="plus" sw={3} />New quest</button>
            <Btn kind="secondary" onClick={() => s.openPanel('inventory')}>Open inventory</Btn>
            <Btn kind="secondary" onClick={() => s.openPanel('board', { composer: false })}>Quest board</Btn>
          </div>
          <div className="tabs" role="tablist">
            {(['overview', 'inventory', 'quests'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => s.ui$({ deptTab: t })}>
                {t[0]!.toUpperCase() + t.slice(1)}{t === 'quests' && <span className="count">{active.length}</span>}
              </button>
            ))}
          </div>
        </section>
        {d.state === 'offline' && (
          <div className="banner bad"><Glyph k="disconnected" /><div><b>Hermes resources not verified</b><p>{d.attention}. Agents can’t receive new work until this floor is verified again.</p>
            <Btn kind="destructive" disabled={!!s.busy[`provision:${d.id}`]} onClick={() => void provisionDepartment(d.id, {}, true)}>{s.busy[`provision:${d.id}`] ? 'Retrying…' : 'Retry connection'}</Btn></div></div>
        )}
        {d.state === 'attention' && d.attention && <div className="banner bad"><Glyph k="failed" /><div><b>Needs attention</b><p>{d.attention}</p></div></div>}
        {d.provisioning === 'unconfigured' && <div className="banner warn"><Glyph k="awaiting" /><div><b>Changes not applied</b><p>This department was edited after it was provisioned. Provision again to apply them in Hermes.</p>
          <Btn kind="secondary" disabled={!!s.busy[`provision:${d.id}`]} onClick={() => void provisionDepartment(d.id)}>{s.busy[`provision:${d.id}`] ? 'Provisioning…' : 'Provision again'}</Btn></div></div>}
        {tab === 'overview' && (
          <>
            <section className="pane-sec">
              <h3 className="sec-t">Chain of command</h3>
              <div className={`chief-card${sel === 'chief' ? ' sel' : ''}`} onClick={() => s.ui$({ agent: 'chief' })}>
                <div className="chief-top">
                  <Portrait shirt="#fff" chief size={44} />
                  <div>
                    <div className="chief-badges"><span className="role">Chief</span><Chip k={d.chief.status} small /></div>
                    <div className="chief-name">{d.chief.name}</div>
                    <div className="mono muted small">profile · {d.chief.profile || '—'}{d.chief.model && <><br />model · {d.chief.model}</>}</div>
                  </div>
                </div>
                <div className="chief-act"><span>{d.chief.activity}</span><span className="mono muted">since {d.chief.since}</span></div>
              </div>
              <div className="tree">
                {d.workers.map((w) => (
                  <button key={w.taskId} className={`wrow${sel === w.id ? ' sel' : ''}`} onClick={() => s.ui$({ agent: w.id })}>
                    <Portrait shirt={w.shirt} size={28} />
                    <span className="wrow-t"><span><span className="mono muted">{w.id}</span> <b>{w.task}</b></span>
                      <small style={{ color: statusColor(w.status) }}><Glyph k={w.status} />{WORKER_WORD[w.status]} <span className="muted">· {w.status === 'completed' ? 'done' : 'since'} {w.since}</span></small>
                    </span>
                  </button>
                ))}
                {d.workers.length === 0 && <div className="empty-w">No worker tasks yet. Workers appear when the chief delegates a quest.</div>}
              </div>
              <p className="mono muted small">{running} worker task{running === 1 ? '' : 's'} running · requested limit {d.maxWorkers} (not enforced per department)</p>
            </section>
            <section className="pane-sec">
              <h3 className="sec-t">Active quests</h3>
              {active.length === 0 && <p className="muted">No active quests. Give the chief an objective.</p>}
              <div className="stack">{active.map((q) => <QuestMini key={q.summary.id} q={q} />)}</div>
            </section>
            <section className="pane-sec">
              <h3 className="sec-t">Live activity</h3>
              {log.length === 0 && <p className="muted small">Events from Hermes appear here as they happen.</p>}
              <ol className="feed">{log.map((l, i) => <li key={i}><span className="mono muted">{l.t}</span><Glyph k={(l.kind === 'chief' ? 'awaiting' : l.kind) as StatusKey} /><span>{l.text}</span></li>)}</ol>
            </section>
          </>
        )}
        {tab === 'inventory' && <InventorySummary d={d} />}
        {tab === 'quests' && (
          <section className="pane-sec">
            <div className="stack">{quests.map((q) => <QuestMini key={q.summary.id} q={q} />)}{quests.length === 0 && <p className="muted">No quests yet.</p>}</div>
          </section>
        )}
      </div>
    </div>
  );
}

const ACTIVE = new Set<QuestStatus>(['queued', 'planning', 'running', 'awaiting_input', 'in_review', 'failed', 'cancelling']);
const WORKER_WORD = { running: 'Running', idle: 'Waiting', completed: 'Completed', failed: 'Failed', disconnected: 'Disconnected', awaiting: 'Waiting' } as const;

function QuestMini({ q }: { q: QuestItem }) {
  const openPanel = useStore((s) => s.openPanel);
  const x = q.summary;
  return (
    <button className={`qmini ${x.status}`} onClick={() => openPanel('quest', { questId: x.id })}>
      <span className="qmini-top"><b>{x.title}</b></span>
      <span className="qmini-bot"><Chip k={questStatus(x.status)} label={STATUS[x.status].label} small /><span className="muted small">{x.counts.done}/{x.counts.tasks} tasks done · {clock(x.createdAt)}</span></span>
    </button>
  );
}

function InventorySummary({ d }: { d: Dept }) {
  const openPanel = useStore((s) => s.openPanel);
  const inv = useStore((s) => s.info[d.id]?.inventory);
  const sec = (label: string, items: readonly string[]) => (
    <div className="inv-sum">
      <div className="inv-sum-h"><b>{label}</b><span className="mono muted">{items.length} allowed</span></div>
      <div className="inv-tags">{items.map((i) => <span key={i} className="itag">{i}</span>)}{items.length === 0 && <span className="muted small">None set</span>}</div>
    </div>
  );
  return (
    <section className="pane-sec">
      {!inv && <p className="muted">Loading inventory…</p>}
      {inv && <>{sec('Toolsets', inv.allowedToolsets)}{sec('Skills', inv.allowedSkillIds)}{sec('MCP tools', inv.allowedMcpTools)}{sec('Models', inv.allowedModelIds)}</>}
      <Btn kind="secondary" onClick={() => openPanel('inventory')}>Open full inventory</Btn>
    </section>
  );
}

/* ============ B2 · provisioning ============ */
function SetupPanel({ d }: { d: Dept }) {
  const s = useStore();
  const prov = s.info[d.id]?.provisioning ?? null;
  const inv = s.info[d.id]?.inventory ?? null;
  const [mode, setMode] = useState<'managed' | 'link'>(d.chiefProfileRef && prov?.chief.origin === 'associated' ? 'link' : 'managed');
  const [chief, setChief] = useState(d.chiefProfileRef ?? '');
  const [worker, setWorker] = useState(d.workerProfileRef ?? '');
  const [consent, setConsent] = useState(false);
  const busy = !!s.busy[`provision:${d.id}`];
  const err = prov?.error ?? null;
  const refs = [chief.trim(), worker.trim()].filter(Boolean);
  const valid = mode === 'managed' || (PROFILE_RE.test(chief.trim()) && PROFILE_RE.test(worker.trim()) && chief.trim() !== worker.trim() && consent);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void provisionDepartment(d.id, mode === 'managed'
      ? { chiefProfileRef: null, workerProfileRef: null }
      : { chiefProfileRef: chief.trim(), workerProfileRef: worker.trim(), confirmModifyProfiles: refs });
  };
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)} tone="amber">{d.provisioning === 'error' ? 'Provisioning failed' : 'New department'}</Where><button className="x" onClick={s.closeFloor} aria-label="Close"><Icon n="x" /></button></div>
          <div className="title-row"><h1 className="display">{d.name}</h1><Chip k={d.state === 'attention' ? 'failed' : 'awaiting'} label={d.provisioning === 'provisioning' ? 'Provisioning' : d.state === 'attention' ? 'Needs attention' : 'Not provisioned'} /></div>
          <p className="sub">{d.purpose}</p>
        </section>
        {err && (
          <div className="banner bad"><Glyph k="failed" /><div><b>Step “{err.step}” failed</b><p>{err.message}</p>
            <p className="fine">{err.retryable ? 'This can be retried.' : 'Something must change before retrying.'}</p></div></div>
        )}
        <section className="pane-sec">
          <h3 className="sec-t">Get this floor running</h3>
          <div className="step done"><Glyph k="completed" size={12} /><b>Name & objective</b><span className="muted small">Saved</span></div>
          <div className="step done"><Glyph k="completed" size={12} /><span><b>Inventory</b><small className="muted">{inv ? `${inv.allowedToolsets.length} toolsets · ${inv.allowedSkillIds.length} skills · ${inv.allowedModelIds.length} models` : 'Loading…'}</small></span><button className="link" onClick={() => s.openPanel('inventory')}>Edit</button></div>
          <form className="step open" onSubmit={submit}>
            <div className="step-h"><span className="num">3</span><b>Create the Hermes resources</b></div>
            <p className="fine">Provisioning creates a Kanban board and two Hermes profiles (a chief and a worker), applies the inventory and verifies it by reading it back. It can take a minute.</p>
            <label className={`radio${mode === 'managed' ? ' on' : ''}`}><input type="radio" name="m" checked={mode === 'managed'} onChange={() => setMode('managed')} />Create managed profiles (recommended)</label>
            <label className={`radio${mode === 'link' ? ' on' : ''}`}><input type="radio" name="m" checked={mode === 'link'} onChange={() => setMode('link')} />Use existing Hermes profiles</label>
            {mode === 'link' && (
              <>
                <label className="lbl" htmlFor="pc">Chief profile</label>
                <input id="pc" className="input mono" value={chief} onChange={(e) => setChief(e.target.value)} placeholder="existing-profile-name" />
                <label className="lbl" htmlFor="pw">Worker profile</label>
                <input id="pw" className="input mono" value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="existing-profile-name" />
                <label className="consent">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>Allow Vibe City to modify <b className="mono">{chief.trim() || 'the chief profile'}</b> and <b className="mono">{worker.trim() || 'the worker profile'}</b>: toolsets, skills, default model and a block in SOUL.md. This also changes how they behave <b>outside</b> Vibe City.</span>
                </label>
              </>
            )}
            <button className="btn primary lg" type="submit" disabled={busy || !s.conn.hermes || !valid}>{busy ? 'Provisioning…' : err ? (err.retryable ? 'Retry provisioning' : 'Provision again') : 'Provision department'}</button>
            {!s.conn.hermes && <small className="muted">Hermes is not reachable. Start the dashboard and gateway first.</small>}
            {busy && <div className="steps-list" aria-live="polite">{PROVISIONING_STEPS.map((x) => <span key={x} className="mono muted">{x}</span>)}</div>}
          </form>
        </section>
      </div>
    </div>
  );
}

/* ============ C · inventory ============ */
function ListEditor({ label, hint, values, onSave, disabled }: { label: string; hint: string; values: readonly string[]; onSave: (v: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (v && !values.includes(v)) onSave([...values, v]); setDraft(''); };
  return (
    <div className="kv-card" style={{ display: 'block' }}>
      <b>{label}</b> <span className="muted small">{hint}</span>
      <div className="chips">{values.map((v) => <span key={v} className="itag mono">{v}<button aria-label={`Remove ${v}`} disabled={disabled} onClick={() => onSave(values.filter((x) => x !== v))}>×</button></span>)}{values.length === 0 && <span className="muted small">None</span>}</div>
      <div className="inline"><input className="input mono" value={draft} placeholder={`Add ${label.toLowerCase()}`} aria-label={`Add ${label}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /><Btn onClick={add} disabled={disabled || !draft.trim()}>Add</Btn></div>
    </div>
  );
}

const CAP_GROUPS = [
  ['enforced', 'Enforced', 'Applied, read back from Hermes, and tested to hold at runtime on one Hermes version.'],
  ['configured', 'Configured, not tested', 'Set in Hermes and read back. Runtime behavior has not been tested.'],
  ['unverified', 'Unverified', 'Could not be applied or read back in this installation.'],
  ['unsupported', 'Not supported by Hermes', 'Hermes has no interface to enforce this. It is a request, not a control.'],
] as const;

function CapabilityReport({ entries }: { entries: { role: string; e: CapabilityEntry }[] }) {
  return (
    <>
      {CAP_GROUPS.map(([status, title, blurb]) => {
        const list = entries.filter((x) => x.e.status === status);
        if (!list.length) return null;
        return (
          <div key={status} className="capgroup">
            <h4>{status === 'enforced' && <Icon n="lock" size={12} />} {title} <span className="count">{list.length}</span></h4>
            <p className="fine">{blurb}</p>
            {list.map((x, i) => <div key={i} className="cap"><b>{x.e.capability}</b> <span className="muted small">· {x.role}</span><small>{x.e.detail}</small></div>)}
          </div>
        );
      })}
    </>
  );
}

export function InventorySheet() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  const id = d?.id;
  useEffect(() => { if (id) void loadDeptInfo(id); }, [id, d?.provisioning]);
  if (!d) return null;
  const info = s.info[d.id];
  const inv = info?.inventory ?? null;
  const eff = info?.effective ?? null;
  const saving = !!s.busy[`inv:${d.id}`];
  const save = (p: Parameters<typeof patchInventory>[1]) => void patchInventory(d.id, p);
  const entries = eff ? [...eff.chief.entries.map((e) => ({ role: 'chief', e })), ...eff.worker.entries.map((e) => ({ role: 'worker', e })), ...eff.departmentWide.map((e) => ({ role: 'department', e }))] : [];
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>{d.name}</Where><button className="x boxed" onClick={() => s.openPanel('dept')} aria-label="Close"><Icon n="x" /></button></div>
          <h1 className="display">Department inventory</h1>
          <p className="sub">What agents on this floor may use. The chief and workers are narrowed by role, never beyond this allowance. A setting counts as a guarantee only where the report below says <b>Enforced</b>.</p>
        </section>
        {!inv && <p className="muted pane-sec">Loading inventory…</p>}
        {inv && (
          <div className="inv-body"><div className="inv-main">
            {d.provisioning === 'unconfigured' && d.chief === null ? null : eff && !eff.inSync && <div className="banner warn"><Glyph k="awaiting" /><div><b>Not applied in Hermes yet</b><p>Saved changes take effect after you provision again.</p><Btn kind="secondary" disabled={!!s.busy[`provision:${d.id}`]} onClick={() => void provisionDepartment(d.id)}>{s.busy[`provision:${d.id}`] ? 'Provisioning…' : 'Provision again'}</Btn></div></div>}
            <h3 className="inv-h">Toolsets <span>Switched off in Hermes unless allowed</span></h3>
            <div className="slot-grid">
              {TOOLSETS.map((t) => {
                const on = inv.allowedToolsets.includes(t);
                return (
                  <div key={t} className={`slot-card ${on ? '' : 'disabled'}`}>
                    <div className="slot-top"><span className="slot-ic"><Icon n="plug" size={15} /></span>
                      <button className={`toggle${on ? ' on' : ''}`} disabled={saving} aria-label={`${on ? 'Disallow' : 'Allow'} ${t}`} aria-pressed={on}
                        onClick={() => save({ allowedToolsets: on ? inv.allowedToolsets.filter((x) => x !== t) : [...inv.allowedToolsets, t] })}><i /></button></div>
                    <div className="slot-name mono">{t}</div>
                    {t === 'kanban' && <div className="slot-desc">Always on for task reporting.</div>}
                  </div>
                );
              })}
            </div>
            <h3 className="inv-h">Skills, MCP tools and models <span>Allowlists</span></h3>
            <ListEditor label="Skills" hint="Installed skills not listed are disabled." values={inv.allowedSkillIds} disabled={saving} onSave={(v) => save({ allowedSkillIds: v })} />
            <ListEditor label="MCP tools" hint="server:tool. Not applied yet: reported unverified." values={inv.allowedMcpTools} disabled={saving} onSave={(v) => save({ allowedMcpTools: v })} />
            <ListEditor label="Models" hint="Sets the profile default. Hermes cannot restrict which models run." values={inv.allowedModelIds} disabled={saving} onSave={(v) => save({ allowedModelIds: v })} />
            <h3 className="inv-h">Workspace</h3>
            <div className="kv-card"><Icon n="folder" size={14} /><span className="mono">{d.workspace.configured ? d.workspace.label ?? 'configured' : 'Not configured'}</span>
              <span className="muted small">{d.workspace.isolation === 'verified' ? 'Isolation verified.' : 'Advisory: a configured path, not a sandbox. Agents with file tools can reach outside it.'}</span></div>
            <h3 className="inv-h">Limits</h3>
            <div className="kv-card" style={{ display: 'block' }}>
              <label className="lbl" htmlFor="mw">Requested worker limit (1–10)</label>
              <input id="mw" className="input mono" type="number" min={1} max={10} defaultValue={inv.limits.maxConcurrentWorkers} key={inv.limits.maxConcurrentWorkers} disabled={saving}
                onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 10 && n !== inv.limits.maxConcurrentWorkers) save({ limits: { maxConcurrentWorkers: n } }); }} />
              <small className="muted">A request. Hermes only has a host-wide cap, so this is not guaranteed per department.</small>
              <label className="lbl" htmlFor="mr">Max seconds per quest task (blank = none)</label>
              <input id="mr" className="input mono" type="number" min={10} max={86400} defaultValue={inv.limits.maxTaskRuntimeSeconds ?? ''} key={String(inv.limits.maxTaskRuntimeSeconds)} disabled={saving}
                onBlur={(e) => { const v = e.target.value.trim(); const n = v === '' ? null : Math.round(Number(v)); if ((n === null || (n >= 10 && n <= 86400)) && n !== inv.limits.maxTaskRuntimeSeconds) save({ limits: { maxTaskRuntimeSeconds: n } }); }} />
              <small className="muted">Applies to the quest task only, not to tasks the chief creates.</small>
              <div className="fine" style={{ marginTop: 8 }}>Delegation depth {inv.limits.maxDelegationDepth}: instructed, not enforced.</div>
            </div>
            <h3 className="inv-h">What is actually guaranteed {eff?.observedAt && <span>Read from Hermes {formatTime(eff.observedAt)}</span>}</h3>
            {!eff && <p className="muted">Available once the department has been provisioned.</p>}
            {eff && <CapabilityReport entries={entries} />}
          </div></div>
        )}
      </div>
    </div>
  );
}

/* ============ E · quest board ============ */
const COLUMNS: { key: 'queued' | 'active' | 'attention' | 'finished'; k: StatusKey; title: string; has: (q: QuestStatus) => boolean }[] = [
  { key: 'queued', k: 'todo', title: 'Queued', has: (q) => q === 'queued' },
  { key: 'active', k: 'running', title: 'In progress', has: (q) => q === 'planning' || q === 'running' || q === 'cancelling' },
  { key: 'attention', k: 'blocked', title: 'Needs attention', has: (q) => q === 'awaiting_input' || q === 'in_review' || q === 'failed' },
  { key: 'finished', k: 'completed', title: 'Finished', has: (q) => q === 'completed' || q === 'cancelled' },
];

export function QuestBoard() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  const [title, setTitle] = useState('');
  const [obj, setObj] = useState('');
  const [instr, setInstr] = useState('');
  const reqId = useRef<{ fingerprint: string; id: string } | null>(null);
  if (!d) return null;
  const qs = s.quests.filter((q) => q.deptId === d.id);
  const f = s.ui.boardFilter;
  const count = (key: typeof f) => key === 'all' ? qs.length : qs.filter((q) => COLUMNS.find((c) => c.key === key)!.has(q.summary.status)).length;
  const canWork = s.conn.hermes && s.conn.gateway && d.provisioning === 'ready';
  const busy = !!s.busy[`quest:${d.id}`];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !obj.trim()) return;
    reqId.current = requestIdFor(JSON.stringify([d.id, title.trim(), obj.trim(), instr.trim()]), reqId.current, () => crypto.randomUUID());
    const id = await createQuest(d.id, { clientRequestId: reqId.current.id, title: title.trim(), objective: obj.trim(), ...(instr.trim() && { instructions: instr.trim() }) });
    if (id) { setTitle(''); setObj(''); setInstr(''); reqId.current = null; s.ui$({ composer: false }); }
  };
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row">
            <Where n={'F' + floorNum(s.depts, d.id)}>{d.name}</Where>
            <div className="head-actions"><button className="btn primary lg" disabled={!canWork} title={canWork ? '' : 'Needs a provisioned department and a running Hermes gateway'} onClick={() => s.ui$({ composer: true })}><Icon n="plus" sw={3} />New quest</button><button className="x boxed" onClick={() => s.openPanel('dept')} aria-label="Close"><Icon n="x" /></button></div>
          </div>
          <h1 className="display">Quest board</h1>
          <p className="sync"><Icon n="refresh" size={14} />{s.conn.hermes && !s.stale ? <>Read from Hermes Kanban · board <span className="mono">vc-{d.id.slice(0, 8)}…</span></> : <span style={{ color: '#FF5C7A' }}>Hermes isn’t responding · showing the last data received</span>}</p>
          <div className="filters">
            {(['all', 'active', 'attention', 'finished'] as const).map((k) => <button key={k} className={f === k ? 'on' : ''} onClick={() => s.ui$({ boardFilter: k })}>{{ all: 'All', active: 'Active', attention: 'Attention', finished: 'Finished' }[k]}<span className="count">{count(k)}</span></button>)}
          </div>
        </section>
        <div className="board">
          {COLUMNS.filter((c) => f === 'all' || c.key === f || (f === 'active' && c.key === 'queued')).map((c) => {
            const list = qs.filter((q) => c.has(q.summary.status));
            return (
              <div key={c.key} className="col">
                <div className="col-h" style={{ color: statusColor(c.k), borderColor: statusColor(c.k) }}><Glyph k={c.k} /><b>{c.title}</b><span className="col-n">{list.length}</span></div>
                {c.key === 'queued' && s.ui.composer && (
                  <form className="composer" onSubmit={submit}>
                    <label className="lbl" htmlFor="qt">Quest title</label>
                    <input id="qt" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />
                    <label className="lbl" htmlFor="qo">Objective</label>
                    <textarea id="qo" className="input" rows={3} value={obj} onChange={(e) => setObj(e.target.value)} />
                    <label className="lbl" htmlFor="qi">Extra instructions (optional)</label>
                    <textarea id="qi" className="input" rows={2} value={instr} onChange={(e) => setInstr(e.target.value)} />
                    <small className="muted">Assigned to <b className="gold-n">{d.chief?.name ?? 'the chief'}</b></small>
                    <div className="row"><button className="btn primary grow" type="submit" disabled={busy || !title.trim() || !obj.trim()}>{busy ? 'Creating…' : 'Create quest'}</button><Btn onClick={() => s.ui$({ composer: false })}>Cancel</Btn></div>
                  </form>
                )}
                {list.map((q) => <QuestCard key={q.summary.id} q={q} />)}
                {list.length === 0 && !(c.key === 'queued' && s.ui.composer) && <div className="col-empty">Nothing here</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function QuestCard({ q }: { q: QuestItem }) {
  const openPanel = useStore((s) => s.openPanel);
  const detail = useStore((s) => s.details[q.summary.id]);
  const x = q.summary;
  const workers = detail?.tasks.filter((t) => t.role === 'worker') ?? [];
  return (
    <button className={`qcard ${x.status}`} onClick={() => openPanel('quest', { questId: x.id })}>
      <span className="qcard-h"><b>{x.title}</b></span>
      <Chip k={questStatus(x.status)} label={STATUS[x.status].label} small />
      <span className="qcard-meta">
        <span><i>Tasks</i>{x.counts.tasks ? <>{workers.length > 0 && <span className="pips">{workers.map((t) => <Glyph key={t.id} k={t.failed ? 'failed' : t.status === 'done' ? 'completed' : t.status === 'running' ? 'running' : 'idle'} />)}</span>}{x.counts.done} of {x.counts.tasks} done</> : 'None yet'}</span>
      </span>
      {x.status === 'running' && <span className="note">Stays in progress until every task is done.</span>}
      {x.flags.hasFailures && <span className="err"><Glyph k="failed" />A task failed</span>}
      <span className="mono muted small">created {clock(x.createdAt)}</span>
    </button>
  );
}

/* ============ F · quest details ============ */
export function QuestDetail() {
  const s = useStore();
  const qid = s.ui.questId;
  const item = s.quests.find((x) => x.summary.id === qid);
  const detail = qid ? s.details[qid] : undefined;
  const extra = qid ? s.extra[qid] : undefined;
  const [tab, setTab] = useState<'overview' | 'activity' | 'results'>('overview');
  const deptId = item?.deptId;
  useEffect(() => { if (qid && deptId) void loadQuest(deptId, qid); }, [qid, deptId]);
  if (!item) return null;
  const sum = item.summary;
  const d = s.depts.find((x) => x.id === item.deptId);
  const busy = !!s.busy[`cancel:${sum.id}`];
  const note = detail ? planningNote(detail) : null;
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><button className="link" onClick={() => s.openPanel('board')}><Icon n="back" size={14} />Quest board</button><span className="mono muted">{sum.id}</span></div>
          <div className="title-row"><h1 className="display sm">{sum.title}</h1><Chip k={questStatus(sum.status)} label={STATUS[sum.status].label} /></div>
          <p className="meta"><span className="meta-f"><FloorKey n={'F' + floorNum(s.depts, item.deptId)} />{d?.name}</span><span>Chief <b className="gold-n">{d?.chief?.name ?? '—'}</b></span><span className="mono">{formatTime(sum.createdAt)}{sum.completedAt ? ` → ${formatTime(sum.completedAt)}` : ''}</span></p>
          <p className="fine">{STATUS[sum.status].hint}</p>
          <div className="tabs">{(['overview', 'activity', 'results'] as const).map((t) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}</div>
        </section>
        {extra?.error && <div className="banner bad"><Glyph k="failed" /><div><b>Could not load this quest</b><p>{extra.error}</p><Btn kind="destructive" onClick={() => void loadQuest(item.deptId, sum.id)}>Retry</Btn></div></div>}
        {tab === 'overview' && (
          <section className="pane-sec">
            {!detail && !extra?.error && <p className="muted" aria-busy="true">Loading…</p>}
            {detail && (
              <>
                {note && <p className="note">{note}</p>}
                {detail.warnings.map((w) => <div key={w} className="banner warn"><Glyph k="awaiting" /><div>{w}</div></div>)}
                {detail.violations.length > 0 && <div className="banner bad"><Glyph k="failed" /><div><b>Tasks outside this department</b>{detail.violations.map((v) => <p key={v}>{v}</p>)}<p className="fine">Detected, not prevented: Hermes cannot stop the chief from creating them.</p></div></div>}
                <h3 className="sec-t">Objective</h3><p className="box-p">{detail.objective || 'No objective written.'}</p>
                <h3 className="sec-t">Tasks <span className="count">{detail.counts.done}/{detail.counts.tasks} done</span></h3>
                <div className="stack">{treeRows(detail.tasks).map(({ node, depth }) => {
                  const k: StatusKey = node.failed ? 'failed' : node.status === 'done' ? 'completed' : node.status === 'running' ? 'running' : node.status === 'blocked' || node.status === 'review' ? 'blocked' : node.status === 'archived' ? 'disconnected' : 'todo';
                  return <div key={node.id} className="trow" style={{ paddingLeft: depth * 16 }}><Glyph k={k} /><span className="mono muted">{node.role}</span><b>{node.title}</b><span className="grow" /><span style={{ color: statusColor(k) }}>{node.failed ? 'failed' : node.status}</span></div>;
                })}</div>
                {detail.truncated && <p className="fine">Large quest: only part of the task tree is shown.</p>}
                {detail.cancellation.state !== 'none' && (
                  <p className="note warn">Cancellation {detail.cancellation.state === 'confirmed' ? 'confirmed by Hermes' : `requested; ${detail.cancellation.remaining.length} task(s) still stopping`}.</p>
                )}
                {canCancel(sum.status) && (
                  <Btn kind="destructive" disabled={busy || !s.conn.hermes} onClick={() => { if (confirm('Stop this quest? Unfinished tasks are archived and cannot be restarted. Finished results are kept.')) void cancelQuest(item.deptId, sum.id); }}>{busy ? 'Cancelling…' : sum.status === 'cancelling' ? 'Request again' : 'Cancel quest'}</Btn>
                )}
              </>
            )}
          </section>
        )}
        {tab === 'activity' && (
          <section className="pane-sec">
            {extra?.loading && !extra.activity.length && <p className="muted" aria-busy="true">Loading…</p>}
            {extra && !extra.loading && !extra.activity.length && <p className="muted">No events yet.</p>}
            <ol className="timeline">{[...(extra?.activity ?? [])].reverse().map((e) => <li key={e.id}><span className="mono muted">{clock(e.at)}</span><Glyph k={/fail|block/i.test(e.kind) ? 'failed' : /complet/i.test(e.kind) ? 'completed' : 'running'} /><span><span>{e.label}</span> <small className="muted">{e.taskTitle}</small>{e.detail && <small className="err-t">{e.detail}</small>}</span></li>)}</ol>
            {ACTIVE.has(sum.status) && <p className="muted small live"><Glyph k="running" />Live · refreshes when Hermes reports an event</p>}
          </section>
        )}
        {tab === 'results' && (
          <section className="pane-sec">
            {extra?.loading && !extra.results && <p className="muted" aria-busy="true">Loading…</p>}
            {extra?.results && (
              <>
                {extra.results.chiefSummary ? <><h3 className="sec-t">Summary from the chief</h3><p className="box-p">{extra.results.chiefSummary}</p></> : sum.status !== 'completed' && <div className="empty"><Icon n="file" size={40} sw={1.5} /><b>Nothing final yet</b><p>The chief’s summary and any files appear as tasks finish. The quest is complete only when every task is done.</p></div>}
                {extra.results.tasks.filter((t) => t.summary || t.error || t.attachments.length).map((t) => (
                  <div key={t.taskId} className="stack">
                    <h3 className="sec-t">{t.title} <span className="mono muted small">{t.role}</span></h3>
                    {t.summary && <p className="box-p">{t.summary}</p>}
                    {t.error && <p className="err-t">{t.error}</p>}
                    {t.attachments.map((a) => <div key={a.id} className="file"><span className="file-ic"><Icon n="file" /></span><span className="grow"><b>{a.filename}</b><small className="mono muted">{formatBytes(a.size)}</small></span><a className="btn tertiary" href={a.downloadUrl} download><Icon n="download" size={14} />Download</a></div>)}
                  </div>
                ))}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/* ============ B1 · create department ============ */
export function CreateDeptModal() {
  const s = useStore();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  if (s.ui.modal !== 'create') return null;
  const busy = !!s.busy.create;
  const next = s.depts.length + 1;
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) s.ui$({ modal: null }); }}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="cd-t" onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void createDepartment(name.trim(), purpose.trim()); }} onKeyDown={(e) => { if (e.key === 'Escape') s.ui$({ modal: null }); }}>
        <div className="head-row"><Where n={'F' + next} tone="amber">New floor</Where><button type="button" className="x" onClick={() => s.ui$({ modal: null })} aria-label="Close"><Icon n="x" /></button></div>
        <h2 id="cd-t" className="display">Create a department</h2>
        <p className="sub">Each department gets its own floor, a Hermes board, a chief and a worker profile. You provision them right after.</p>
        <label className="lbl" htmlFor="dn">Department name</label>
        <input id="dn" className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoFocus />
        <small className="muted">Shown on the floor sign. Up to 32 characters. Must be unique.</small>
        <label className="lbl" htmlFor="dp">Purpose / objective</label>
        <textarea id="dp" className="input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        <small className="muted">The chief reads this when planning quests.</small>
        <div className="preview"><svg width="58" height="28" viewBox="0 0 58 28"><polygon points="2,4 36,20 56,10 56,16 36,26 2,10" fill="rgba(255,181,71,0.08)" stroke="#FFB547" strokeDasharray="3 2" /></svg><span><b>Adds floor F{next} · “{name || 'Untitled'}”</b><small><Glyph k="awaiting" />Starts not provisioned</small></span></div>
        <div className="row end"><Btn onClick={() => s.ui$({ modal: null })}>Cancel</Btn><button className="btn primary lg" type="submit" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create department'}</button></div>
      </form>
    </div>
  );
}
