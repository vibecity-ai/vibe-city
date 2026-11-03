import { useEffect, useRef, useState } from 'react';
import { PROVISIONING_STEPS, TOOLSETS, type CapabilityEntry, type DepartmentView, type QuestStatus, type TaskNode } from '@vibe-city/shared';
import { floorNum, useStore, type QuestItem } from '../store';
import type { Dept } from '../data/types';
import {
  archiveDepartment, cancelQuest, createDepartment, createQuest, loadArchived, loadDeptInfo, loadQuest, patchInventory, provisionDepartment,
  reconcileNow, refreshAll, refreshOne, saveDepartmentSettings, stopCancellationPoll,
} from '../data/live';
import { clock } from '../data/derive';
import {
  CANCEL_CONFIRM, CAP_STATUS_LABEL, LIMIT_COPY, PROVISIONING_STATE_LABEL, RESET_WARNING, RUN_STATE_LABEL, WORKSPACE_ADVISORY,
  archiveConsequences, assigneeWarning, cancellationView, capValue, fieldErrors, isGuaranteed, profileRows, provisioningActions,
  settingsFormFrom, settingsPatch, taskStatusView, workspaceErrorField, workspaceSummary, type SettingsForm,
} from '../data/views';
import { STATUS, canCancel, formatBytes, formatTime, planningNote, requestIdFor, treeRows } from '../../board/format.ts';
import { Btn, Chip, Field, FloorKey, Glyph, Icon, KV, Portrait, Tabs, Where, deptStatus, questStatus, statusColor, useDialog, type StatusKey } from './kit';

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const yesNo = (b: boolean | null | undefined) => (b === null || b === undefined ? '—' : b ? 'Yes' : 'No');

/* ============ top bar ============ */
export function TopBar() {
  const company = useStore((s) => s.company);
  const conn = useStore((s) => s.conn);
  const stale = useStore((s) => s.stale);
  const busy = useStore((s) => s.busy);
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>('.menu-i:not([disabled])')?.focus(); }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('.menu-i:not([disabled])') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  const pill = (ok: boolean, label: string) => (
    <span className={`led${ok ? '' : ' bad'}`} title={ok ? `${label} connected` : `${label} not responding`}><i aria-hidden="true" />{label}<span className="sr">{ok ? ' connected' : ' not responding'}</span></span>
  );
  const said = `Backend ${conn.backend ? 'connected' : 'not responding'}. Hermes ${conn.hermes ? 'connected' : 'not responding'}. Gateway ${conn.gateway ? 'running' : 'not running'}.${stale ? ' Showing out-of-date data.' : ''}`;
  return (
    <header className="top">
      <div className="logo"><span className="wordmark" data-t="VIBE CITY">VIBE CITY</span><span className="tag-line">Build your AI empire</span></div>
      <span className="plate" title="Your company">{company?.name ?? '…'}</span>
      <span className="grow" />
      {stale && <span className="demo" title="The last refresh failed; floors show the last data received"><span>Out of date</span></span>}
      <div className="conn">{pill(conn.backend, 'Backend')}{pill(conn.hermes, 'Hermes')}{pill(conn.gateway, 'Gateway')}</div>
      <span className="sr" aria-live="polite">{said}</span>
      <div className="menu-wrap">
        <button ref={trigger} className="btn tertiary sq" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon n="sliders" /></button>
        {open && (
          <div className="menu card" role="menu" ref={menu} onKeyDown={onMenuKey}>
            <button role="menuitem" className="menu-i" disabled={!!busy.reconcile} onClick={() => { close(); void reconcileNow(); }}>{busy.reconcile ? 'Reconciling…' : 'Reconcile with Hermes now'}</button>
            <button role="menuitem" className="menu-i" onClick={() => { close(); void refreshAll(); }}>Refresh</button>
            <a role="menuitem" className="menu-i" href="#board">Classic quest board (diagnostic view)</a>
          </div>
        )}
      </div>
    </header>
  );
}

/* ============ A · executive office ============ */
export function ExecPanel() {
  const { company, depts, ui, ui$, openFloor, loaded } = useStore();
  const archived = useStore((s) => s.archived);
  const running = depts.reduce((n, d) => n + d.workers.filter((w) => w.status === 'running').length + (d.chief?.status === 'running' ? 1 : 0), 0);
  const attention = depts.filter((d) => d.state === 'attention' || d.state === 'offline');
  const unconf = depts.filter((d) => d.state === 'unconfigured');
  const view = ui.execView;
  useEffect(() => { if (view === 'archived') void loadArchived(); }, [view]);
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <Where n="PH" tone="gold">Executive office</Where>
          <h1 className="display" tabIndex={-1}>{company?.name ?? 'Your company'}</h1>
          <p className="sub">{loaded ? 'Everything below is read from Hermes through the Vibe City backend.' : 'Connecting to the backend…'}</p>
          <Tabs label="Departments" idBase="exec" value={view} onChange={(v) => ui$({ execView: v })}
            options={[{ key: 'active', label: 'Active floors' }, { key: 'archived', label: <>Archived{archived.list && <span className="count">{archived.list.length}</span>}</> }]} />
        </section>
        <div id="exec-panel" role="tabpanel" aria-labelledby={`exec-tab-${view}`}>
          {view === 'active' && (
            <>
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
            </>
          )}
          {view === 'archived' && <ArchivedList />}
        </div>
      </div>
      {view === 'active' && <div className="pane-foot"><button className="btn primary block lg" onClick={() => ui$({ modal: 'create' })}><Icon n="plus" sw={3} />Add department</button></div>}
    </div>
  );
}

function ArchivedList() {
  const { list, error, loading } = useStore((s) => s.archived);
  return (
    <section className="pane-sec" aria-busy={loading}>
      <p className="fine">Archived departments are read-only. Archiving deleted nothing in Hermes: their boards, profiles and results are still there. There is no restore in this version.</p>
      {error && <div className="banner bad" role="alert"><Glyph k="failed" /><div><b>Could not load archived departments</b><p>{error}{list ? ' Showing the last list received.' : ''}</p><Btn kind="destructive" onClick={() => void loadArchived()}>Retry</Btn></div></div>}
      {loading && !list && <p className="muted">Loading…</p>}
      {list && list.length === 0 && <p className="muted">No archived departments.</p>}
      <div className="stack">{list?.map((d) => <ArchivedCard key={d.id} d={d} />)}</div>
    </section>
  );
}

