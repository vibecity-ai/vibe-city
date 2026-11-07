import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_EXCLUDED_TOOLSETS, TOOLSETS, type AgentView, type HermesDefaultsView, type HermesModelsView, type ModelChoice, type QuestStatus, type SyncCheck, type TaskNode, type Toolset } from '@vibe-city/shared';
import { floorNum, useStore, type QuestItem } from '../store';
import type { Dept } from '../data/types';
import {
  archiveDepartment, cancelQuest, createDepartment, createQuest, fireAgent, loadAgent, setAgentModel, loadDeptInfo, loadHermesDefaults, loadHermesModels, loadQuest, patchInventory, provisionDepartment,
  checkDepartment, refreshAll, refreshOne, saveDepartmentSettings, stopCancellationPoll,
} from '../data/live';
import { clock } from '../data/derive';
import {
  GATEWAY_WARNING, age, attentionCount, blockedQuests, cardLines, companyQuests, defaultTarget, filterColumns, filterQuests, missingDepts, questTargets, searchSort,
  type BoardQuest, type BoardSort, type ColumnKey, type DeptOption,
} from '../data/company';
import {
  CANCEL_CONFIRM, LIMIT_COPY, PROVISIONING_STATE_LABEL, RESET_WARNING, SYNC_STEP_LABEL, agentLabel,
  archiveConsequences, assigneeWarning, cancellationView, fieldErrors, syncView,
  settingsFormFrom, settingsPatch, taskStatusView, settingsErrorField, type SettingsForm,
} from '../data/views';
import { STATUS, canCancel, formatBytes, formatTime, planningNote, requestIdFor, treeRows } from './format.ts';
import { Btn, Chip, Field, FloorKey, Glyph, Icon, KV, PixelSelect, Portrait, Tabs, Where, deptStatus, questStatus, statusColor, useDialog, type StatusKey } from './kit';
import { callAr } from './Hiring';
import { PendingRequests } from './Requests';
import { AgentName, AgentPortrait, AgentRecord, ChatTranscript, NeedsInput, PersonaLine, TaskSteps } from './AgentView';
import { SchedulesView } from './Schedules';


/* ============ top bar ============ */
export function TopBar() {
  const company = useStore((s) => s.company);
  const conn = useStore((s) => s.conn);
  const stale = useStore((s) => s.stale);
  const attn = useStore((s) => attentionCount(s.quests));
  const onBoard = useStore((s) => s.ui.panel === 'board');
  const openPanel = useStore((s) => s.openPanel);
  const closeFloor = useStore((s) => s.closeFloor);
  const pill = (ok: boolean, label: string) => (
    <span className={`led${ok ? '' : ' bad'}`} title={ok ? `${label} connected` : `${label} not responding`}><i aria-hidden="true" />{label}<span className="sr">{ok ? ' connected' : ' not responding'}</span></span>
  );
  const said = `Backend ${conn.backend ? 'connected' : 'not responding'}. Hermes ${conn.hermes ? 'connected' : 'not responding'}. Gateway ${conn.gateway ? 'running' : 'not running'}.${stale ? ' Showing out-of-date data.' : ''}`;
  return (
    <header className="top">
      <div className="logo"><span className="wordmark" data-t="VIBE CITY">VIBE CITY</span><span className="tag-line">Build your AI empire</span></div>
      <button className="plate" title="Back to the tower" onClick={closeFloor}>{company?.name ?? '…'}</button>
      <button className="btn secondary qb-btn" aria-pressed={onBoard} aria-label={`Quest board${attn > 0 ? `, ${attn} need attention` : ''}`} onClick={() => openPanel('board', { composer: false, boardDept: null })}>
        <span className="qb-long" aria-hidden="true">Quest board</span><span className="qb-short" aria-hidden="true">Quests</span>{attn > 0 && <span className="count bad" title="Quests that need attention" aria-hidden="true">{attn}</span>}
      </button>
      <span className="grow" />
      {stale && <span className="demo" title="The last refresh failed; floors show the last data received"><span>Out of date</span></span>}
      <div className="conn">{pill(conn.backend, 'Backend')}{pill(conn.hermes, 'Hermes')}{pill(conn.gateway, 'Gateway')}</div>
      <span className="sr" aria-live="polite">{said}</span>
    </header>
  );
}

/* ============ A · executive office ============ */
export function ExecPanel() {
  const { company, depts, ui$, openFloor, openPanel, loaded } = useStore();
  const running = depts.reduce((n, d) => n + d.workers.filter((w) => w.status === 'running').length + (d.chief?.status === 'running' ? 1 : 0), 0);
  const attention = depts.filter((d) => d.state === 'attention' || d.state === 'offline');
  const unconf = depts.filter((d) => d.state === 'unconfigured');
  const blocked = blockedQuests(useStore((s) => s.quests));
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <Where n="PH" tone="gold">Executive office</Where>
          <h1 className="display" tabIndex={-1}>{company?.name ?? 'Your company'}</h1>
          <p className="sub">{loaded ? 'Everything below is read from Hermes through the Vibe City backend.' : 'Connecting to the backend…'}</p>
          <div className="actions"><Btn kind="secondary" onClick={() => openPanel('board', { composer: false, boardDept: null })}>Quest board</Btn>
            <Btn kind="secondary" onClick={() => openPanel('board', { composer: true, composerDept: null, boardDept: null })}><Icon n="plus" sw={3} />New quest</Btn>
            <Btn kind="secondary" onClick={() => void callAr()}><Icon n="phone" size={14} />Call AR</Btn></div>
        </section>
        <div>
              <PendingRequests />
              <section className="pane-sec">
                <h3 className="sec-t">Company status</h3>
                <div className="tiles">
                  <div className="tile" style={{ ['--bar' as string]: '#9B5CFF' }}><b>{depts.length}</b><span>Departments</span></div>
                  <div className="tile" style={{ ['--bar' as string]: '#2EE6F0' }}><b>{running}<Glyph k="running" size={12} /></b><span>Agents running</span></div>
                  <div className="tile" style={{ ['--bar' as string]: '#FF5C7A' }}><b>{attention.length + blocked.length}<Glyph k="failed" size={12} /></b><span>Need attention</span></div>
                  <div className="tile" style={{ ['--bar' as string]: '#FFB547' }}><b>{unconf.length}<Glyph k="awaiting" size={12} /></b><span>Not synced</span></div>
                </div>
              </section>
              <section className="pane-sec">
                <h3 className="sec-t">Needs attention</h3>
                {[...attention, ...unconf].length === 0 && blocked.length === 0 && <p className="muted">Nothing needs you right now.</p>}
                <div className="stack">
                  {blocked.map((q) => {
                    const c = q.summary.counts;
                    const n = c.blocked + c.failed;
                    return (
                      <button key={q.summary.id} className="attn attention" onClick={() => openPanel('quest', { questId: q.summary.id, questFrom: 'board' })}>
                        <Glyph k="blocked" size={11} />
                        <span className="attn-t"><b>{q.summary.title}</b><small>{depts.find((d) => d.id === q.deptId)?.name ?? 'A floor'} · {c.blocked ? `${c.blocked} task${c.blocked === 1 ? '' : 's'} waiting for your input` : ''}{c.blocked && c.failed ? ' · ' : ''}{c.failed ? `${c.failed} stuck after failing` : ''}</small></span>
                        <span className="btn warn small">{n === 1 ? 'Answer' : 'Review'}</span>
                      </button>
                    );
                  })}
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
      </div>
      <div className="pane-foot"><button className="btn primary block lg" onClick={() => ui$({ newDept: true })}><Icon n="plus" sw={3} />Add department</button></div>
    </div>
  );
}

/* ============ D · department ============ */
export function DeptPanel() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  if (!d) return <ExecPanel />;
  const st = deptStatus(d.state);
  const quests = s.quests.filter((q) => q.deptId === d.id);
  const active = quests.filter((q) => ACTIVE.has(q.summary.status));
  const log = s.log.filter((l) => l.dept === d.id).slice(0, 8);
  const tab = s.ui.deptTab;
  const sel = s.ui.agent;
  const canWork = s.conn.hermes && d.provisioning === 'ready';
  const running = d.workers.filter((w) => w.status === 'running').length;
  const busyProv = syncing(s.busy, d);
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>Department</Where><button className="x" onClick={s.closeFloor} aria-label="Close floor"><Icon n="x" /></button></div>
          <div className="title-row"><h1 className="display" tabIndex={-1}>{d.name}</h1><Chip k={st.k} label={st.label} /></div>
          <p className="sub">{d.purpose}</p>
          <div className="actions">
            <button className="btn primary" disabled={!canWork} title={canWork ? '' : 'Needs the floor in sync with Hermes, and Hermes reachable'} onClick={() => s.openPanel('board', { composer: true, composerDept: d.id, boardDept: d.id, boardFilter: 'all' })}><Icon n="plus" sw={3} />New quest</button>
            <Btn kind="secondary" onClick={() => s.openPanel('board', { composer: false, boardDept: d.id })}>Quests on the board</Btn>
            <Btn kind="secondary" onClick={() => s.openPanel('settings')}><Icon n="sliders" size={14} />Settings</Btn>
            <Btn kind="secondary" onClick={() => void callAr(d.id)}><Icon n="phone" size={14} />Hire</Btn>
            <Btn kind="secondary" onClick={() => s.ui$({ execModal: 'calendar', scheduleDept: d.id })}>Schedules</Btn>
          </div>
          {!canWork && <p className="fine">{d.provisioning !== 'ready' ? 'New quests need the floor to be in sync with Hermes.' : 'New quests need Hermes to be reachable.'}</p>}
          {canWork && !s.conn.gateway && <p className="fine">The Hermes gateway is not running: new quests wait in Queued until it starts.</p>}
          <Tabs label="Department sections" idBase="dept" value={tab} onChange={(t) => s.ui$({ deptTab: t })}
            options={(['overview', 'loadout', 'quests'] as const).map((t) => ({ key: t, label: <>{t[0]!.toUpperCase() + t.slice(1)}{t === 'quests' && <span className="count">{active.length}</span>}</> }))} />
        </section>
        <div id="dept-panel" role="tabpanel" aria-labelledby={`dept-tab-${tab}`}>
          <div aria-live="polite">
            {s.liveDown[d.id] && <div className="banner warn"><Glyph k="disconnected" /><div><b>Live updates reconnecting</b><p>The live link to the backend dropped. The floor still refreshes every 30 seconds.</p></div></div>}
            {d.state === 'offline' && (
              <div className="banner bad"><Glyph k="disconnected" /><div><b>Hermes resources not verified</b><p>{d.attention}. Agents can’t receive new work until this floor is verified again.</p>
                <Btn kind="destructive" busy={busyProv} disabled={busyProv} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Syncing…' : 'Sync'}</Btn></div></div>
            )}
            {d.state === 'attention' && d.attention && d.provisioning !== 'error' && <div className="banner bad"><Glyph k="failed" /><div><b>Needs attention</b><p>{d.attention}</p></div></div>}
            {(d.provisioning === 'unconfigured' || d.provisioning === 'error' || busyProv) && <PendingSync d={d} />}
          </div>
          {tab === 'overview' && (
            <>
              <section className="pane-sec">
                <h3 className="sec-t">Chain of command</h3>
                {!d.chief && <p className="muted">No lead yet: the first sync creates {d.teamSize === 1 ? 'the lead’s Hermes profile' : `a Hermes profile for each of the ${d.teamSize} agents`}.</p>}
                {d.chief && <><button type="button" className={`chief-card${sel === 'chief' ? ' sel' : ''}`} aria-pressed={sel === 'chief'} onClick={() => s.openPanel('agent', { agent: 'chief' })}>
                  <span className="chief-top">
                    <Portrait shirt="#fff" chief size={44} />
                    <span>
                      <span className="chief-badges"><span className="role">Lead</span><Chip k={d.chief.status} small /></span>
                      <span className="chief-name"><AgentName deptId={d.id} agentKey="chief" /></span>
                      {d.chief.model && <span className="mono muted small">model · {d.chief.model}</span>}
                    </span>
                  </span>
                  <span className="chief-act"><span>{d.chief.activity}</span><span className="mono muted">since {d.chief.since}</span></span>
                </button>
                <div className="tree">
                  {d.workers.map((w) => (
                    <button key={w.id} className={`wrow${sel === w.id ? ' sel' : ''}`} aria-pressed={sel === w.id} onClick={() => s.openPanel('agent', { agent: w.id })}>
                      <Portrait shirt={w.shirt} size={28} />
                      <span className="wrow-t"><span><b><AgentName deptId={d.id} agentKey={w.id} /></b> <span className="muted">{w.task || 'No task'}</span></span>
                        <small style={{ color: statusColor(w.status) }}><Glyph k={w.status} />{w.taskId ? WORKER_WORD[w.status] : 'Free'} <span className="muted">· {w.status === 'completed' ? 'done' : 'since'} {w.since}</span></small>
                      </span>
                    </button>
                  ))}
                  {d.workers.length === 0 && <div className="empty-w">No teammates: the lead does the work itself. Hire to add agents that work in parallel.</div>}
                </div>
                <p className="mono muted small">{running + (d.chief.status === 'running' ? 1 : 0)} of {d.teamSize} agent{d.teamSize === 1 ? '' : 's'} working · each is its own Hermes profile{d.teamSize > d.workers.length + 1 ? ` · ${d.teamSize - d.workers.length - 1} not drawn (no free desk)` : ''}</p></>}
              </section>
              <section className="pane-sec">
                <h3 className="sec-t">Active quests</h3>
                {active.length === 0 && <p className="muted">No active quests. Give the lead an objective.</p>}
                <div className="stack">{active.map((q) => <QuestMini key={q.summary.id} q={q} />)}</div>
              </section>
              <section className="pane-sec">
                <h3 className="sec-t">Live activity</h3>
                {log.length === 0 && <p className="muted small">Events from Hermes appear here as they happen.</p>}
                <ol className="feed">{log.map((l, i) => <li key={i}><span className="mono muted">{l.t}</span><Glyph k={(l.kind === 'chief' ? 'awaiting' : l.kind) as StatusKey} /><span>{l.text}</span></li>)}</ol>
              </section>
            </>
          )}
          {tab === 'loadout' && <DeptLoadout d={d} />}
          {tab === 'quests' && (
            <section className="pane-sec">
              <p className="fine">You give and manage quests on the company quest board. This department’s own Hermes board belongs to its agents; this list is read-only.</p>
              {s.questSync[d.id] === 'not_loaded' && <p className="field-err"><Glyph k="disconnected" />Quests for this department are not loaded yet, so this list is incomplete.</p>}
              <div className="stack">{quests.map((q) => <QuestMini key={q.summary.id} q={q} />)}{quests.length === 0 && s.questSync[d.id] !== 'not_loaded' && <p className="muted">No quests yet.</p>}</div>
              <Btn kind="secondary" onClick={() => s.openPanel('board', { composer: false, boardDept: d.id })}>Open on the quest board</Btn>
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
    <button className={`qmini ${x.status}`} onClick={() => openPanel('quest', { questId: x.id, questFrom: 'dept' })}>
      <span className="qmini-top"><b>{x.title}</b></span>
      <span className="qmini-bot"><Chip k={questStatus(x.status)} label={STATUS[x.status].label} small /><span className="muted small">{x.counts.done}/{x.counts.tasks} tasks done · {clock(x.createdAt)}</span></span>
    </button>
  );
}

/** A sync started here, or one already running on the server (background check, another tab, before a reload). */
const syncing = (busy: Record<string, true>, d: Dept) => !!busy[`provision:${d.id}`] || d.provisioning === 'provisioning';
/** Unsynced edits of a floor: what Hermes would change, read again a moment after the last edit, and one Sync for all of it. */
function PendingSync({ d }: { d: Dept }) {
  const s = useStore();
  const busy = syncing(s.busy, d);
  const checking = !!s.busy[`check:${d.id}`];
  const [check, setCheck] = useState<SyncCheck | null>(null);
  // Only edits change this. Not updatedAt: a check stamps verification times on the row, so keying on it re-checks forever.
  const edits = JSON.stringify([s.info[d.id]?.inventory ?? null, d.name, d.purpose, d.view.agents.map((a) => [a.key, a.model?.id ?? null])]);
  useEffect(() => {
    setCheck(null);
    if (busy || (d.provisioning !== 'unconfigured' && d.provisioning !== 'error') || !s.conn.hermes) return;
    // wait for a pause in editing, so a run of toggles costs one read of Hermes
    const t = setTimeout(() => void checkDepartment(d.id).then((r) => r && setCheck(r)), 1500);
    return () => clearTimeout(t);
  }, [d.id, edits, d.provisioning, busy, s.conn.hermes]);
  const diffs = check?.differences ?? [];
  const err = d.provisioning === 'error' ? s.info[d.id]?.provisioning?.error ?? null : null;
  return (
    <div className={`banner ${err && !busy ? 'bad' : 'warn'}`}><Glyph k={err && !busy ? 'failed' : 'awaiting'} /><div>
      <b>{busy ? 'Syncing with Hermes…' : err ? `${SYNC_STEP_LABEL[err.step]} failed` : d.chief ? 'Changes not synced yet' : 'Not in Hermes yet'}</b>
      {err && !busy && <p>{err.message} <span className="muted">{formatTime(err.at)} · {err.retryable ? 'can be retried' : 'change the configuration first'}</span></p>}
      <p>{d.chief ? 'Agents keep their previous configuration until you sync.' : `Syncing creates a Kanban board and ${d.teamSize === 1 ? 'the lead’s Hermes profile' : `${d.teamSize} Hermes profiles, one per agent`}, then applies the loadout. It can take a minute.`} Make all your edits in the Loadout tab, then sync once.</p>
      {!busy && (checking || !check ? <p className="muted small" role="status">{s.conn.hermes ? 'Comparing with Hermes…' : 'Hermes is not reachable, so changes cannot be listed.'}</p>
        : <ul className="sync-list">{diffs.length ? diffs.map((x) => <li key={x}><Glyph k="awaiting" size={12} />{x}</li>) : <li><Glyph k="completed" size={12} />Nothing to change in Hermes</li>}</ul>)}
      <Btn kind="primary" busy={busy} disabled={busy || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busy ? 'Syncing…' : diffs.length ? `Sync ${diffs.length} change${diffs.length === 1 ? '' : 's'}` : 'Sync'}</Btn>
    </div></div>
  );
}