function ArchivedCard({ d }: { d: DepartmentView }) {
  const ws = workspaceSummary(d.workspace);
  return (
    <details className="kv-card arch">
      <summary><Glyph k="disconnected" /><b>{d.name}</b><span className="muted small">archived {formatTime(d.archivedAt)}</span></summary>
      <KV rows={[
        ['Purpose', d.purpose || '—'],
        ['Created', formatTime(d.createdAt)],
        ['State when archived', PROVISIONING_STATE_LABEL[d.state]],
        ['Hermes board', d.hermesBoardRef ? <span className="mono">{d.hermesBoardRef} (kept in Hermes)</span> : 'never created'],
        ['Chief profile', <span className="mono">{d.chiefProfileRef ?? '—'}</span>],
        ['Worker profile', <span className="mono">{d.workerProfileRef ?? '—'}</span>],
        ['Workspace', `${ws.label} · ${ws.isolation}`],
      ]} />
    </details>
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
  const busyProv = !!s.busy[`provision:${d.id}`];
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>Department</Where><button className="x" onClick={s.closeFloor} aria-label="Close floor"><Icon n="x" /></button></div>
          <div className="title-row"><h1 className="display" tabIndex={-1}>{d.name}</h1><Chip k={st.k} label={st.label} /></div>
          <p className="sub">{d.purpose}</p>
          <div className="actions">
            <button className="btn primary" disabled={!canWork} title={canWork ? '' : 'Needs a provisioned department and a running Hermes gateway'} onClick={() => s.openPanel('board', { composer: true, boardFilter: 'all' })}><Icon n="plus" sw={3} />New quest</button>
            <Btn kind="secondary" onClick={() => s.openPanel('board', { composer: false })}>Quest board</Btn>
            <Btn kind="secondary" onClick={() => s.openPanel('inventory')}>Inventory</Btn>
            <Btn kind="secondary" onClick={() => s.openPanel('settings')}><Icon n="sliders" size={14} />Settings</Btn>
          </div>
          {!canWork && <p className="fine">{d.provisioning !== 'ready' ? 'New quests need a provisioned department.' : !s.conn.hermes ? 'New quests need Hermes to be reachable.' : 'New quests need the Hermes gateway to be running.'}</p>}
          <Tabs label="Department sections" idBase="dept" value={tab} onChange={(t) => s.ui$({ deptTab: t })}
            options={(['overview', 'inventory', 'quests'] as const).map((t) => ({ key: t, label: <>{t[0]!.toUpperCase() + t.slice(1)}{t === 'quests' && <span className="count">{active.length}</span>}</> }))} />
        </section>
        <div id="dept-panel" role="tabpanel" aria-labelledby={`dept-tab-${tab}`}>
          <div aria-live="polite">
            {s.liveDown[d.id] && <div className="banner warn"><Glyph k="disconnected" /><div><b>Live updates reconnecting</b><p>The live link to the backend dropped. The floor still refreshes every 30 seconds.</p></div></div>}
            {d.state === 'offline' && (
              <div className="banner bad"><Glyph k="disconnected" /><div><b>Hermes resources not verified</b><p>{d.attention}. Agents can’t receive new work until this floor is verified again.</p>
                <Btn kind="destructive" busy={busyProv} disabled={busyProv} onClick={() => void provisionDepartment(d.id, {}, true)}>{busyProv ? 'Retrying…' : 'Retry connection'}</Btn></div></div>
            )}
            {d.state === 'attention' && d.attention && <div className="banner bad"><Glyph k="failed" /><div><b>Needs attention</b><p>{d.attention}</p></div></div>}
            {d.provisioning === 'unconfigured' && <div className="banner warn"><Glyph k="awaiting" /><div><b>Changes not applied</b><p>This department was edited after it was provisioned. Provision again to apply them in Hermes.</p>
              <Btn kind="secondary" busy={busyProv} disabled={busyProv} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Provisioning…' : 'Provision again'}</Btn></div></div>}
          </div>
          {tab === 'overview' && (
            <>
              <section className="pane-sec">
                <h3 className="sec-t">Chain of command</h3>
                <button type="button" className={`chief-card${sel === 'chief' ? ' sel' : ''}`} aria-pressed={sel === 'chief'} onClick={() => s.ui$({ agent: 'chief' })}>
                  <span className="chief-top">
                    <Portrait shirt="#fff" chief size={44} />
                    <span>
                      <span className="chief-badges"><span className="role">Chief</span><Chip k={d.chief.status} small /></span>
                      <span className="chief-name">{d.chief.name}</span>
                      <span className="mono muted small">profile · {d.chief.profile || '—'}{d.chief.model && <><br />model · {d.chief.model}</>}</span>
                    </span>
                  </span>
                  <span className="chief-act"><span>{d.chief.activity}</span><span className="mono muted">since {d.chief.since}</span></span>
                </button>
                <div className="tree">
                  {d.workers.map((w) => (
                    <button key={w.taskId} className={`wrow${sel === w.id ? ' sel' : ''}`} aria-pressed={sel === w.id} onClick={() => s.ui$({ agent: w.id })}>
                      <Portrait shirt={w.shirt} size={28} />
                      <span className="wrow-t"><span><span className="mono muted">{w.id}</span> <b>{w.task}</b></span>
                        <small style={{ color: statusColor(w.status) }}><Glyph k={w.status} />{WORKER_WORD[w.status]} <span className="muted">· {w.status === 'completed' ? 'done' : 'since'} {w.since}</span></small>
                      </span>
                    </button>
                  ))}
                  {d.workers.length === 0 && <div className="empty-w">No worker tasks yet. Workers appear when the chief delegates a quest.</div>}
                </div>
                <p className="mono muted small">{running} worker task{running === 1 ? '' : 's'} running · requested limit {d.maxWorkers} (host-limited, not enforced per department)</p>
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
      <div className="inv-sum-h"><b>{label}</b><span className="mono muted">{items.length} {label === 'Shared context' ? 'refs' : 'allowed'}</span></div>
      <div className="inv-tags">{items.map((i) => <span key={i} className="itag">{i}</span>)}{items.length === 0 && <span className="muted small">None set</span>}</div>
    </div>
  );
  return (
    <section className="pane-sec">
      {!inv && <p className="muted">Loading inventory…</p>}
      {inv && <>{sec('Toolsets', inv.allowedToolsets)}{sec('Skills', inv.allowedSkillIds)}{sec('MCP tools', inv.allowedMcpTools)}{sec('Models', inv.allowedModelIds)}{sec('Shared context', inv.sharedContextRefs)}</>}
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
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)} tone="amber">{d.provisioning === 'error' ? 'Provisioning failed' : 'New department'}</Where><button className="x" onClick={s.closeFloor} aria-label="Close floor"><Icon n="x" /></button></div>
          <div className="title-row"><h1 className="display" tabIndex={-1}>{d.name}</h1><Chip k={d.state === 'attention' ? 'failed' : 'awaiting'} label={d.provisioning === 'provisioning' ? 'Provisioning' : d.state === 'attention' ? 'Needs attention' : 'Not provisioned'} /></div>
          <p className="sub">{d.purpose}</p>
          <div className="actions"><Btn kind="secondary" onClick={() => s.openPanel('settings')}><Icon n="sliders" size={14} />Settings, profiles & archive</Btn></div>
        </section>
        <div aria-live="polite">
          {err && (
            <div className="banner bad" role="alert"><Glyph k="failed" /><div><b>Step “{err.step}” failed</b><p>{err.message}</p>
              <p className="fine mono">{err.code} · {formatTime(err.at)}</p>
              <p className="fine">{err.retryable ? 'This can be retried.' : 'Something must change before retrying.'}</p></div></div>
          )}
        </div>
        <section className="pane-sec">
          <h3 className="sec-t">Get this floor running</h3>
          <div className="step done"><Glyph k="completed" size={12} /><b>Name & objective</b><span className="muted small">Saved</span><button className="link" onClick={() => s.openPanel('settings')}>Edit</button></div>
          <div className="step done"><Glyph k="completed" size={12} /><span><b>Inventory</b><small className="muted">{inv ? `${inv.allowedToolsets.length} toolsets · ${inv.allowedSkillIds.length} skills · ${inv.allowedModelIds.length} models` : 'Loading…'}</small></span><button className="link" onClick={() => s.openPanel('inventory')}>Edit</button></div>
          <form className="step open" onSubmit={submit} aria-busy={busy}>
            <div className="step-h"><span className="num">3</span><b>Create the Hermes resources</b></div>
            <p className="fine">Provisioning creates a Kanban board and two Hermes profiles (a chief and a worker), applies the inventory and verifies it by reading it back. It can take a minute.</p>
            <fieldset className="plain">
              <legend className="sr">Profiles</legend>
              <label className={`radio${mode === 'managed' ? ' on' : ''}`}><input type="radio" name="m" checked={mode === 'managed'} onChange={() => setMode('managed')} />Create managed profiles (recommended)</label>
              <label className={`radio${mode === 'link' ? ' on' : ''}`}><input type="radio" name="m" checked={mode === 'link'} onChange={() => setMode('link')} />Use existing Hermes profiles</label>
            </fieldset>
            {mode === 'link' && (
              <>
                <Field label="Chief profile" error={chief.trim() && !PROFILE_RE.test(chief.trim()) ? 'Lowercase letters, digits, - and _ only.' : null}>
                  {(p) => <input {...p} className="input mono" value={chief} onChange={(e) => setChief(e.target.value)} placeholder="existing-profile-name" />}
                </Field>
                <Field label="Worker profile" error={worker.trim() && !PROFILE_RE.test(worker.trim()) ? 'Lowercase letters, digits, - and _ only.' : worker.trim() && worker.trim() === chief.trim() ? 'Chief and worker must be different profiles.' : null}>
                  {(p) => <input {...p} className="input mono" value={worker} onChange={(e) => setWorker(e.target.value)} placeholder="existing-profile-name" />}
                </Field>
                <label className="consent">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  <span>Allow Vibe City to modify <b className="mono">{chief.trim() || 'the chief profile'}</b> and <b className="mono">{worker.trim() || 'the worker profile'}</b>: toolsets, skills, default model and a block in SOUL.md. This also changes how they behave <b>outside</b> Vibe City.</span>
                </label>
              </>
            )}
            <button className="btn primary lg" type="submit" aria-busy={busy || undefined} disabled={busy || !s.conn.hermes || !valid}>{busy ? 'Provisioning…' : err ? (err.retryable ? 'Retry provisioning' : 'Provision again') : 'Provision department'}</button>
            {!s.conn.hermes && <small className="muted">Hermes is not reachable. Start the dashboard and gateway first.</small>}
            {busy && <div className="steps-list" role="status">Provisioning: {PROVISIONING_STEPS.map((x) => <span key={x} className="mono muted">{x}</span>)}</div>}
          </form>
        </section>
      </div>
    </div>
  );
}

/* ============ G · department settings, provisioning inspector, archive ============ */
export function SettingsSheet() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  const id = d?.id;
  useEffect(() => { if (id) void loadDeptInfo(id); }, [id]);
  if (!d) return null;
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>{d.name}</Where><button className="x boxed" onClick={() => s.openPanel('dept')} aria-label="Close settings"><Icon n="x" /></button></div>
          <h1 className="display" tabIndex={-1}>Department settings</h1>
          <p className="sub">Edit the department, inspect what Vibe City created or linked in Hermes, or archive the floor.</p>
        </section>
        <SettingsForm key={`${d.id}|${d.name}|${d.purpose}|${d.workspace.label}`} d={d} />
        <ProvisioningInspector d={d} />
        <section className="pane-sec danger">
          <h3 className="sec-t">Archive</h3>
          <p className="fine">Removes the floor from the tower. Nothing is deleted in Hermes.</p>
          <Btn kind="destructive" onClick={() => s.ui$({ modal: 'archive' })}>Archive department…</Btn>
        </section>
      </div>
    </div>
  );
}

function SettingsForm({ d }: { d: Dept }) {
  const busy = useStore((s) => !!s.busy[`settings:${d.id}`]);
  const [f, setF] = useState<SettingsForm>(() => settingsFormFrom(d));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const patch = settingsPatch(d, f);
  const ws = workspaceSummary(d.workspace);
  const set = (p: Partial<SettingsForm>) => { setF({ ...f, ...p }); setErrs({}); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patch || busy) return;
    if (f.workspaceMode === 'set' && !f.workspacePath.trim().startsWith('/')) return setErrs({ workspace: 'Enter an absolute path on the server, starting with /.' });
    const err = await saveDepartmentSettings(d.id, patch);
    if (!err) return;
    setErrs(err.issues.length ? fieldErrors(err.issues, ['name', 'purpose', 'workspace']) : { [workspaceErrorField(err.message)]: err.message });
  };
  return (
    <form className="pane-sec" onSubmit={submit} aria-busy={busy} noValidate>
      <h3 className="sec-t">Details</h3>
      <div className="banner warn inline-b"><Glyph k="awaiting" /><div><p>{RESET_WARNING}</p></div></div>
      <Field label="Department name" hint="Up to 80 characters. Unique among active departments." error={errs.name}>
        {(p) => <input {...p} className="input" value={f.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Purpose / objective" hint="The chief reads this when planning quests." error={errs.purpose}>
        {(p) => <textarea {...p} className="input" rows={3} maxLength={2000} value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} />}
      </Field>
      <fieldset className="plain" aria-describedby="ws-adv">
        <legend className="lbl">Workspace</legend>
        <p className="mono small">Current: {ws.label} · <span className="muted">{ws.isolation}</span></p>
        <label className={`radio${f.workspaceMode === 'keep' ? ' on' : ''}`}><input type="radio" name="wsm" checked={f.workspaceMode === 'keep'} onChange={() => set({ workspaceMode: 'keep' })} />Keep {d.workspace.configured ? 'the current path' : 'it unset'}</label>
        <label className={`radio${f.workspaceMode === 'set' ? ' on' : ''}`}><input type="radio" name="wsm" checked={f.workspaceMode === 'set'} onChange={() => set({ workspaceMode: 'set' })} />Set a new server path</label>
        {d.workspace.configured && <label className={`radio${f.workspaceMode === 'clear' ? ' on' : ''}`}><input type="radio" name="wsm" checked={f.workspaceMode === 'clear'} onChange={() => set({ workspaceMode: 'clear' })} />Clear the workspace</label>}
      </fieldset>
      {f.workspaceMode === 'set' && (
        <Field label="Absolute path on the server" hint="The directory must already exist on the machine running the backend." error={errs.workspace}>
          {(p) => <input {...p} className="input mono" value={f.workspacePath} placeholder="/srv/projects/research" autoComplete="off" spellCheck={false} onChange={(e) => set({ workspacePath: e.target.value })} />}
        </Field>
      )}
      {f.workspaceMode !== 'set' && errs.workspace && <small className="field-err" role="alert"><Glyph k="failed" />{errs.workspace}</small>}
      <p id="ws-adv" className="fine">{WORKSPACE_ADVISORY}</p>
      {errs.form && <p className="field-err" role="alert"><Glyph k="failed" />{errs.form}</p>}
      <div className="row"><button className="btn primary" type="submit" disabled={!patch || busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save changes'}</button>
        {patch && <Btn onClick={() => { setF(settingsFormFrom(d)); setErrs({}); }} disabled={busy}>Discard</Btn>}</div>
      <p className="fine">Chief and worker profiles are chosen in the provisioning flow, which asks for explicit consent before Vibe City modifies an existing profile.</p>
    </form>
  );
}

function ProvisioningInspector({ d }: { d: Dept }) {
  const s = useStore();
  const info = s.info[d.id];
  const prov = info?.provisioning ?? null;
  const profiles = info?.profiles ?? null;
  const acts = provisioningActions(prov);
  const busy = !!s.busy[`provision:${d.id}`];
  const [refreshing, setRefreshing] = useState(false);
  const res = (r: NonNullable<typeof prov>['board']) => `${r.verified ? `Verified ${formatTime(r.verifiedAt)}` : 'Not verified'}`;
  return (
    <section className="pane-sec" aria-labelledby="pi-h">
      <h3 className="sec-t" id="pi-h">Hermes profiles & provisioning</h3>
      <div aria-live="polite" role="status" className="prov-state">
        {prov ? <><Chip k={prov.state === 'ready' ? 'completed' : prov.state === 'error' ? 'failed' : prov.state === 'disconnected' ? 'disconnected' : prov.state === 'provisioning' ? 'running' : 'awaiting'} label={PROVISIONING_STATE_LABEL[prov.state]} />
          <span className="muted small">{prov.attempts} attempt{prov.attempts === 1 ? '' : 's'} · last reconciled {formatTime(prov.lastReconciledAt)}</span></> : <span className="muted">Loading provisioning status…</span>}
      </div>
      {info?.infoError && <p className="field-err" role="alert"><Glyph k="failed" />Could not refresh profile details: {info.infoError}{profiles ? ' Showing the last data received.' : ''}</p>}
      {prov?.error && (
        <div className="banner bad inline-b" role="alert"><Glyph k="failed" /><div><b>{prov.error.message}</b>
          <KV rows={[['Code', <span className="mono">{prov.error.code}</span>], ['Step', prov.error.step], ['Retryable', prov.error.retryable ? 'Yes' : 'No: change the configuration first'], ['At', formatTime(prov.error.at)]]} /></div></div>
      )}
      <KV rows={[['Hermes (profile lookup)', !profiles ? '—' : profiles.reachable ? 'Reachable' : 'Not reachable: stored profile names shown, live details unknown']]} />
      {profileRows(profiles, prov, formatTime).map((r) => (
        <div key={r.role} className="kv-card block">
          <b>{r.role === 'chief' ? 'Chief' : 'Worker'} · <span className="mono">{r.ref}</span></b>
          <KV rows={[['In Hermes', r.exists], ['Model', <span className="mono">{r.model}</span>], ['Description', r.description], ['Origin', r.origin], ['Verification', r.verified]]} />
        </div>
      ))}
      {prov && (
        <div className="kv-card block">
          <b>Board & inventory</b>
          <KV rows={[
            ['Board', <span className="mono">{prov.board.ref ?? d.view.hermesBoardSlug + ' (not created yet)'}</span>],
            ['Board sync', d.view.boardSyncState.replace('_', ' ')],
            ['Board verification', res(prov.board)],
            ['Inventory applied', prov.inventory.applied ? `Yes, ${formatTime(prov.inventory.appliedAt)}` : 'No'],
            ['Inventory in sync', yesNo(prov.inventory.inSync)],
          ]} />
        </div>
      )}
      {acts.hint && <p className="fine">{acts.hint}</p>}
      <div className="row wrap">
        {acts.provision.show && <Btn kind="primary" busy={busy} disabled={busy || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busy ? 'Provisioning…' : acts.provision.label}</Btn>}
        {acts.retry && <Btn kind="warn" busy={busy} disabled={busy || !s.conn.hermes} onClick={() => void provisionDepartment(d.id, {}, true)}>{busy ? 'Retrying…' : 'Retry provisioning'}</Btn>}
        <Btn kind="secondary" busy={!!s.busy.reconcile} disabled={!!s.busy.reconcile} onClick={() => void reconcileNow()}>{s.busy.reconcile ? 'Reconciling…' : 'Reconcile now'}</Btn>
        <Btn busy={refreshing} disabled={refreshing} onClick={() => { setRefreshing(true); void refreshOne(d.id).finally(() => setRefreshing(false)); }}><Icon n="refresh" size={14} />{refreshing ? 'Refreshing…' : 'Refresh'}</Btn>
      </div>
      {(acts.provision.show || acts.retry) && !s.conn.hermes && <small className="muted">Hermes is not reachable, so provisioning is disabled.</small>}
    </section>
  );
}

export function ArchiveModal() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  const open = s.ui.modal === 'archive' && !!d;
  const ref = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => { setTyped(''); setError(null); s.ui$({ modal: null }); };
  useDialog(ref, open, close);
  if (!open || !d) return null;
  const busy = !!s.busy[`archive:${d.id}`];
  const activeQuests = s.quests.filter((q) => q.deptId === d.id && ACTIVE.has(q.summary.status)).length;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typed.trim() !== d.name || busy) return;
    const err = await archiveDepartment(d.id);
    if (err) setError(err.message); else { setTyped(''); setError(null); }
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) close(); }}>
      <form ref={ref} className="modal" role="alertdialog" aria-modal="true" aria-labelledby="ar-t" aria-describedby="ar-d" onSubmit={submit}>
        <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)} tone="amber">Archive</Where><button type="button" className="x" onClick={close} aria-label="Close" disabled={busy}><Icon n="x" /></button></div>
        <h2 id="ar-t" className="display">Archive “{d.name}”?</h2>
        <ul id="ar-d" className="conseq">{archiveConsequences(d.view).map((c) => <li key={c}>{c}</li>)}</ul>
        {activeQuests > 0 && <p className="field-err"><Glyph k="awaiting" />{activeQuests} quest{activeQuests === 1 ? ' is' : 's are'} still active on this floor and will keep running in Hermes.</p>}
        <Field label={`Type the department name to confirm`} hint={<span className="mono">{d.name}</span>} error={error}>
          {(p) => <input {...p} className="input" value={typed} autoComplete="off" onChange={(e) => { setTyped(e.target.value); setError(null); }} />}
        </Field>
        <div className="row end"><Btn onClick={close} disabled={busy}>Keep department</Btn>
          <button className="btn destructive lg" type="submit" disabled={typed.trim() !== d.name || busy} aria-busy={busy || undefined}>{busy ? 'Archiving…' : 'Archive department'}</button></div>
      </form>
    </div>
  );
}