const teamLine = (n: number) => (n <= 1 ? '1 · the lead works alone' : `${n} · a lead + ${n - 1} teammate${n === 2 ? '' : 's'}, one Hermes profile each`);

/** The department's loadout: what every agent gets by default (skills, model, toolsets, MCP tools) and its limits.
    Installed skills and toolset states are read back from the lead's profile. */
function DeptLoadout({ d }: { d: Dept }) {
  const s = useStore();
  useEffect(() => { void loadAgent(d.id, 'chief'); }, [d.id, d.provisioning]);
  const info = s.info[d.id];
  const inv = info?.inventory ?? null;
  const eff = info?.effective ?? null;
  const view = s.agents[`${d.id}:chief`]?.view ?? null;
  const busyProv = syncing(s.busy, d);
  const saving = !!s.busy[`inv:${d.id}`] || busyProv; // edits during a sync would fail its final check
  const save = (p: Parameters<typeof patchInventory>[1]) => void patchInventory(d.id, p);
  const allowed = new Set(inv?.allowedSkillIds ?? []);
  const toggleSkill = (n: string) => inv && save({ allowedSkillIds: allowed.has(n) ? inv.allowedSkillIds.filter((x) => x !== n) : [...inv.allowedSkillIds, n] });
  const observedTools = new Map((view?.toolsets ?? []).map((t) => [t.name, t.enabled]));
  // model -> the agents on it: the agent's own choice, else the department's, else what Hermes reports for the profile
  const modelsInUse = new Map<string, string[]>();
  for (const a of d.view.agents) {
    const m = a.model?.id ?? inv?.model?.id ?? info?.profiles?.agents.find((p) => p.key === a.key)?.model ?? 'Hermes default';
    modelsInUse.set(m, [...(modelsInUse.get(m) ?? []), a.key]);
  }
  return (
    <div aria-busy={saving}>
      <section className="pane-sec">
        <div aria-live="polite">
          {s.busy[`inv:${d.id}`] && <p className="muted small" role="status">Saving…</p>}
          {d.provisioning === 'ready' && eff && !eff.inSync && <div className="banner warn"><Glyph k="awaiting" /><div><b>Hermes no longer matches</b><p>The last read from Hermes differs from this loadout.</p><Btn kind="secondary" busy={busyProv} disabled={busyProv || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Syncing…' : 'Sync again'}</Btn></div></div>}
        </div>
        <p className="fine">Every agent on this floor gets these skills, toolsets and MCP tools by default. An agent’s own skills from its hire come on top, and each agent has its own model.</p>
        <KV rows={[['Agents', teamLine(d.teamSize)]]} />
        {!inv && <p className="muted">Loading loadout…</p>}
      </section>
        <section className="pane-sec">
          <h3 className="sec-t">Skills</h3>
          <p className="fine">Every agent of the department gets these skills, plus any of its own from its hire. Changes apply when you sync again.</p>
          {!view?.observedAt && <p className="muted small">Hermes has not reported the installed skills yet (sync the department first). Allowed: {inv?.allowedSkillIds.join(', ') || 'none'}.</p>}
          {view && view.skills.length > 0 && (() => {
            const isOn = (k: { name: string; essential: boolean }) => k.essential || allowed.has(k.name);
            const card = (k: AgentView['skills'][number]) => {
              const on = isOn(k);
              const pending = !k.essential && on !== k.enabled; // saved here, not in Hermes until the next sync
              return (
                <div key={k.name} className={`skill${on ? ' on' : ''}${pending ? ' pending' : ''}`}>
                  <span className="mono">{k.name}</span>
                  <small className={pending ? 'pending-t' : 'muted'}>{k.essential ? 'always on in Hermes' : pending ? `turns ${on ? 'on' : 'off'} at the next sync` : `${k.enabled ? 'on' : 'off'} in the lead’s profile`}</small>
                  <button className={`toggle${on ? ' on' : ''}`} disabled={saving || k.essential || !inv} aria-pressed={on} aria-label={`${k.name}: ${on ? 'allowed' : 'not allowed'}`} onClick={() => toggleSkill(k.name)}><i /></button>
                </div>
              );
            };
            // grouped by what Hermes has, so a toggled skill stays put (in amber) until the sync moves it
            const inHermes = (k: { enabled: boolean; essential: boolean }) => k.essential || k.enabled;
            const active = view.skills.filter(inHermes), rest = view.skills.filter((k) => !inHermes(k));
            return (
              <>
                <div className="skill-grid">{active.map(card)}</div>
                {rest.length > 0 && <details className="more"><summary>Installed in Hermes ({rest.length})</summary><div className="skill-grid">{rest.map(card)}</div></details>}
              </>
            );
          })()}
          {inv && view && inv.allowedSkillIds.filter((n) => !view.skills.some((k) => k.name === n)).map((n) => <p key={n} className="field-err small"><Glyph k="awaiting" />{n} is allowed but not installed in Hermes.</p>)}
        </section>

        <section className="pane-sec">
          <h3 className="sec-t">Models in use</h3>
          <p className="fine">Each agent picks its own model in its Loadout tab. Hermes cannot stop an agent from picking another model for a task.</p>
          <ul className="models-used">{[...modelsInUse].map(([m, keys]) => (
            <li key={m}><span className="mono">{m}</span><span className="muted small">{keys.map((k, i) => <span key={k}>{i ? ', ' : ''}<AgentName deptId={d.id} agentKey={k} /></span>)}</span></li>
          ))}</ul>
        </section>

        <section className="pane-sec">
          <h3 className="sec-t">Toolsets</h3>
          <p className="fine">Every agent of the department gets these toolsets. Switched off in Hermes unless allowed. Changes apply when you sync again.</p>
          <div className="slot-grid">
            {TOOLSETS.filter(shownToolset).map((t) => {
              const allowedT = !!inv?.allowedToolsets.includes(t);
              const inHermes = observedTools.get(t);
              const pending = inHermes !== undefined && allowedT !== inHermes;
              return (
                <div key={t} className={`slot-card ${allowedT ? '' : 'disabled'}${pending ? ' pending' : ''}`}>
                  <div className="slot-top"><span className="slot-ic"><Icon n="plug" size={15} /></span>
                    <button className={`toggle${allowedT ? ' on' : ''}`} disabled={saving || !inv} aria-label={`${t}: ${allowedT ? 'allowed' : 'not allowed'}`} aria-pressed={allowedT}
                      onClick={() => inv && save({ allowedToolsets: allowedT ? inv.allowedToolsets.filter((x) => x !== t) : [...inv.allowedToolsets, t] })}><i /></button></div>
                  <div className="slot-name mono">{t}</div>
                  <div className={`slot-desc${pending ? ' pending-t' : ''}`}>{pending ? `turns ${allowedT ? 'on' : 'off'} at the next sync` : inHermes === undefined ? 'not reported by Hermes' : inHermes ? 'on in Hermes' : 'off in Hermes'}</div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="pane-sec">
          <h3 className="sec-t">MCP tools</h3>
          <ListEditor label="MCP tools" hint="server:tool, or a bare server id for the whole server. Saved for every agent; not applied in Hermes yet." values={inv?.allowedMcpTools ?? []} disabled={saving || !inv} onSave={(v) => save({ allowedMcpTools: v })} />
        </section>

      {inv && (
        <section className="pane-sec">
          <h3 className="sec-t">Limits</h3>
          <p className="fine">{LIMIT_COPY.teammates} To add an agent, hire through AR.</p>
          <Field label="Max seconds for the quest task (10–86400, blank = none)" hint={LIMIT_COPY.maxTaskRuntimeSeconds}>
            {(p) => <input {...p} className="input mono" type="number" min={10} max={86400} defaultValue={inv.limits.maxTaskRuntimeSeconds ?? ''} key={String(inv.limits.maxTaskRuntimeSeconds)} disabled={saving}
              onBlur={(e) => { const v = e.target.value.trim(); const n = v === '' ? null : Math.round(Number(v)); if ((n === null || (n >= 10 && n <= 86400)) && n !== inv.limits.maxTaskRuntimeSeconds) save({ limits: { maxTaskRuntimeSeconds: n } }); else e.target.value = String(inv.limits.maxTaskRuntimeSeconds ?? ''); }} />}
          </Field>
        </section>
      )}
    </div>
  );
}

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

/* ============ G · department settings, Hermes sync, archive ============ */
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
        <SettingsForm key={`${d.id}|${d.name}|${d.purpose}`} d={d} />
        <SyncInspector d={d} />
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
  const set = (p: Partial<SettingsForm>) => { setF({ ...f, ...p }); setErrs({}); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!patch || busy) return;
    const err = await saveDepartmentSettings(d.id, patch);
    if (!err) return;
    setErrs(err.issues.length ? fieldErrors(err.issues, ['name', 'purpose']) : { [settingsErrorField(err.message)]: err.message });
  };
  return (
    <form className="pane-sec" onSubmit={submit} aria-busy={busy} noValidate>
      <h3 className="sec-t">Details</h3>
      <div className="banner warn inline-b"><Glyph k="awaiting" /><div><p>{RESET_WARNING}</p></div></div>
      <Field label="Department name" hint="Up to 80 characters. Unique among active departments." error={errs.name}>
        {(p) => <input {...p} className="input" value={f.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Purpose / objective" hint="Every agent reads this when it works on quests." error={errs.purpose}>
        {(p) => <textarea {...p} className="input" rows={3} maxLength={2000} value={f.purpose} onChange={(e) => set({ purpose: e.target.value })} />}
      </Field>
      {errs.form && <p className="field-err" role="alert"><Glyph k="failed" />{errs.form}</p>}
      <div className="row"><button className="btn primary" type="submit" disabled={!patch || busy} aria-busy={busy || undefined}>{busy ? 'Saving…' : 'Save changes'}</button>
        {patch && <Btn onClick={() => { setF(settingsFormFrom(d)); setErrs({}); }} disabled={busy}>Discard</Btn>}</div>
    </form>
  );
}

/** Hermes profiles of the floor. Refresh compares Hermes with the floor (nothing changes); Sync shows only when they differ. */
function SyncInspector({ d }: { d: Dept }) {
  const s = useStore();
  const info = s.info[d.id];
  const prov = info?.provisioning ?? null;
  const profiles = info?.profiles ?? null;
  const [check, setCheck] = useState<SyncCheck | null>(null);
  // a sync (or an edit) makes an earlier comparison stale
  useEffect(() => setCheck(null), [prov?.attempts, d.view.updatedAt]);
  const view = syncView(prov, check);
  const busy = syncing(s.busy, d);
  const checking = !!s.busy[`check:${d.id}`];
  const syncRows: [string, boolean][] = [
    ...(prov?.agents ?? []).map((a): [string, boolean] => [
      `${agentLabel(a.key, s.personas[`${d.id}:${a.key}`])}${a.ref ? '' : ' · no profile yet'}`,
      a.verified && profiles?.agents.find((p) => p.key === a.key)?.exists !== false,
    ]),
    ['Board', !!prov?.board.verified && d.view.boardSyncState === 'synced'],
  ];
  return (
    <section className="pane-sec" aria-labelledby="pi-h">
      <h3 className="sec-t" id="pi-h">Hermes profiles</h3>
      <div aria-live="polite" role="status" className="prov-state">
        {prov ? <><Chip k={prov.state === 'ready' && check?.inSync !== false ? 'completed' : prov.state === 'error' ? 'failed' : prov.state === 'disconnected' ? 'disconnected' : prov.state === 'provisioning' ? 'running' : 'awaiting'} label={prov.state === 'ready' && check?.inSync === false ? 'Out of sync' : PROVISIONING_STATE_LABEL[prov.state]} />
          <span className="muted small">last checked {formatTime(prov.lastReconciledAt)}</span></> : <span className="muted">Loading…</span>}
      </div>
      {info?.infoError && <p className="field-err" role="alert"><Glyph k="failed" />Could not refresh profile details: {info.infoError}{profiles ? ' Showing the last data received.' : ''}</p>}
      {prov?.error && (
        <div className="banner bad inline-b" role="alert"><Glyph k="failed" /><div><b>{prov.error.message}</b>
          <KV rows={[['Step', SYNC_STEP_LABEL[prov.error.step]], ['Can be tried again', prov.error.retryable ? 'Yes' : 'No: change the configuration first'], ['At', formatTime(prov.error.at)]]} /></div></div>
      )}
      {check && !check.inSync && check.differences.length > 0 && (
        <ul className="sync-list">{check.differences.map((x) => <li key={x}><Glyph k="awaiting" size={12} />{x}</li>)}</ul>
      )}
      {prov && (
        <ul className="sync-list">
          {syncRows.map(([label, ok]) => (
            <li key={label}><Glyph k={ok ? 'completed' : 'awaiting'} size={12} />{label} {ok ? 'synced' : 'not synced'}</li>
          ))}
        </ul>
      )}
      {view.hint && <p className="fine">{view.hint}</p>}
      <div className="row wrap">
        {view.sync && <Btn kind="primary" busy={busy} disabled={busy || checking || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busy ? 'Syncing…' : 'Sync'}</Btn>}
        <Btn busy={checking} disabled={checking || busy} onClick={() => void checkDepartment(d.id).then((r) => r && setCheck(r))}><Icon n="refresh" size={14} />{checking ? 'Checking Hermes…' : 'Refresh'}</Btn>
      </div>
      {view.sync && !s.conn.hermes && <small className="muted">Hermes is not reachable, so syncing is disabled.</small>}
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
/** Hermes' model list, loaded once per mount. `reload` re-reads it (e.g. after Hermes came back). */
function useHermesModels() {
  const [models, setModels] = useState<HermesModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    setError(null);
    const { value, error: e } = await loadHermesModels();
    if (value) setModels(value); else setError(e?.message ?? 'Could not read the model list from Hermes.');
  };
  useEffect(() => { void reload(); }, []);
  return { models, error, reload };
}

const modelKey = (m: ModelChoice | null) => (m ? `${m.provider}\u0000${m.id}` : '');

/**
 * One model, chosen from Hermes' list (grouped by provider). A saved choice Hermes no longer offers stays visible,
 * marked, so it is never silently replaced.
 */
function ModelPicker({ label, hint, models, error, onRetry, value: chosen, fallback, onChange, disabled }: {
  label: string; hint: string; models: HermesModelsView | null; error: string | null; onRetry: () => void;
  value: ModelChoice | null; onChange: (m: ModelChoice | null) => void; disabled?: boolean;
  /** The model in use without a choice: shown instead of a "keep" option. */
  fallback?: ModelChoice | null;
}) {
  const value = chosen ?? fallback ?? null;
  const offered = !value || !models || models.providers.some((p) => p.slug === value.provider && p.models.includes(value.id));
  return (
    <Field label={label} hint={hint} error={error ? `${error}` : !offered ? `${value!.id} (${value!.provider}) is not in Hermes’ list anymore. Choose another model.` : null}>
      {(p) => (
        <div className="row model-pick">
          <PixelSelect {...p} mono disabled={disabled || !models} value={modelKey(value)}
            placeholder={error ? 'Model list unavailable' : 'Loading models from Hermes…'}
            onChange={(v) => {
              if (!v) return onChange(null);
              const [provider, id] = v.split('\u0000');
              onChange({ provider: provider!, id: id! });
            }}
            options={!models ? [] : [
              ...(fallback === undefined ? [{ value: '', label: 'Keep the profile’s own model' }] : []),
              ...(!offered ? [{ value: modelKey(value), label: `${value!.id} · ${value!.provider}`, note: 'not offered' }] : []),
              ...models.providers.flatMap((pr) => pr.models.map((m) => ({ value: modelKey({ provider: pr.slug, id: m }), label: m, group: `${pr.name}${pr.current ? ' · current provider' : ''}` }))),
            ]} />
          {error && <button type="button" className="link" onClick={onRetry}>Retry</button>}
        </div>
      )}
    </Field>
  );
}

/* ============ H · agent view ============ */
/* Opens when you click a person on the floor (or in the chain of command). Every person is one agent with its own
   Hermes profile: the lead (key `chief`), or a teammate (W-01…). */
export function AgentPanel() {
  const s = useStore();
  const d = s.depts.find((x) => x.id === s.ui.floorId);
  const sel = s.ui.agent;
  const role = sel === 'chief' ? 'chief' : 'worker';
  const worker = d && sel !== 'chief' ? d.workers.find((w) => w.id === sel) ?? null : null;
  const id = d?.id;
  const loadKey = sel === 'chief' ? 'chief' : worker?.id ?? null;
  useEffect(() => { if (id && loadKey) void loadAgent(id, loadKey); }, [id, loadKey, d?.provisioning]);
  useEffect(() => { if (id) void loadDeptInfo(id); }, [id]);
  const [tab, setTab] = useState<'now' | 'chat' | 'loadout' | 'record' | 'schedule'>('now');
  const [firing, setFiring] = useState(false);
  const agentKey = loadKey;
  const hermesModels = useHermesModels();
  if (!d) return null;
  const a = agentKey ? s.agents[`${d.id}:${agentKey}`] : undefined;
  const me = d.view.agents.find((x) => x.key === agentKey) ?? null;
  const view = a?.view ?? null;
  const inv = s.info[d.id]?.inventory ?? null;
  const saving = !!s.busy[`inv:${d.id}`];
  const busyProv = syncing(s.busy, d);
  const wasProvisioned = !!s.info[d.id]?.provisioning?.inventory.appliedAt;
  const name = agentLabel(agentKey, agentKey ? s.personas[`${d.id}:${agentKey}`] : null);
  const status = role === 'chief' ? d.chief?.status ?? 'awaiting' : worker?.status ?? 'idle';
  // This agent's tasks among the quests loaded for this floor: everything assigned to its own profile.
  const mine = Object.values(s.details).filter((q) => s.quests.some((x) => x.deptId === d.id && x.summary.id === q.id))
    .flatMap((q) => q.tasks.map((t) => ({ t, questId: q.id })))
    .filter(({ t }) => agentKey !== null && t.agentKey === agentKey);
  const tasks = mine.sort((x, y) => (y.t.createdAt ?? '').localeCompare(x.t.createdAt ?? '')).slice(0, 6);
  // The task whose steps the Now tab shows: the one it is working on, else its latest.
  const focusItem = mine.find(({ t }) => t.status === 'running') ?? mine.find(({ t }) => t.status === 'blocked') ?? tasks[0] ?? null;
  const focus = focusItem?.t ?? null;
  return (
    <div className="pane">
      <div className="pane-scroll">
        <section className="pane-head">
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>{d.name}</Where><button className="x" onClick={() => s.openPanel('dept')} aria-label="Close agent"><Icon n="x" /></button></div>
          <div className="agent-head">
            {agentKey ? <AgentPortrait deptId={d.id} agentKey={agentKey} shirt={worker?.shirt ?? '#FFFFFF'} status={status} /> : <Portrait shirt={worker?.shirt ?? '#fff'} chief={role === 'chief'} size={56} />}
            <div>
              <div className="title-row"><h1 className="display sm" tabIndex={-1}>{name}</h1><Chip k={status} /></div>
              {agentKey && <PersonaLine deptId={d.id} agentKey={agentKey} />}
              <p className="muted small">{role === 'chief' ? 'Lead' : 'Teammate'}{view?.profileRef ?? me?.profileRef ? '' : ' · not synced yet'}</p>
              <p className="mono small">model · {view?.model ?? '—'}{view?.observedAt && <span className="muted"> · read from Hermes {formatTime(view.observedAt)}</span>}</p>
              {(role === 'chief' ? !!d.chief : !!worker) && <button className="btn primary small" style={{ marginTop: 8 }} onClick={() => s.ui$({ talk: { deptId: d.id, agentKey: role === 'chief' ? 'chief' : worker!.id } })}>Talk</button>}
              {worker && !firing && <button className="btn destructive small" style={{ marginTop: 8, marginLeft: 8 }} disabled={worker.status === 'running' || !!s.busy[`fire:${d.id}`]} title={worker.status === 'running' ? 'Wait until this agent finishes its task' : ''} onClick={() => setFiring(true)}>Fire</button>}
            </div>
          </div>
        </section>
        {worker && firing && agentKey && (
          <div className="banner bad" role="alertdialog" aria-labelledby="fire-h"><Glyph k="failed" /><div>
            <b id="fire-h">Fire {name}?</b>
            <p>{name} leaves {d.name} and the team stops handing them work. Their Hermes profile, memory and sessions are archived, not deleted, and past results stay on the board.</p>
            <div className="row"><Btn kind="destructive" busy={!!s.busy[`fire:${d.id}`]} disabled={!!s.busy[`fire:${d.id}`]} onClick={() => void fireAgent(d.id, agentKey, name).then((ok) => { setFiring(false); if (ok) s.openPanel('dept', { agent: null }); })}>Yes, fire {name}</Btn><Btn onClick={() => setFiring(false)}>Keep them</Btn></div>
          </div></div>
        )}
        <div aria-live="polite">
          {a?.error && <div className="banner bad" role="alert"><Glyph k="failed" /><div><b>{view ? 'Refresh failed: showing the last data received' : 'Could not load this agent'}</b><p>{a.error}</p><Btn kind="destructive" onClick={() => agentKey && void loadAgent(d.id, agentKey)}>Retry</Btn></div></div>}
          {d.provisioning === 'unconfigured' && wasProvisioned && <div className="banner warn"><Glyph k="awaiting" /><div><b>Needs syncing again</b><p>Saved changes are not in Hermes yet. The agent keeps its previous skills and model until you sync again.</p><Btn kind="secondary" busy={busyProv} disabled={busyProv || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Syncing…' : 'Sync again'}</Btn></div></div>}
        </div>

        <div className="pane-sec agent-tabs-wrap">
          <Tabs label="Agent sections" idBase="agent" value={tab} onChange={setTab}
            options={[{ key: 'now', label: 'Now' }, { key: 'chat', label: 'Chat' }, { key: 'loadout', label: 'Loadout' }, { key: 'record', label: 'Record' }, { key: 'schedule', label: 'Schedule' }]} />
        </div>
        <div id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${tab}`}>
        {tab === 'chat' && (agentKey ? <ChatTranscript deptId={d.id} agentKey={agentKey} sessions={view?.sessions ?? null} sessionsError={view?.sessionsError ?? null} /> : <section className="pane-sec"><p className="muted">Pick an agent to see its conversations.</p></section>)}
        {tab === 'record' && agentKey && <AgentRecord d={d} agentKey={agentKey} />}
        {tab === 'schedule' && (
          <section className="pane-sec">
            <h3 className="sec-t">Schedule</h3>
            <p className="fine">This floor's recurring quests. Each one lands on the lead's desk at its time, like a quest you create.</p>
            <SchedulesView deptId={d.id} />
          </section>
        )}
        {tab === 'now' && <>
        <section className="pane-sec">
          <h3 className="sec-t">Now</h3>
          {role === 'chief' && d.chief && <p>{d.chief.activity} <span className="mono muted small">since {d.chief.since}</span></p>}
          {role === 'worker' && worker && (worker.taskId
            ? <p><b>{worker.task}</b> <span className="mono muted small">· {worker.status === 'completed' ? 'done' : 'since'} {worker.since}</span></p>
            : <p className="muted">Free. Waiting for the lead to hand over a task.</p>)}
          {role === 'worker' && !worker && <p className="muted">This agent has no desk on the floor.</p>}
          <h4 className="mini-h">Latest activity</h4>
          {role === 'chief' && (
            <ul className="stack tight">{s.quests.filter((q) => q.deptId === d.id).slice(0, 5).map((q) => (
              <li key={q.summary.id}><button className="link" onClick={() => s.openPanel('quest', { questId: q.summary.id, questFrom: 'dept' })}><Glyph k={questStatus(q.summary.status)} /> {q.summary.title}</button> <span className="muted small">· quest {STATUS[q.summary.status].label.toLowerCase()} · {formatTime(q.summary.createdAt)}</span></li>
            ))}</ul>
          )}
          {(role === 'chief' ? !s.quests.some((q) => q.deptId === d.id) : tasks.length === 0) && <p className="muted small">{role === 'chief' ? 'No quests yet. Every quest goes to the lead first.' : 'Nothing yet.'}</p>}
          {role === 'worker' && <ul className="stack tight">{tasks.map(({ t, questId }) => {
            const v = taskStatusView(t);
            return <li key={t.id}><button className="link" onClick={() => s.openPanel('quest', { questId, questFrom: 'dept' })}><Glyph k={v.k} /> {t.title}</button> <span className="muted small">· {v.label} · {formatTime(t.completedAt ?? t.startedAt ?? t.createdAt)}</span></li>;
          })}</ul>}
        </section>
        {focus && agentKey && <section className="pane-sec">
          <h3 className="sec-t">Steps on “{focus.title}”</h3>
          {focus.status === 'blocked' && <NeedsInput deptId={d.id} questId={focusItem!.questId} node={focus} />}
          <TaskSteps key={focus.id} deptId={d.id} agentKey={agentKey} taskId={focus.id} />
        </section>}


        </>}
        {tab === 'loadout' && (
          <section className="pane-sec">
            <h3 className="sec-t">Loadout</h3>
            <p className="fine">This agent gets the department’s skills, toolsets and MCP tools.{me?.skills.length ? ' On top of that it has its own skills from its hire.' : ''}</p>
            {me && agentKey && <ModelPicker label="Model" hint={`Changes apply when you sync again.${view?.provider ? ` Hermes now reports ${view.model ?? '—'} via ${view.provider}.` : ''}`}
              models={hermesModels.models} error={hermesModels.error} onRetry={() => void hermesModels.reload()}
              value={me.model} fallback={inv?.model ?? (view?.model && view.provider ? { provider: view.provider, id: view.model } : null)} disabled={saving} onChange={(m) => void setAgentModel(d.id, agentKey, m)} />}
            {me && me.skills.length > 0 && <KV rows={[['Own skills', <span className="mono">{me.skills.join(', ')}</span>]]} />}
            {view?.observedAt && <KV rows={[
              ['Skills on in Hermes', <span className="mono">{view.skills.filter((k) => k.enabled).map((k) => k.name).join(', ') || 'none'}</span>],
              ['Toolsets on in Hermes', <span className="mono">{view.toolsets.filter((t) => t.enabled && shownToolset(t.name)).map((t) => t.name).join(', ') || 'none'}</span>],
            ]} />}
            <Btn kind="secondary" onClick={() => s.openPanel('dept', { deptTab: 'loadout' })}>Edit the department loadout</Btn>
          </section>
        )}
        </div>

      </div>
    </div>
  );
}

/* ============ E · company quest board ============ */
/* The player's one board. Department boards belong to the agents: each quest still lives on its department's Hermes
   board (assigned to its lead), and this view combines them. See data/company.ts for the rules. */
const COL_GLYPH: Record<ColumnKey, StatusKey> = { queued: 'todo', active: 'running', attention: 'blocked', finished: 'completed' };

/** Leaves the board (or a sheet opened from it) for the floor that is open, or the executive office. */
const backToPlace = () => { const s = useStore.getState(); s.openPanel(s.ui.view === 'floor' && s.ui.floorId ? 'dept' : 'exec'); };

export function QuestBoard() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('newest');
  const all = companyQuests(s.depts, s.quests);
  const f = s.ui.boardFilter;
  const dept = s.ui.boardDept && s.depts.some((d) => d.id === s.ui.boardDept) ? s.ui.boardDept : null;
  const by = s.ui.boardBy;
  const byOk = (q: BoardQuest) => { const o = s.origins[q.summary.id]?.origin ?? 'user'; return by === 'anyone' || o === by || (by === 'user' && o === 'market'); };
  const shown = searchSort(filterQuests(all, dept, f), query, sort).filter(byOk);
  const missing = missingDepts(s.depts, s.questSync, s.conn.hermes, dept);
  const targets = questTargets(s.depts, s.conn.hermes);
  const canCreate = targets.some((t) => !t.disabled);
  const withBoards = s.depts.filter((d) => s.questSync[d.id] !== 'no_board');
  const count = (k: typeof f) => searchSort(filterQuests(all, dept, k), query, sort).filter(byOk).length;
  const open = s.ui.boardQuest && s.quests.some((q) => q.summary.id === s.ui.boardQuest) ? s.ui.boardQuest : null;
  const leave = () => { s.ui$({ boardQuest: null }); backToPlace(); };
  return (
    <div className="pane sheet qb">
      <div className="pane-scroll">
        <section className="qb-head">
          <div className="qb-title">
            <Where n="PH" tone="gold">Company</Where>
            <h1 className="display" tabIndex={-1}>Quest board</h1>
            <p className="sync" aria-live="polite"><Icon n="refresh" size={12} />{withBoards.length === 0
              ? 'No department has a Hermes board yet. Sync a department to give it quests.'
              : `Read from ${withBoards.length} Hermes board${withBoards.length === 1 ? '' : 's'}`}</p>
            <div className="head-actions"><button className="btn primary" disabled={!canCreate} title={canCreate ? '' : 'No department can take a quest right now'} onClick={() => s.ui$({ composer: true, composerDept: dept })}><Icon n="plus" sw={3} />New quest</button><button className="x boxed" onClick={leave} aria-label="Close quest board"><Icon n="x" /></button></div>
          </div>
          <div className="qb-tools" role="toolbar" aria-label="Filter, search and sort quests">
            <div className="qb-dept"><PixelSelect value={dept ?? ''} onChange={(v) => s.ui$({ boardDept: v || null })} aria-describedby={undefined}
              options={[{ value: '', label: 'All departments' }, ...withBoards.map((d) => ({ value: d.id, label: `F${floorNum(s.depts, d.id)} · ${d.name}` }))]} /></div>
            <div className="seg-row" role="group" aria-label="Filter by status">
              {(['all', 'active', 'attention', 'finished'] as const).map((k) => <button key={k} aria-pressed={f === k} className={f === k ? 'on' : ''} onClick={() => s.ui$({ boardFilter: k })}>{{ all: 'All', active: 'Active', attention: 'Attention', finished: 'Finished' }[k]}<span className="count">{count(k)}</span></button>)}
            </div>
            <label className="qb-search"><Icon n="search" size={14} /><input className="input" type="search" placeholder="Search quests" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search quests by title or department" /></label>
            <div className="qb-by"><PixelSelect value={by} onChange={(v) => s.ui$({ boardBy: v as typeof by })} aria-describedby={undefined}
              options={[{ value: 'anyone', label: 'Assigned by anyone' }, { value: 'user', label: 'Assigned by you' }, { value: 'agent', label: 'Assigned by agents' }, { value: 'schedule', label: 'From schedules' }]} /></div>
            <div className="qb-sort"><PixelSelect value={sort} onChange={(v) => setSort(v as BoardSort)} aria-describedby={undefined}
              options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'title', label: 'Title A–Z' }]} /></div>
          </div>
        </section>
        <div aria-live="polite">
          {missing.length > 0 && (
            <div className={`banner qb-banner ${missing.some((m) => m.sync === 'not_loaded') ? 'bad' : 'warn'}`} role="status"><Glyph k="disconnected" />
              <div><b>{missing.some((m) => m.sync === 'not_loaded') ? 'Some quests are missing from this board' : 'Some quests may be out of date'}</b>{missing.map((m) => <p key={m.id}>{m.text}</p>)}</div></div>
          )}
        </div>
        {s.ui.composer && <QuestComposer targets={targets} />}
        <div className="board">
          {filterColumns(f).map((c) => {
            const list = shown.filter((q) => c.has(q.summary.status));
            const color = statusColor(COL_GLYPH[c.key]);
            return (
              <section key={c.key} className={`col${list.length ? '' : ' empty'}`} aria-label={`${c.title}: ${list.length}`} style={{ ['--col' as string]: color }}>
                <h2 className="col-h"><Glyph k={COL_GLYPH[c.key]} /><b>{c.title}</b><span className="col-n">{list.length}</span></h2>
                <div className="col-list">{list.map((q) => <QuestCard key={q.summary.id} q={q} open={open === q.summary.id} />)}</div>
                {list.length === 0 && <div className="col-empty">{query ? 'No match' : 'Nothing here'}</div>}
              </section>
            );
          })}
        </div>
      </div>
      {open && (
        <div className="qb-drawer-wrap">
          <button className="qb-scrim" aria-label="Close quest details" onClick={() => s.ui$({ boardQuest: null })} />
          <div className="qb-drawer"><QuestDetail id={open} drawer /></div>
        </div>
      )}
    </div>
  );
}

function QuestComposer({ targets }: { targets: DeptOption[] }) {
  const s = useStore();
  const [title, setTitle] = useState('');
  const [obj, setObj] = useState('');
  const [instr, setInstr] = useState('');
  const [dept, setDept] = useState<string | null>(() => defaultTarget(targets, s.ui.composerDept));
  const reqId = useRef<{ fingerprint: string; id: string } | null>(null);
  const target = targets.find((t) => t.id === dept && !t.disabled) ?? null;
  const busy = !!(target && s.busy[`quest:${target.id}`]);
  const close = () => s.ui$({ composer: false, composerDept: null });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !title.trim() || !obj.trim() || busy) return;
    reqId.current = requestIdFor(JSON.stringify([target.id, title.trim(), obj.trim(), instr.trim()]), reqId.current, () => crypto.randomUUID());
    const id = await createQuest(target.id, { clientRequestId: reqId.current.id, title: title.trim(), objective: obj.trim(), ...(instr.trim() && { instructions: instr.trim() }) });
    if (id) { setTitle(''); setObj(''); setInstr(''); reqId.current = null; close(); }
  };
  return (
    <form className="composer pane-sec" onSubmit={submit} aria-busy={busy} aria-labelledby="qc-h">
      <h3 className="sec-t" id="qc-h">New quest</h3>
      <Field label="Department" hint="The quest goes to this department’s lead, who plans it and hands parts to teammates on the department’s own board.">
        {(p) => (
          <PixelSelect {...p} value={dept ?? ''} onChange={(v) => setDept(v || null)} disabled={busy} placeholder="Choose a department…"
            options={targets.map((t) => ({ value: t.id, label: t.label, disabled: !!t.disabled, ...(t.disabled ? { note: t.disabled } : {}) }))} />
        )}
      </Field>
      <Field label="Quest title">{(p) => <input {...p} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
      <Field label="Objective">{(p) => <textarea {...p} className="input" rows={3} maxLength={8000} value={obj} onChange={(e) => setObj(e.target.value)} />}</Field>
      <Field label="Extra instructions (optional)">{(p) => <textarea {...p} className="input" rows={2} maxLength={8000} value={instr} onChange={(e) => setInstr(e.target.value)} />}</Field>
      {target ? <small className="muted">Assigned to <b className="gold-n">{target.chief ? <AgentName deptId={target.id} agentKey="chief" /> : 'the lead'}</b></small> : <small className="muted">Choose a department that is ready.</small>}
      {target && !s.conn.gateway && <p className="field-err"><Glyph k="awaiting" />{GATEWAY_WARNING}</p>}
      <div className="row"><button className="btn primary grow" type="submit" aria-busy={busy || undefined} disabled={busy || !target || !title.trim() || !obj.trim()}>{busy ? 'Creating…' : 'Create quest'}</button><Btn onClick={close} disabled={busy}>Cancel</Btn></div>
    </form>
  );
}

function QuestCard({ q, open }: { q: BoardQuest; open: boolean }) {
  const ui$ = useStore((s) => s.ui$);
  const detail = useStore((s) => s.details[q.summary.id]);
  const x = q.summary;
  const workers = detail?.tasks.filter((t) => t.depth > 0) ?? [];
  const lines = cardLines(detail?.tasks);
  const k = questStatus(x.status);
  const origin = useStore((s) => s.origins[x.id]);
  return (
    <button className={`qcard ${x.status}${open ? ' sel' : ''}`} style={{ ['--st' as string]: statusColor(k) }} aria-expanded={open}
      onClick={() => ui$({ boardQuest: x.id })} aria-label={`${x.title}, ${STATUS[x.status].label}, ${q.deptName}`}>
      <span className="qcard-h"><Glyph k={k} /><b>{x.title}</b></span>
      <span className="qcard-row">
        <span className="qcard-dept"><FloorKey n={q.floor} />{q.deptName}</span>
        {origin?.origin === 'agent' && origin.fromName && <span className="qcard-from" title={`Requested by ${origin.fromName}`}>from {origin.fromName}</span>}
        {origin?.origin === 'schedule' && <span className="qcard-from sched" title="Created by a schedule">scheduled</span>}
        {x.counts.tasks > 0 && <span className="qcard-tasks">{workers.length > 0 && <span className="pips" aria-hidden="true">{workers.slice(0, 8).map((t) => <Glyph key={t.id} k={taskStatusView(t).k} size={8} />)}</span>}{x.counts.done}/{x.counts.tasks}</span>}
        <span className="qcard-age mono" title={formatTime(x.createdAt)}>{age(x.createdAt)}</span>
      </span>
      <span className="qcard-more" aria-hidden={!lines.plan && !lines.latest}>
        <span className="qcard-st">{STATUS[x.status].label}</span>
        {lines.plan && <span className="qcard-line"><i>Plan</i>{lines.plan}</span>}
        {lines.latest && <span className={`qcard-line ${lines.latest.k}`}><Glyph k={lines.latest.k} size={8} />{lines.latest.text}</span>}
        {!lines.plan && !lines.latest && <span className="qcard-line muted">Open for the task tree and activity.</span>}
        {x.flags.unauthorizedAssignees && <span className="qcard-line failed"><Glyph k="awaiting" size={8} />Task outside this department</span>}
      </span>
    </button>
  );
}

/* ============ F · quest details ============ */
export function QuestDetail({ id, drawer }: { id?: string; drawer?: boolean } = {}) {
  const s = useStore();
  const qid = id ?? s.ui.questId;
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
          <div className="head-row">{drawer
            ? <button className="link" onClick={() => s.ui$({ boardQuest: null })}><Icon n="x" size={14} />Close</button>
            : s.ui.questFrom === 'dept' && s.ui.floorId
            ? <button className="link" onClick={() => s.openPanel('dept')}><Icon n="back" size={14} />{s.depts.find((x) => x.id === s.ui.floorId)?.name ?? 'Department'}</button>
            : <button className="link" onClick={() => s.openPanel('board')}><Icon n="back" size={14} />Quest board</button>}</div>
          <div className="title-row"><h1 className="display sm" tabIndex={-1}>{sum.title}</h1><Chip k={questStatus(sum.status)} label={STATUS[sum.status].label} /></div>
          <p className="meta"><span className="meta-f"><FloorKey n={'F' + floorNum(s.depts, item.deptId)} />{d?.name}</span><span>Lead <b className="gold-n">{d?.chief ? <AgentName deptId={d.id} agentKey="chief" /> : '—'}</b></span><span className="mono">{formatTime(sum.createdAt)}{sum.completedAt ? ` → ${formatTime(sum.completedAt)}` : ''}</span></p>
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
                  {detail.violations.length > 0 && <div className="banner bad inline-b"><Glyph k="failed" /><div><b>Tasks outside this department</b>{detail.violations.map((v) => <p key={v}>{v}</p>)}<p className="fine">Detected, not prevented: Hermes cannot stop an agent from creating them.</p></div></div>}
                  <h3 className="sec-t">Objective</h3><p className="box-p">{detail.objective || 'No objective written.'}</p>
                  <h3 className="sec-t">Tasks <span className="count">{detail.counts.done}/{detail.counts.tasks} done</span></h3>
                  <p className="mono muted small">{detail.counts.running} running · {detail.counts.pending} pending · {detail.counts.blocked} blocked · {detail.counts.failed} failed · {detail.counts.archived} archived</p>
                  <ul className="stack tasks">{treeRows(detail.tasks).map(({ node, depth }) => <TaskRow key={node.id} deptId={item.deptId} questId={sum.id} node={node} depth={depth} all={detail.tasks} />)}</ul>
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
                  <span><span>{e.label}</span> <small className="muted">{e.taskTitle}</small>{e.detail && <small className="err-t">{e.detail}</small>}</span></li>
              ))}</ol>
              {ACTIVE.has(sum.status) && <p className="muted small live"><Glyph k="running" />Live · refreshes when Hermes reports an event</p>}
            </section>
          )}
          {tab === 'results' && <ResultsSection deptId={item.deptId} status={sum.status} extra={extra} />}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ deptId, questId, node, depth, all }: { deptId: string; questId: string; node: TaskNode; depth: number; all: TaskNode[] }) {
  const [open, setOpen] = useState(node.status === 'blocked');
  const v = taskStatusView(node);
  const warn = assigneeWarning(node);
  const title = (id: string) => all.find((t) => t.id === id)?.title ?? id;
  const did = `task-${node.id}`;
  return (
    <li className={`trow-w${warn ? ' other' : ''}`} style={{ marginLeft: Math.min(depth, 6) * 16 }}>
      <button type="button" className="trow" aria-expanded={open} aria-controls={did} onClick={() => setOpen(!open)}>
        <Glyph k={v.k} /><span className="muted"><AgentName deptId={deptId} agentKey={node.agentKey} /></span><b>{node.title}</b>{warn && <span className="err small"><Glyph k="awaiting" />outside dept</span>}<span className="grow" />
        <span style={{ color: statusColor(v.k) }}>{v.label}</span><Icon n={open ? 'minus' : 'plus'} size={12} />
      </button>
      {open && (
        <div id={did} className="task-x">
          {warn && <p className="field-err"><Glyph k="awaiting" />{warn}</p>}
          {node.status === 'blocked' && <NeedsInput deptId={deptId} questId={questId} node={node} />}
          <KV rows={([
            ['Agent', node.agentKey || node.assignee ? <AgentName deptId={deptId} agentKey={node.agentKey} /> : 'Unassigned'],
            node.parentIds.length ? ['Part of', node.parentIds.map(title).join(', ')] : null,
            node.childIds.length ? ['Handed out', `${node.childIds.length} task${node.childIds.length === 1 ? '' : 's'}`] : null,
            ['Started', node.startedAt ? formatTime(node.startedAt) : 'Not yet'],
            node.completedAt ? ['Finished', formatTime(node.completedAt)] : null,
            node.runs.length > 1 ? ['Attempts', String(node.runs.length)] : null,
            node.attachmentCount ? ['Files', `${node.attachmentCount} attached (see Results)`] : null,
          ] as ([string, ReactNode] | null)[]).filter((r): r is [string, ReactNode] => r !== null)} />
          {/* A blocked task's summary and error are its reason, shown above. */}
          {node.status !== 'blocked' && node.summary && <><h4 className="mini-h">Summary</h4><p className="box-p">{node.summary}</p></>}
          {node.status !== 'blocked' && node.error && <><h4 className="mini-h">Error</h4><p className="err-t">{node.error}</p></>}
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
              {v.remaining.length > 0 && <><h4 className="mini-h">Still stopping ({v.remaining.length})</h4><ul className="ids">{v.remaining.map((r) => <li key={r.id}>{r.title} · {r.status}</li>)}</ul></>}
              {v.archived.length > 0 && <><h4 className="mini-h">Archived by Vibe City ({v.archived.length})</h4><ul className="ids">{v.archived.map((r) => <li key={r.id}>{r.title}</li>)}</ul><p className="fine">Archived unfinished tasks cannot be dispatched again. Create a new quest to redo the work.</p></>}
              {v.finished.length > 0 && <><h4 className="mini-h">Already finished, left untouched ({v.finished.length})</h4><ul className="ids">{v.finished.map((r) => <li key={r.id}>{r.title}</li>)}</ul><p className="fine">Their summaries and files stay in Results.</p></>}
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

function ResultsSection({ deptId, status, extra }: { deptId: string; status: QuestStatus; extra: ReturnType<typeof useStore.getState>['extra'][string] | undefined }) {
  const r = extra?.results;
  const withOutput = r?.tasks.filter((t) => t.summary || t.error || t.attachments.length) ?? [];
  const silent = (r?.tasks.length ?? 0) - withOutput.length;
  return (
    <section className="pane-sec" aria-busy={extra?.loading}>
      {extra?.loading && !r && <p className="muted">Loading…</p>}
      {r && (
        <>
          {status === 'cancelling' || status === 'cancelled' ? <p className="fine">Results of tasks that finished before the cancellation are kept below.</p> : null}
          {r.leadSummary ? <><h3 className="sec-t">Summary from the lead</h3><p className="box-p">{r.leadSummary}</p></> : status !== 'completed' && <div className="empty"><Icon n="file" size={40} sw={1.5} /><b>Nothing final yet</b><p>The lead’s summary and any files appear as tasks finish. The quest is complete only when every task is done.</p></div>}
          {withOutput.map((t) => (
            <div key={t.taskId} className="stack">
              <h3 className="sec-t">{t.title} <span className="muted small"><AgentName deptId={deptId} agentKey={t.agentKey} /> · {t.status}</span></h3>
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
const WIZARD_STEPS = ['Basics', 'Capabilities', 'Team & review'] as const;
const isToolset = (t: string): t is Toolset => (TOOLSETS as readonly string[]).includes(t);
/** Not shown: never given to agents (delegation, cronjob) or always on (kanban), so there is nothing to choose. */
const HIDDEN_TOOLSETS: readonly string[] = [...AGENT_EXCLUDED_TOOLSETS, 'kanban'];
const shownToolset = (t: string) => !HIDDEN_TOOLSETS.includes(t);

/**
 * Three steps: name and purpose; capabilities pre-filled from Hermes' default profile (editable); team size and review.
 * Saving creates the department with that inventory and provisions it.
 */
export function CreateDeptModal() {
  const s = useStore();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [defaults, setDefaults] = useState<HermesDefaultsView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [toolsets, setToolsets] = useState<Toolset[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [model, setModel] = useState<ModelChoice | null>(null);
  const [catalog, setCatalog] = useState<HermesModelsView | null>(null);
  const [catalogErr, setCatalogErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [workers, setWorkers] = useState(0);
  const [provisionNow, setProvisionNow] = useState(true);
  const ref = useRef<HTMLFormElement>(null);
  const open = s.ui.modal === 'create';
  useDialog(ref, open, () => s.ui$({ modal: null }));
  useEffect(() => {
    if (!open) return;
    setStep(0); setName(''); setPurpose(''); setDefaults(null); setLoadErr(null); setCatalog(null); setCatalogErr(null); setToolsets([]); setSkills([]); setModel(null); setFilter(''); setWorkers(0); setProvisionNow(true);
  }, [open]);
  if (!open) return null;
  const busy = !!s.busy.create || !!Object.keys(s.busy).find((k) => k.startsWith('provision:') && s.busy[k]);
  const next = s.depts.length + 1;

  const applyDefaults = (v: HermesDefaultsView, cat: HermesModelsView | null = catalog) => {
    setToolsets(v.toolsets.filter((t) => t.enabled && t.manageable).map((t) => t.name).filter(isToolset));
    setSkills(v.skills.filter((x) => x.enabled).map((x) => x.name));
    // The default profile's current pair, when Hermes offers it.
    const cur = cat?.current;
    const offered = cur?.provider && cur.model && cat!.providers.some((p) => p.slug === cur.provider && p.models.includes(cur.model!));
    setModel(offered ? { provider: cur!.provider!, id: cur!.model! } : null);
  };
  const load = async () => {
    setLoading(true); setLoadErr(null);
    const [{ value, error }, models] = await Promise.all([loadHermesDefaults(), loadHermesModels()]);
    setLoading(false);
    setCatalog(models.value); setCatalogErr(models.value ? null : models.error?.message ?? 'Could not read the model list from Hermes.');
    if (value) { setDefaults(value); applyDefaults(value, models.value); } else setLoadErr(error?.message ?? 'Could not read Hermes.');
  };
  const go = (n: number) => { setStep(n); if (n === 1 && !defaults && !loading) void load(); };
  const toggle = <T extends string>(list: T[], set: (v: T[]) => void, x: T) => set(list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const canProvision = s.conn.hermes;
  const submit = () => {
    if (!name.trim() || busy) return;
    void createDepartment({
      name: name.trim(), purpose: purpose.trim(),
      inventory: { allowedToolsets: toolsets, allowedSkillIds: skills, model }, teammates: workers,
    }, provisionNow && canProvision);
  };
  const shownSkills = (defaults?.skills ?? []).filter((x) => x.name.includes(filter.trim().toLowerCase()));

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) s.ui$({ modal: null }); }}>
      <form ref={ref} className="modal wide" role="dialog" aria-modal="true" aria-labelledby="cd-t" aria-busy={busy}
        onSubmit={(e) => { e.preventDefault(); if (step < 2) { if (name.trim()) go(step + 1); } else submit(); }}>
        <div className="head-row"><Where n={'F' + next} tone="amber">New floor</Where><button type="button" className="x" onClick={() => s.ui$({ modal: null })} aria-label="Close"><Icon n="x" /></button></div>
        <h2 id="cd-t" className="display">Create a department</h2>
        <ol className="wiz-steps" aria-label="Steps">
          {WIZARD_STEPS.map((t, i) => <li key={t} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span className="num">{i + 1}</span>{t}</li>)}
        </ol>

        {step === 0 && <>
          <p className="sub">Each department gets its own floor, a Hermes board and one Hermes profile per agent. Next you choose what its agents may use.</p>
          <Field label="Department name" hint="Shown on the floor sign. Up to 32 characters. Must be unique.">
            {(p) => <input {...p} className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <Field label="Purpose / objective" hint="Every agent reads this when it works on quests.">
            {(p) => <textarea {...p} className="input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
          </Field>
        </>}

        {step === 1 && <>
          <p className="sub">Pre-filled from Hermes’ <b className="mono">default</b> profile. Change anything; what you save here is copied into the department and later changes to the default profile do not affect it.</p>
          <div aria-live="polite">
            {loading && <p className="muted small" role="status">Reading the default profile from Hermes…</p>}
            {loadErr && <div className="banner warn" role="alert"><Glyph k="awaiting" /><div><b>Could not read Hermes’ default profile</b><p>{loadErr}</p><Btn kind="secondary" onClick={() => void load()}>Try again</Btn></div></div>}
          </div>
          {defaults && <>
            <h3 className="inv-h">Toolsets <span>{toolsets.length} on</span></h3>
            <div className="chk-grid">
              {defaults.toolsets.filter((t) => shownToolset(t.name)).map((t) => (
                <label key={t.name} className={`chk${t.manageable ? '' : ' off'}`} title={t.manageable ? '' : 'Not a toolset Vibe City manages.'}>
                  <input type="checkbox" disabled={!t.manageable} checked={isToolset(t.name) && toolsets.includes(t.name)}
                    onChange={() => { if (isToolset(t.name)) toggle(toolsets, setToolsets, t.name); }} />
                  <span className="mono">{t.name}</span>{t.enabled && <small className="muted">default</small>}
                </label>
              ))}
            </div>
            <h3 className="inv-h">Skills <span>{skills.length} of {defaults.skills.length} on</span></h3>
            <div className="row">
              <input className="input mono" placeholder="Filter skills" aria-label="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <button type="button" className="link" onClick={() => setSkills([...new Set([...skills, ...shownSkills.map((x) => x.name)])])}>All</button>
              <button type="button" className="link" onClick={() => setSkills(skills.filter((x) => !shownSkills.some((y) => y.name === x)))}>None</button>
            </div>
            <div className="chk-grid scroll">
              {shownSkills.map((x) => (
                <label key={x.name} className="chk"><input type="checkbox" checked={skills.includes(x.name)} onChange={() => toggle(skills, setSkills, x.name)} /><span className="mono">{x.name}</span>{x.enabled && <small className="muted">default</small>}</label>
              ))}
              {!shownSkills.length && <p className="muted small">No skill matches.</p>}
            </div>
            <ModelPicker label="Model" hint={`The agents’ default model, from Hermes’ list. The default profile uses ${catalog?.current.model ?? defaults.model ?? 'none'}${catalog?.current.provider ? ` via ${catalog.current.provider}` : ''}. Hermes cannot stop an agent from picking another model.`}
              models={catalog} error={catalogErr} value={model} onChange={setModel}
              onRetry={() => void loadHermesModels().then((m) => { setCatalog(m.value); setCatalogErr(m.value ? null : m.error?.message ?? 'Could not read the model list from Hermes.'); })} />
            <button type="button" className="link" onClick={() => applyDefaults(defaults)}>Reset to Hermes defaults</button>
          </>}
        </>}

        {step === 2 && <>
          <Field label="Teammates (0–10)" hint={workers === 0 ? 'No teammates: the lead does the work itself. You can hire more later.' : `The lead may hand parts of a quest to its teammates. ${LIMIT_COPY.teammates}`}>
            {(p) => <input {...p} className="input mono" type="number" min={0} max={10} value={workers} onChange={(e) => setWorkers(Math.max(0, Math.min(10, Math.round(Number(e.target.value)) || 0)))} />}
          </Field>
          <KV rows={[
            ['Name', name.trim()],
            ['Toolsets', <span className="mono">{[...toolsets].sort().join(', ') || 'none'}</span>],
            ['Skills', skills.length ? `${skills.length} enabled` : 'none (Hermes keeps hermes-agent on)'],
            ['Model', <span className="mono">{model ? `${model.id} · ${model.provider}` : 'profile default'}</span>],
            ['Agents', workers === 0 ? '1 · the lead alone' : `${workers + 1} · a lead + ${workers} teammate${workers === 1 ? '' : 's'}`],
          ]} />
          <label className="consent"><input type="checkbox" checked={provisionNow && canProvision} disabled={!canProvision} onChange={(e) => setProvisionNow(e.target.checked)} />
            <span>Sync now: create the board and {workers > 0 ? `${workers + 1} agent profiles` : 'the lead\'s profile'} in Hermes and apply these settings.{!canProvision && ' Hermes is not reachable, so the department is only saved; sync it from its floor later.'}</span></label>
        </>}

        <div className="row end">
          {step === 0 ? <Btn onClick={() => s.ui$({ modal: null })}>Cancel</Btn> : <Btn onClick={() => setStep(step - 1)} disabled={busy}>Back</Btn>}
          {step < 2
            ? <button className="btn primary lg" type="submit" disabled={!name.trim() || (step === 1 && loading)}>{step === 1 && !defaults ? 'Continue without defaults' : 'Next'}</button>
            : <button className="btn primary lg" type="submit" aria-busy={busy || undefined} disabled={!name.trim() || busy}>{busy ? (s.busy.create ? 'Creating…' : 'Syncing…') : provisionNow && canProvision ? 'Create and sync' : 'Create department'}</button>}
        </div>
      </form>
    </div>
  );
}