/* ============ C · inventory ============ */
function ListEditor({ label, hint, values, onSave, disabled }: { label: string; hint: string; values: readonly string[]; onSave: (v: string[]) => void; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (v && !values.includes(v)) onSave([...values, v]); setDraft(''); };
  const hid = `h-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="kv-card block" role="group" aria-labelledby={`${hid}-l`}>
      <b id={`${hid}-l`}>{label}</b> <span id={hid} className="muted small">{hint}</span>
      <ul className="chips" aria-label={`${label} (${values.length})`}>{values.map((v) => <li key={v} className="itag mono">{v}<button type="button" aria-label={`Remove ${v}`} disabled={disabled} onClick={() => onSave(values.filter((x) => x !== v))}>×</button></li>)}{values.length === 0 && <li className="muted small">None</li>}</ul>
      <div className="inline"><input className="input mono" value={draft} placeholder={`Add ${label.toLowerCase()}`} aria-label={`Add ${label}`} aria-describedby={hid} disabled={disabled} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} /><Btn onClick={add} disabled={disabled || !draft.trim()}>Add</Btn></div>
    </div>
  );
}

const CAP_GROUPS = [
  ['enforced', 'Applied, read back from Hermes, and tested to hold at runtime on one Hermes version.'],
  ['configured', 'Set in Hermes and read back. Runtime behavior has not been tested, so this is not a guarantee.'],
  ['unverified', 'Could not be applied or read back in this installation.'],
  ['unsupported', 'Hermes has no interface to enforce this. It is a request, not a control.'],
] as const;

function CapabilityReport({ entries }: { entries: { role: string; e: CapabilityEntry }[] }) {
  return (
    <>
      {CAP_GROUPS.map(([status, blurb]) => {
        const list = entries.filter((x) => x.e.status === status);
        if (!list.length) return null;
        return (
          <div key={status} className={`capgroup ${status}`}>
            <h4>{CAP_STATUS_LABEL[status]} <span className="count">{list.length}</span></h4>
            <p className="fine">{blurb}</p>
            {list.map((x, i) => {
              const locked = isGuaranteed(x.e);
              return (
                <div key={i} className={`cap${locked ? ' locked' : ''}`}>
                  <span className="cap-h">{locked && <Icon n="lock" size={12} />}<b>{x.e.capability}</b> <span className="muted small">· {x.role}</span>
                    <span className={`cap-g${locked ? ' on' : ''}`}>{locked ? 'Guaranteed' : 'Not a guarantee'}</span></span>
                  <small>{x.e.detail}</small>
                  <small className="mono muted">requested: {capValue(x.e.requested)} · effective: {capValue(x.e.effective)}</small>
                </div>
              );
            })}
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
  const busyProv = !!s.busy[`provision:${d.id}`];
  const save = (p: Parameters<typeof patchInventory>[1]) => void patchInventory(d.id, p);
  const entries = eff ? [...eff.chief.entries.map((e) => ({ role: 'chief', e })), ...eff.worker.entries.map((e) => ({ role: 'worker', e })), ...eff.departmentWide.map((e) => ({ role: 'department', e }))] : [];
  const ws = workspaceSummary(d.workspace);
  const wasProvisioned = !!info?.provisioning?.board.verified || !!info?.provisioning?.inventory.appliedAt;
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>{d.name}</Where><button className="x boxed" onClick={() => s.openPanel('dept')} aria-label="Close inventory"><Icon n="x" /></button></div>
          <h1 className="display" tabIndex={-1}>Department inventory</h1>
          <p className="sub">What agents on this floor may use. The chief and workers are narrowed by role, never beyond this allowance. A setting counts as a guarantee only where the report below says <b>Enforced</b>.</p>
        </section>
        {!inv && <p className="muted pane-sec">Loading inventory…</p>}
        {inv && (
          <div className="inv-body" aria-busy={saving}><div className="inv-main">
            <div aria-live="polite">
              {saving && <p className="muted small" role="status">Saving…</p>}
              {d.provisioning === 'unconfigured' && wasProvisioned && <div className="banner warn"><Glyph k="awaiting" /><div><b>Needs provisioning again</b><p>Saved changes are not in Hermes yet. Agents keep their previous configuration until you provision again.</p><Btn kind="secondary" busy={busyProv} disabled={busyProv || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Provisioning…' : 'Provision again'}</Btn></div></div>}
              {d.provisioning === 'ready' && eff && !eff.inSync && <div className="banner warn"><Glyph k="awaiting" /><div><b>Hermes no longer matches</b><p>The last read from Hermes differs from this inventory.</p><Btn kind="secondary" busy={busyProv} disabled={busyProv || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Provisioning…' : 'Provision again'}</Btn></div></div>}
            </div>
            <h3 className="inv-h">Toolsets <span>Switched off in Hermes unless allowed</span></h3>
            <div className="slot-grid">
              {TOOLSETS.map((t) => {
                const on = inv.allowedToolsets.includes(t);
                return (
                  <div key={t} className={`slot-card ${on ? '' : 'disabled'}`}>
                    <div className="slot-top"><span className="slot-ic"><Icon n="plug" size={15} /></span>
                      <button className={`toggle${on ? ' on' : ''}`} disabled={saving} aria-label={`${t}: ${on ? 'allowed' : 'not allowed'}`} aria-pressed={on}
                        onClick={() => save({ allowedToolsets: on ? inv.allowedToolsets.filter((x) => x !== t) : [...inv.allowedToolsets, t] })}><i /></button></div>
                    <div className="slot-name mono">{t}</div>
                    <div className="slot-desc">{on ? 'Allowed' : 'Off'}{t === 'kanban' ? ' · always on for task reporting' : ''}</div>
                  </div>
                );
              })}
            </div>
            <h3 className="inv-h">Skills, MCP tools and models <span>Allowlists</span></h3>
            <ListEditor label="Skills" hint="Installed skills not listed are disabled." values={inv.allowedSkillIds} disabled={saving} onSave={(v) => save({ allowedSkillIds: v })} />
            <ListEditor label="MCP tools" hint="server:tool or a bare server id. Not applied yet: reported unverified." values={inv.allowedMcpTools} disabled={saving} onSave={(v) => save({ allowedMcpTools: v })} />
            <ListEditor label="Models" hint="Sets the profile default. Hermes cannot restrict which models run." values={inv.allowedModelIds} disabled={saving} onSave={(v) => save({ allowedModelIds: v })} />
            <h3 className="inv-h">Shared context <span>References only</span></h3>
            <ListEditor label="Shared context refs" hint={LIMIT_COPY.sharedContextRefs} values={inv.sharedContextRefs} disabled={saving} onSave={(v) => save({ sharedContextRefs: v })} />
            <h3 className="inv-h">Workspace</h3>
            <div className="kv-card"><Icon n="folder" size={14} /><span className="mono">{ws.label}</span>
              <span className="muted small">{ws.isolation} {WORKSPACE_ADVISORY}</span><button className="link" onClick={() => s.openPanel('settings')}>Change in settings</button></div>
            <h3 className="inv-h">Limits</h3>
            <div className="kv-card block">
              <Field label="Requested worker limit (1–10) · host-limited" hint={LIMIT_COPY.maxConcurrentWorkers}>
                {(p) => <input {...p} className="input mono" type="number" min={1} max={10} defaultValue={inv.limits.maxConcurrentWorkers} key={inv.limits.maxConcurrentWorkers} disabled={saving}
                  onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 10 && n !== inv.limits.maxConcurrentWorkers) save({ limits: { maxConcurrentWorkers: n } }); else e.target.value = String(inv.limits.maxConcurrentWorkers); }} />}
              </Field>
              <Field label="Max seconds for the quest task (10–86400, blank = none)" hint={LIMIT_COPY.maxTaskRuntimeSeconds}>
                {(p) => <input {...p} className="input mono" type="number" min={10} max={86400} defaultValue={inv.limits.maxTaskRuntimeSeconds ?? ''} key={String(inv.limits.maxTaskRuntimeSeconds)} disabled={saving}
                  onBlur={(e) => { const v = e.target.value.trim(); const n = v === '' ? null : Math.round(Number(v)); if ((n === null || (n >= 10 && n <= 86400)) && n !== inv.limits.maxTaskRuntimeSeconds) save({ limits: { maxTaskRuntimeSeconds: n } }); else e.target.value = String(inv.limits.maxTaskRuntimeSeconds ?? ''); }} />}
              </Field>
              <KV rows={[['Delegation depth', <>{inv.limits.maxDelegationDepth} (fixed) · <span className="muted">{LIMIT_COPY.maxDelegationDepth}</span></>]]} />
            </div>
            <h3 className="inv-h">What is actually guaranteed {eff?.observedAt && <span>Read from Hermes {formatTime(eff.observedAt)}</span>}</h3>
            {!eff && <p className="muted">{info?.infoError ? `Could not load the capability report: ${info.infoError}` : 'Loading the capability report…'}</p>}
            {eff && !eff.observedAt && <p className="fine">Nothing has been read back from Hermes yet: every entry below is what was requested, not what Hermes applied.</p>}
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
            <div className="head-actions"><button className="btn primary lg" disabled={!canWork} title={canWork ? '' : 'Needs a provisioned department and a running Hermes gateway'} onClick={() => s.ui$({ composer: true })}><Icon n="plus" sw={3} />New quest</button><button className="x boxed" onClick={() => s.openPanel('dept')} aria-label="Close quest board"><Icon n="x" /></button></div>
          </div>
          <h1 className="display" tabIndex={-1}>Quest board</h1>
          <p className="sync" aria-live="polite"><Icon n="refresh" size={14} />{s.conn.hermes && !s.stale ? <>Read from Hermes Kanban · board <span className="mono">vc-{d.id.slice(0, 8)}…</span></> : <span style={{ color: '#FF5C7A' }}>{s.conn.hermes ? 'The last refresh failed' : 'Hermes isn’t responding'} · showing the last data received</span>}</p>
          <div className="filters" role="group" aria-label="Filter quests">
            {(['all', 'active', 'attention', 'finished'] as const).map((k) => <button key={k} aria-pressed={f === k} className={f === k ? 'on' : ''} onClick={() => s.ui$({ boardFilter: k })}>{{ all: 'All', active: 'Active', attention: 'Attention', finished: 'Finished' }[k]}<span className="count">{count(k)}</span></button>)}
          </div>
        </section>
        <div className="board">
          {COLUMNS.filter((c) => f === 'all' || c.key === f || (f === 'active' && c.key === 'queued')).map((c) => {
            const list = qs.filter((q) => c.has(q.summary.status));
            return (
              <div key={c.key} className="col">
                <div className="col-h" style={{ color: statusColor(c.k), borderColor: statusColor(c.k) }}><Glyph k={c.k} /><b>{c.title}</b><span className="col-n">{list.length}</span></div>
                {c.key === 'queued' && s.ui.composer && (
                  <form className="composer" onSubmit={submit} aria-busy={busy}>
                    <Field label="Quest title">{(p) => <input {...p} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
                    <Field label="Objective">{(p) => <textarea {...p} className="input" rows={3} maxLength={8000} value={obj} onChange={(e) => setObj(e.target.value)} />}</Field>
                    <Field label="Extra instructions (optional)">{(p) => <textarea {...p} className="input" rows={2} maxLength={8000} value={instr} onChange={(e) => setInstr(e.target.value)} />}</Field>
                    <small className="muted">Assigned to <b className="gold-n">{d.chief?.name ?? 'the chief'}</b></small>
                    <div className="row"><button className="btn primary grow" type="submit" aria-busy={busy || undefined} disabled={busy || !title.trim() || !obj.trim()}>{busy ? 'Creating…' : 'Create quest'}</button><Btn onClick={() => s.ui$({ composer: false })}>Cancel</Btn></div>
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
        <span><i>Tasks</i>{x.counts.tasks ? <>{workers.length > 0 && <span className="pips" aria-hidden="true">{workers.map((t) => <Glyph key={t.id} k={taskStatusView(t).k} />)}</span>}{x.counts.done} of {x.counts.tasks} done</> : 'None yet'}</span>
      </span>
      {x.status === 'running' && <span className="note">Stays in progress until every task is done.</span>}
      {x.flags.hasFailures && <span className="err"><Glyph k="failed" />A task failed</span>}
      {x.flags.unauthorizedAssignees && <span className="err"><Glyph k="awaiting" />Task outside this department</span>}
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
  useEffect(() => {
    if (!qid || !deptId) return;
    void loadQuest(deptId, qid);
    return () => stopCancellationPoll(qid);
  }, [qid, deptId]);
  if (!item) return null;
  const sum = item.summary;
  const d = s.depts.find((x) => x.id === item.deptId);
  const note = detail ? planningNote(detail) : null;
  const hasData = !!detail || !!extra?.results || !!extra?.activity.length;
  const reload = () => void loadQuest(item.deptId, sum.id);
  return (
    <div className="pane sheet">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><button className="link" onClick={() => s.openPanel('board')}><Icon n="back" size={14} />Quest board</button><span className="mono muted">{sum.id}</span></div>
          <div className="title-row"><h1 className="display sm" tabIndex={-1}>{sum.title}</h1><Chip k={questStatus(sum.status)} label={STATUS[sum.status].label} /></div>
          <p className="meta"><span className="meta-f"><FloorKey n={'F' + floorNum(s.depts, item.deptId)} />{d?.name}</span><span>Chief <b className="gold-n">{d?.chief?.name ?? '—'}</b></span><span className="mono">{formatTime(sum.createdAt)}{sum.completedAt ? ` → ${formatTime(sum.completedAt)}` : ''}</span></p>
          <p className="fine">{STATUS[sum.status].hint}</p>
          <Tabs label="Quest sections" idBase="quest" value={tab} onChange={setTab} options={(['overview', 'activity', 'results'] as const).map((t) => ({ key: t, label: t[0]!.toUpperCase() + t.slice(1) }))} />
        </section>
        <div aria-live="polite">
          {!s.conn.hermes && hasData && <div className="banner bad"><Glyph k="disconnected" /><div><b>Hermes is not reachable</b><p>Showing the last data received. It may be out of date.</p></div></div>}
          {extra?.error && <div className="banner bad" role="alert"><Glyph k="failed" /><div><b>{hasData ? 'Refresh failed: showing the last data received' : 'Could not load this quest'}</b><p>{extra.error}</p><Btn kind="destructive" onClick={reload}>Retry</Btn></div></div>}
        </div>
        <div id="quest-panel" role="tabpanel" aria-labelledby={`quest-tab-${tab}`}>
          {tab === 'overview' && (
            <section className="pane-sec">
              {!detail && !extra?.error && <p className="muted" aria-busy="true">Loading…</p>}
              {detail && (
                <>
                  {note && <p className="note">{note}</p>}
                  {detail.warnings.map((w) => <div key={w} className="banner warn inline-b"><Glyph k="awaiting" /><div>{w}</div></div>)}
                  {detail.violations.length > 0 && <div className="banner bad inline-b"><Glyph k="failed" /><div><b>Tasks outside this department</b>{detail.violations.map((v) => <p key={v}>{v}</p>)}<p className="fine">Detected, not prevented: Hermes cannot stop the chief from creating them.</p></div></div>}
                  <h3 className="sec-t">Objective</h3><p className="box-p">{detail.objective || 'No objective written.'}</p>
                  <h3 className="sec-t">Tasks <span className="count">{detail.counts.done}/{detail.counts.tasks} done</span></h3>
                  <p className="mono muted small">{detail.counts.running} running · {detail.counts.pending} pending · {detail.counts.blocked} blocked · {detail.counts.failed} failed · {detail.counts.archived} archived</p>
                  <ul className="stack tasks">{treeRows(detail.tasks).map(({ node, depth }) => <TaskRow key={node.id} node={node} depth={depth} all={detail.tasks} />)}</ul>
                  {detail.truncated && <p className="note warn">Large quest: the task tree was truncated by safety limits, so only part of it is shown and counts may be incomplete.</p>}
                  <CancellationSection deptId={item.deptId} questId={sum.id} status={sum.status} tasks={detail.tasks} />
                </>
              )}
            </section>
          )}
          {tab === 'activity' && (
            <section className="pane-sec" aria-busy={extra?.loading}>
              {extra?.loading && !extra.activity.length && <p className="muted">Loading…</p>}
              {extra && !extra.loading && !extra.error && !extra.activity.length && <p className="muted">No events yet.</p>}
              <ol className="timeline">{[...(extra?.activity ?? [])].reverse().map((e) => (
                <li key={e.id}><span className="mono muted" title={formatTime(e.at)}>{clock(e.at)}</span><Glyph k={/fail|block|crash|timed/i.test(e.kind) ? 'failed' : /complet/i.test(e.kind) ? 'completed' : 'running'} />
                  <span><span>{e.label}</span> <small className="muted">{e.taskTitle}</small> <small className="mono muted">{e.kind}</small>{e.detail && <small className="err-t">{e.detail}</small>}</span></li>
              ))}</ol>
              {ACTIVE.has(sum.status) && <p className="muted small live"><Glyph k="running" />Live · refreshes when Hermes reports an event</p>}
            </section>
          )}
          {tab === 'results' && <ResultsSection status={sum.status} extra={extra} />}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ node, depth, all }: { node: TaskNode; depth: number; all: TaskNode[] }) {
  const [open, setOpen] = useState(false);
  const v = taskStatusView(node);
  const warn = assigneeWarning(node);
  const title = (id: string) => all.find((t) => t.id === id)?.title ?? id;
  const did = `task-${node.id}`;
  return (
    <li className={`trow-w${warn ? ' other' : ''}`} style={{ marginLeft: Math.min(depth, 6) * 16 }}>
      <button type="button" className="trow" aria-expanded={open} aria-controls={did} onClick={() => setOpen(!open)}>
        <Glyph k={v.k} /><span className="mono muted">{node.role}</span><b>{node.title}</b>{warn && <span className="err small"><Glyph k="awaiting" />outside dept</span>}<span className="grow" />
        <span style={{ color: statusColor(v.k) }}>{v.label}</span><Icon n={open ? 'minus' : 'plus'} size={12} />
      </button>
      {open && (
        <div id={did} className="task-x">
          {warn && <p className="field-err"><Glyph k="awaiting" />{warn}</p>}
          <KV rows={[
            ['Task', <span className="mono">{node.id}</span>],
            ['Role · assignee', <>{node.role} · <span className="mono">{node.assignee ?? 'unassigned'}</span></>],
            ['Hermes status', <>{node.status}{node.failed ? ' (blocked after a failure)' : node.status === 'blocked' ? ' (waiting for input, not a failure)' : ''}</>],
            ['Tree', `depth ${node.depth}${node.parentIds.length ? ` · parent: ${node.parentIds.map(title).join(', ')}` : ' · quest root'}${node.childIds.length ? ` · ${node.childIds.length} child task${node.childIds.length === 1 ? '' : 's'}` : ''}`],
            ['Created', formatTime(node.createdAt)], ['Started', formatTime(node.startedAt)], ['Completed', formatTime(node.completedAt)],
            ['Attachments', String(node.attachmentCount)],
          ]} />
          {node.summary && <><h4 className="mini-h">Summary</h4><p className="box-p">{node.summary}</p></>}
          {node.error && <><h4 className="mini-h">Error</h4><p className="err-t">{node.error}</p></>}
          <h4 className="mini-h">Runs</h4>
          {node.runs.length === 0 ? <p className="muted small">No runs yet.</p> : (
            <table className="runs"><thead><tr><th scope="col">Run</th><th scope="col">Profile</th><th scope="col">State</th><th scope="col">Started</th><th scope="col">Ended</th></tr></thead>
              <tbody>{node.runs.map((r) => <tr key={r.id}><td className="mono">{r.id}</td><td className="mono">{r.profile ?? '—'}</td><td>{RUN_STATE_LABEL[r.state]}</td><td>{formatTime(r.startedAt)}</td><td>{formatTime(r.endedAt)}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
    </li>
  );
}

function CancellationSection({ deptId, questId, status, tasks }: { deptId: string; questId: string; status: QuestStatus; tasks: TaskNode[] }) {
  const s = useStore();
  const extra = s.extra[questId];
  const c = extra?.cancellation ?? s.details[questId]?.cancellation ?? null;
  const v = c ? cancellationView(c, tasks) : null;
  const busy = !!s.busy[`cancel:${questId}`];
  const [confirming, setConfirming] = useState(false);
  const poll = extra?.poll ?? 'idle';
  return (
    <section className="cancel-sec" aria-labelledby={`cx-${questId}`}>
      <div aria-live="polite">
        {v && c && (
          <div className={`banner ${v.tone === 'good' ? 'good' : 'warn'} inline-b`}>
            <Glyph k={v.tone === 'good' ? 'completed' : 'blocked'} />
            <div>
              <b id={`cx-${questId}`}>{v.headline}</b>
              <KV rows={[['State', c.state], ['Requested', formatTime(c.requestedAt)], ['Confirmed', formatTime(c.confirmedAt)]]} />
              {poll === 'polling' && <p className="muted small">Checking with Hermes…</p>}
              {poll === 'timeout' && <p className="muted small">Not confirmed yet after two minutes. The board keeps refreshing on Hermes events; you can request again.</p>}
              {poll === 'hermes_down' && <p className="muted small">Stopped checking: Hermes or the backend is not reachable. The state above is the last one received.</p>}
              {v.remaining.length > 0 && <><h4 className="mini-h">Still stopping ({v.remaining.length})</h4><ul className="ids">{v.remaining.map((r) => <li key={r.id}><span className="mono">{r.id}</span> {r.title} · {r.status}</li>)}</ul></>}
              {v.archived.length > 0 && <><h4 className="mini-h">Archived by Vibe City ({v.archived.length})</h4><ul className="ids">{v.archived.map((r) => <li key={r.id}><span className="mono">{r.id}</span> {r.title}</li>)}</ul><p className="fine">Archived unfinished tasks cannot be dispatched again. Create a new quest to redo the work.</p></>}
              {v.finished.length > 0 && <><h4 className="mini-h">Already finished, left untouched ({v.finished.length})</h4><ul className="ids">{v.finished.map((r) => <li key={r.id}><span className="mono">{r.id}</span> {r.title}</li>)}</ul><p className="fine">Their summaries and files stay in Results.</p></>}
            </div>
          </div>
        )}
      </div>
      {canCancel(status) && !confirming && (
        <Btn kind="destructive" busy={busy} disabled={busy || !s.conn.hermes} onClick={() => setConfirming(true)}>{busy ? 'Requesting…' : c?.state === 'requested' ? 'Request cancellation again' : 'Cancel quest…'}</Btn>
      )}
      {confirming && (
        <div className="confirm" role="group" aria-labelledby={`cc-${questId}`}>
          <b id={`cc-${questId}`}>Cancel this quest?</b>
          <ul className="conseq">{CANCEL_CONFIRM.map((t) => <li key={t}>{t}</li>)}</ul>
          <div className="row"><Btn kind="destructive" busy={busy} disabled={busy} onClick={() => { setConfirming(false); void cancelQuest(deptId, questId); }}>Yes, cancel the quest</Btn><Btn onClick={() => setConfirming(false)}>Keep it running</Btn></div>
        </div>
      )}
      {canCancel(status) && !s.conn.hermes && <small className="muted">Cancelling needs Hermes to be reachable.</small>}
    </section>
  );
}

function ResultsSection({ status, extra }: { status: QuestStatus; extra: ReturnType<typeof useStore.getState>['extra'][string] | undefined }) {
  const r = extra?.results;
  const withOutput = r?.tasks.filter((t) => t.summary || t.error || t.attachments.length) ?? [];
  const silent = (r?.tasks.length ?? 0) - withOutput.length;
  return (
    <section className="pane-sec" aria-busy={extra?.loading}>
      {extra?.loading && !r && <p className="muted">Loading…</p>}
      {r && (
        <>
          {status === 'cancelling' || status === 'cancelled' ? <p className="fine">Results of tasks that finished before the cancellation are kept below.</p> : null}
          {r.chiefSummary ? <><h3 className="sec-t">Summary from the chief</h3><p className="box-p">{r.chiefSummary}</p></> : status !== 'completed' && <div className="empty"><Icon n="file" size={40} sw={1.5} /><b>Nothing final yet</b><p>The chief’s summary and any files appear as tasks finish. The quest is complete only when every task is done.</p></div>}
          {withOutput.map((t) => (
            <div key={t.taskId} className="stack">
              <h3 className="sec-t">{t.title} <span className="mono muted small">{t.role} · {t.status} · {t.taskId}</span></h3>
              {t.summary && <p className="box-p">{t.summary}</p>}
              {t.error && <p className="err-t"><Glyph k="failed" /> {t.error}</p>}
              {t.attachments.map((a) => (
                <div key={a.id} className="file"><span className="file-ic"><Icon n="file" /></span>
                  <span className="grow"><b>{a.filename}</b><small className="mono muted">{formatBytes(a.size)}{a.contentType ? ` · ${a.contentType}` : ''} · {formatTime(a.createdAt)} · from {t.title}</small></span>
                  <a className="btn tertiary" href={a.downloadUrl} download={a.filename} aria-label={`Download ${a.filename}`}><Icon n="download" size={14} />Download</a></div>
              ))}
            </div>
          ))}
          {silent > 0 && <p className="muted small">{silent} task{silent === 1 ? ' has' : 's have'} no summary, error or file yet.</p>}
        </>
      )}
    </section>
  );
}

/* ============ B1 · create department ============ */
export function CreateDeptModal() {
  const s = useStore();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  const open = s.ui.modal === 'create';
  useDialog(ref, open, () => s.ui$({ modal: null }));
  if (!open) return null;
  const busy = !!s.busy.create;
  const next = s.depts.length + 1;
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) s.ui$({ modal: null }); }}>
      <form ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby="cd-t" aria-busy={busy} onSubmit={(e) => { e.preventDefault(); if (name.trim() && !busy) void createDepartment(name.trim(), purpose.trim()); }}>
        <div className="head-row"><Where n={'F' + next} tone="amber">New floor</Where><button type="button" className="x" onClick={() => s.ui$({ modal: null })} aria-label="Close"><Icon n="x" /></button></div>
        <h2 id="cd-t" className="display">Create a department</h2>
        <p className="sub">Each department gets its own floor, a Hermes board, a chief and a worker profile. You provision them right after. A workspace path can be set later in the department settings.</p>
        <Field label="Department name" hint="Shown on the floor sign. Up to 32 characters. Must be unique.">
          {(p) => <input {...p} className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        <Field label="Purpose / objective" hint="The chief reads this when planning quests.">
          {(p) => <textarea {...p} className="input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
        </Field>
        <div className="preview"><svg width="58" height="28" viewBox="0 0 58 28" aria-hidden="true"><polygon points="2,4 36,20 56,10 56,16 36,26 2,10" fill="rgba(255,181,71,0.08)" stroke="#FFB547" strokeDasharray="3 2" /></svg><span><b>Adds floor F{next} · “{name || 'Untitled'}”</b><small><Glyph k="awaiting" />Starts not provisioned</small></span></div>
        <div className="row end"><Btn onClick={() => s.ui$({ modal: null })}>Cancel</Btn><button className="btn primary lg" type="submit" aria-busy={busy || undefined} disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create department'}</button></div>
      </form>
    </div>
  );
}
