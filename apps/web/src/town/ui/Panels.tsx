import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AGENT_EXCLUDED_TOOLSETS, DEFAULT_CHAT_MODEL, TOOLSETS, type AgentView, type HermesDefaultsView, type HermesModelsView, type ModelChoice, type QuestStatus, type SyncCheck, type TaskNode, type Toolset } from '@vibe-city/shared';
import { floorNum, useStore, type AgentTab, type QuestItem } from '../store';
import type { Dept } from '../data/types';
import {
  archiveDepartment, cancelQuest, createDepartment, createQuest, fireAgent, loadAgent, setAgentModel, loadDeptInfo, loadHermesDefaults, loadHermesModels, loadQuest, patchInventory, provisionDepartment,
  checkDepartment, refreshAll, refreshOne, renameCompany, saveDepartmentSettings, stopCancellationPoll,
} from '../data/live';
import { clock } from '../data/derive';
import {
  COLUMN_HINT, GATEWAY_WARNING, age, attentionCount, attentionReason, cardLines, columnOf, companyQuests, crewOf, defaultTarget, filterColumns, filterQuests, lanes, missingDepts, objectiveText, questTargets, searchSort, tickerItems, ticketStamp, RAIL_NAME,
  type BoardQuest, type BoardSort, type ColumnKey, type DeptOption,
} from '../data/company';
import {
  CANCEL_CONFIRM, LIMIT_COPY, PROVISIONING_STATE_LABEL, RESET_WARNING, SYNC_STEP_LABEL, agentLabel,
  archiveConsequences, assigneeWarning, cancellationView, fieldErrors, syncView,
  settingsFormFrom, settingsPatch, taskStatusView, settingsErrorField, type SettingsForm,
} from '../data/views';
import { STATUS, canCancel, formatBytes, formatTime, planningNote, requestIdFor, treeRows } from './format.ts';
import { AttachTray, ReferenceFiles } from './QuestFiles';
import { DeptEnvTab } from './DeptEnv';
import { isMuted, onMuted, play, setMuted } from '../sfx';
import { Btn, Chip, Field, FloorKey, Glyph, Icon, KV, PixelSelect, Portrait, Tabs, Where, deptStatus, questStatus, statusColor, useDialog, type StatusKey } from './kit';
import { ModelLogo, modelOption, privacyOf, useModelInfo } from './ModelBadge';
import { DeskSheet } from './Desk';
import { Mark } from './Device';
import { Wordmark } from './Wordmark';
import { Directory, InTray, StatusBoard } from './ExecDesk';
import { ChiefOfStaffCard } from './ChiefOfStaff';
import { PendingRequests } from './Requests';
import { AgentName, AgentPortrait, AgentRecord, ChatTranscript, NeedsInput, PersonaLine, TaskSteps } from './AgentView';
import { SchedulesView } from './Schedules';
import { HireGrid, type HireTemplate } from './HirePanel';
import { progressLabel } from '../data/game';
import { CeoConsole } from './CeoConsole';
import { SkillBadges, SkillCard } from './Skills';
import { skillMeta } from '../data/skills';
import { SkillPicker, ToolPicker, ToolSlot } from './Picker';
import { isRequiredToolset, stationFor, toolsReport } from '../data/floor';
import type { SkillState } from '../data/skills';


/* ============ top bar ============ */
/** The company's name in the top bar; click to rename it (it is painted on the rooftop sign and over the door). */
function CompanyName({ name }: { name: string | null }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (draft === null) return (
    <button className="co-name" title="Rename the company" onClick={() => { setDraft(name ?? ''); setErr(null); }}>
      <b>{name ?? '…'}</b><Icon n="pencil" size={11} />
    </button>
  );
  const save = async () => {
    const v = draft.trim();
    if (!v || v === name) { setDraft(null); return; }
    setBusy(true); const e = await renameCompany(v); setBusy(false);
    if (e) setErr(e); else setDraft(null);
  };
  return (
    <form className="co-edit" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input autoFocus value={draft} maxLength={24} disabled={busy} aria-label="Company name" aria-invalid={!!err} aria-describedby={err ? 'co-err' : undefined}
        onChange={(e) => { setDraft(e.target.value); setErr(null); }} onBlur={() => { if (!busy && !err) void save(); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }} />
      {err && <span id="co-err" className="co-err" role="alert">{err}</span>}
    </form>
  );
}

export function TopBar() {
  const company = useStore((s) => s.company);
  const conn = useStore((s) => s.conn);
  const stale = useStore((s) => s.stale);
  const depts = useStore((s) => s.depts);
  const quests = useStore((s) => s.quests);
  const attn = attentionCount(quests);
  const onBoard = useStore((s) => s.ui.panel === 'board');
  const game = useStore((s) => s.game);
  const questLogOpen = useStore((s) => s.ui.questLog);
  const openPanel = useStore((s) => s.openPanel);
  const closeFloor = useStore((s) => s.closeFloor);
  const items = useMemo(() => tickerItems(depts, quests), [depts, quests]);
  const agents = depts.reduce((n, d) => n + d.teamSize, 0);
  const down = [!conn.backend && 'Backend', !conn.hermes && 'Hermes', !conn.gateway && 'Gateway'].filter((x): x is string => !!x);
  // a dropped live link is not an outage (floors still refresh every 30 s): the dot turns amber, nothing else shouts
  const reconnecting = useStore((s) => Object.keys(s.liveDown).length > 0);
  const health = down.length === 0 ? (reconnecting || stale ? 'warn' : 'ok') : conn.backend && conn.hermes ? 'warn' : 'bad';
  const said = `Backend ${conn.backend ? 'connected' : 'not responding'}. Hermes ${conn.hermes ? 'connected' : 'not responding'}. Gateway ${conn.gateway ? 'running' : 'not running'}.${reconnecting ? ' Live updates are reconnecting; floors still refresh every 30 seconds.' : ''}${stale ? ' Showing out-of-date data.' : ''}`;
  // the news line: one item at a time, the next every 6 s (a scrolling marquee trained people to ignore it)
  const [tick, setTick] = useState(0);
  useEffect(() => { const id = window.setInterval(() => setTick((x) => x + 1), 6000); return () => window.clearInterval(id); }, []);
  const item = items.length ? items[tick % items.length]! : null;
  return (
    <header className="top">
      <button className="brand" title="Back to the tower" aria-label="Vibe City: back to the tower" onClick={closeFloor}><Wordmark height={26} /></button>
      <div className="co"><CompanyName name={company?.name ?? null} /><span>{depts.length} floor{depts.length === 1 ? '' : 's'} · {agents} agent{agents === 1 ? '' : 's'}</span></div>
      <div className="ticker" aria-label="What is happening in the company">
        {!item ? <span className="tk idle">All quiet. Give a floor a job from the Ops board.</span>
          : <span key={tick % items.length} className={`tk ${item.tone}`}><i aria-hidden="true" />{item.text}</span>}
        {items.length > 1 && <span className="tk-n" aria-hidden="true">{(tick % items.length) + 1}/{items.length}</span>}
      </div>
      <div id="hud-phone" className="hud-phone" />
      {game && <button className="topkey quests" aria-pressed={questLogOpen} aria-label={`Quest log: ${progressLabel(game)}`} onClick={() => useStore.getState().ui$({ questLog: true })}>
        <span aria-hidden="true">Quests</span>
      </button>}
      <button className="topkey ops" aria-pressed={onBoard} aria-label={`Ops board: your agents' jobs${attn > 0 ? `, ${attn} need attention` : ''}`} onClick={() => openPanel('board', { composer: false, boardDept: null })}>
        <span aria-hidden="true">Ops board</span>{attn > 0 && <b className="bad" title="Jobs that need attention" aria-hidden="true">{attn}</b>}
      </button>
      <SoundKey />
      {stale && <span className="stale" title="The last refresh failed; floors show the last data received">Out of date</span>}
      <span className={`health ${health}`} title={said}><i aria-hidden="true" /><span>{down.length ? `${down.join(' · ')} off` : reconnecting ? 'Reconnecting' : 'Live'}</span></span>
      <span className="sr" aria-live="polite">{said}</span>
    </header>
  );
}

/* ============ A · executive office ============ */
export function ExecPanel() {
  const ui$ = useStore((s) => s.ui$);
  return (
    <div className="pane">
      <div className="pane-scroll">
        <div className="ceo-wrap"><CeoConsole /></div>
        <InTray />
        <ChiefOfStaffCard />
        <PendingRequests />
        <StatusBoard />
        <Directory />
        {/* one pink button per screen (the quest's): adding a floor is a plain action here and the ghost floor on the tower */}
        <section className="pane-sec"><button className="btn secondary block" onClick={() => ui$({ modal: 'create' })}><Icon n="plus" sw={3} />Add floor</button></section>
      </div>
    </div>
  );
}

/* ============ D · department ============ */
export function DeptPanel() {
  const s = useStore();
  const floorId = s.ui.floorId;
  // the chain of command's model chips read each agent's Hermes profile
  useEffect(() => { if (floorId) void loadDeptInfo(floorId); }, [floorId]);
  const d = s.depts.find((x) => x.id === floorId);
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
          <div className="head-row"><Where n={'F' + floorNum(s.depts, d.id)}>Floor</Where><span className="head-tools"><button className="x" onClick={() => s.openPanel('settings')} aria-label="Floor settings" title="Settings"><Icon n="sliders" /></button><button className="x" onClick={s.closeFloor} aria-label="Close floor"><Icon n="x" /></button></span></div>
          <div className="title-row"><h1 className="display" tabIndex={-1}>{d.name}</h1><Chip k={st.k} label={st.label} /></div>
          <Purpose text={d.purpose} />
          <div className="actions">
            <button className="btn primary" disabled={!canWork} title={canWork ? '' : 'Needs the floor in sync with Hermes, and Hermes reachable'} onClick={() => s.openPanel('board', { composer: true, composerDept: d.id, boardDept: d.id, boardFilter: 'all' })}><Icon n="plus" sw={3} />New job</button>
            <Btn kind="secondary" onClick={() => s.ui$({ newDept: true, cosCall: `${d.name} could use another pair of hands.` })}><Icon n="phone" size={14} />Hire</Btn>
          </div>
          {!canWork && <p className="fine">{d.provisioning !== 'ready' ? 'New jobs need the floor to be in sync with Hermes.' : 'New jobs need Hermes to be reachable.'}</p>}
          {canWork && !s.conn.gateway && <p className="fine">The Hermes gateway is not running: new jobs wait in Queued until it starts.</p>}
          <Tabs label="Floor sections" idBase="dept" value={tab} onChange={(t) => s.ui$({ deptTab: t })}
            options={(['overview', 'tools', 'skills', 'env', 'quests'] as const).map((t) => ({ key: t, label: <>{DEPT_TAB_LABEL[t]}{t === 'quests' && <span className="count">{quests.length}</span>}</> }))} />
        </section>
        <div id="dept-panel" role="tabpanel" aria-labelledby={`dept-tab-${tab}`}>
          <div aria-live="polite">
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
                {d.chief && <><div className="cmd"><button type="button" className={`chief-card${sel === 'chief' ? ' sel' : ''}`} aria-pressed={sel === 'chief'} onClick={() => s.openPanel('agent', { agent: 'chief' })}>
                  <span className="chief-top">
                    <Portrait shirt="#fff" chief size={44} />
                    <span>
                      <span className="chief-badges"><span className="role">Lead</span><Chip k={d.chief.status} small /></span>
                      <span className="chief-name"><AgentName deptId={d.id} agentKey="chief" /> <SkillBadges names={d.view.agents.find((a) => a.lead)?.skills ?? []} max={4} size={11} /></span>
                    </span>
                  </span>
                  <span className="chief-act"><span>{d.chief.activity}</span><span className="mono muted">since {d.chief.since}</span></span>
                </button><ModelChip d={d} agentKey="chief" /></div>
                <div className="tree">
                  {d.workers.map((w) => (
                    <div key={w.id} className="cmd"><button className={`wrow${sel === w.id ? ' sel' : ''}`} aria-pressed={sel === w.id} onClick={() => s.openPanel('agent', { agent: w.id })}>
                      <Portrait shirt={w.shirt} size={28} />
                      <span className="wrow-t"><span><b><AgentName deptId={d.id} agentKey={w.id} /></b> <SkillBadges names={d.view.agents.find((a) => a.key === w.id)?.skills ?? []} max={3} size={10} /> <span className="muted">{w.task || 'No task'}</span></span>
                        <small style={{ color: statusColor(w.status) }}><Glyph k={w.status} />{w.taskId ? WORKER_WORD[w.status] : 'Free'} <span className="muted">· {w.status === 'completed' ? 'done' : 'since'} {w.since}</span></small>
                      </span>
                    </button><ModelChip d={d} agentKey={w.id} /></div>
                  ))}
                  {d.workers.length === 0 && <div className="empty-w">No teammates: the lead does the work itself. Hire to add agents that work in parallel.</div>}
                </div>
                <p className="mono muted small">{running + (d.chief.status === 'running' ? 1 : 0)} of {d.teamSize} agent{d.teamSize === 1 ? '' : 's'} working{d.teamSize > d.workers.length + 1 ? ` · ${d.teamSize - d.workers.length - 1} not drawn (no free desk)` : ''}</p></>}
              </section>
              <section className="pane-sec">
                <h3 className="sec-t">Active jobs</h3>
                {active.length === 0 && <p className="muted">No active jobs. Give the lead an objective.</p>}
                <div className="stack">{active.map((q) => <QuestMini key={q.summary.id} q={q} />)}</div>
              </section>
              <section className="pane-sec">
                <h3 className="sec-t">Live activity</h3>
                {log.length === 0 && <p className="muted small">Events from Hermes appear here as they happen.</p>}
                <ol className="feed">{log.map((l, i) => <li key={i}><span className="mono muted">{l.t}</span><Glyph k={(l.kind === 'chief' ? 'awaiting' : l.kind) as StatusKey} /><span>{l.text}</span></li>)}</ol>
              </section>
            </>
          )}
          {(tab === 'tools' || tab === 'skills') && <DeptLoadout key={tab} d={d} part={tab} />}
          {tab === 'env' && <DeptEnvTab d={d} />}
          {tab === 'quests' && (
            <section className="pane-sec">
              <p className="fine">This floor’s jobs. You give and change jobs on the Ops board.</p>
              {s.questSync[d.id] === 'not_loaded' && <p className="field-err"><Glyph k="disconnected" />Jobs for this floor are not loaded yet, so this list is incomplete.</p>}
              <div className="stack">{quests.map((q) => <QuestMini key={q.summary.id} q={q} />)}{quests.length === 0 && s.questSync[d.id] !== 'not_loaded' && <p className="muted">No jobs yet.</p>}</div>
              <Btn kind="secondary" onClick={() => s.openPanel('board', { composer: false, boardDept: d.id })}>Open on the Ops board</Btn>
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

const DEPT_TAB_LABEL = { overview: 'Overview', tools: 'Tools', skills: 'Skills', env: 'Env', quests: 'Jobs' } as const;

/** An agent's model as its vendor's logo, ringed by its privacy (mint = Private TEE). One click opens the agent's
    loadout, where it is changed. A sibling of the agent's row, never inside it (a button cannot hold a button). */
function ModelChip({ d, agentKey }: { d: Dept; agentKey: string }) {
  const s = useStore();
  const info = useModelInfo();
  const id = d.view.agents.find((a) => a.key === agentKey)?.model?.id ?? s.info[d.id]?.inventory?.model?.id
    ?? s.info[d.id]?.profiles?.agents.find((p) => p.key === agentKey)?.model ?? null;
  const m = id ? info.get(id) : undefined;
  const who = agentLabel(agentKey, s.personas[`${d.id}:${agentKey}`]);
  const label = id ? `${who} thinks with ${id}${m ? ` (${privacyOf(m).label})` : ''}. Change it in the loadout.` : `${who}'s model is not known yet. Choose one in the loadout.`;
  return (
    <button type="button" className={`mchip ${m ? privacyOf(m).cls : ''}`} title={label} aria-label={label}
      onClick={() => s.openPanel('agent', { agent: agentKey, agentTab: 'loadout' })}>
      {id ? <ModelLogo id={id} icon={m?.icon} /> : <i className="mlogo">?</i>}
    </button>
  );
}

/** Department settings: how long the lead's task may run. */
function DeptLimits({ d }: { d: Dept }) {
  const s = useStore();
  const inv = s.info[d.id]?.inventory ?? null;
  const saving = !!s.busy[`inv:${d.id}`] || syncing(s.busy, d);
  const save = (p: Parameters<typeof patchInventory>[1]) => void patchInventory(d.id, p);
  return (
    <>
      {inv && (
        <section className="pane-sec">
          <h3 className="sec-t">Limits</h3>
          <p className="fine">{LIMIT_COPY.teammates} To add an agent, use Hire on the floor panel.</p>
          <Field label="Max seconds for the lead’s task (10–86400, blank = none)" hint={LIMIT_COPY.maxTaskRuntimeSeconds}>
            {(p) => <input {...p} className="input mono" type="number" min={10} max={86400} defaultValue={inv.limits.maxTaskRuntimeSeconds ?? ''} key={String(inv.limits.maxTaskRuntimeSeconds)} disabled={saving}
              onBlur={(e) => { const v = e.target.value.trim(); const n = v === '' ? null : Math.round(Number(v)); if ((n === null || (n >= 10 && n <= 86400)) && n !== inv.limits.maxTaskRuntimeSeconds) save({ limits: { maxTaskRuntimeSeconds: n } }); else e.target.value = String(inv.limits.maxTaskRuntimeSeconds ?? ''); }} />}
          </Field>
        </section>
      )}
    </>
  );
}

/** What every agent on the floor gets: its toolsets (the Tools tab, the server rack) or its skill deck (the Skills tab,
    the bookshelf). Installed skills and toolset states are read back from the lead's profile. */
function DeptLoadout({ d, part }: { d: Dept; part: 'tools' | 'skills' }) {
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
  // what the floor's template says its work needs (the server rack opens this tab)
  const report = inv ? toolsReport(d.view.templateId, inv) : null;
  const needs = new Set(report?.needed.map((t) => t.id) ?? []);
  const needOff = report?.needed.filter((t) => !t.on) ?? [];
  const riskyOn = report?.extra.filter((t) => t.risky).length ?? 0;
  const skillsOff = report?.skills.filter((k) => !k.on) ?? [];
  return (
    <div aria-busy={saving}>
      <section className="pane-sec">
        <div aria-live="polite">
          {s.busy[`inv:${d.id}`] && <p className="muted small" role="status">Saving…</p>}
          {d.provisioning === 'ready' && eff && !eff.inSync && <div className="banner warn"><Glyph k="awaiting" /><div><b>Hermes no longer matches</b><p>The last read from Hermes differs from this floor’s tools and skills.</p><Btn kind="secondary" busy={busyProv} disabled={busyProv || !s.conn.hermes} onClick={() => void provisionDepartment(d.id)}>{busyProv ? 'Syncing…' : 'Sync again'}</Btn></div></div>}
        </div>
        {!inv && <p className="muted">Loading…</p>}
      </section>
        {part === 'skills' && <section className="pane-sec">
          <h3 className="sec-t">Skill deck</h3>
          <div className="sk-deck-h"><p className="fine">Every agent on this floor carries these skills, plus its own from its hire. Changes reach Hermes at the next sync.</p>
            <button className="btn secondary small" onClick={() => s.ui$({ skillLib: { deptId: d.id, skill: null } })}><Icon n="sparkle" size={12} />Skill library</button></div>
          {skillsOff.length > 0 && <p className="note warn">This floor’s work uses {skillsOff.map((k) => skillMeta(k.id).label).join(', ')}, which {skillsOff.length === 1 ? 'is' : 'are'} not equipped.</p>}
          {!view?.observedAt && <p className="muted small">Hermes has not reported this floor’s skills yet (sync the floor first). Allowed: {inv?.allowedSkillIds.join(', ') || 'Hermes defaults'}.</p>}
          {view && view.skills.length > 0 && (() => {
            const isOn = (k: { name: string; essential: boolean }) => k.essential || allowed.has(k.name);
            const stateOf = (k: AgentView['skills'][number]): SkillState => (k.essential ? 'active' : isOn(k) === k.enabled ? (k.enabled ? 'active' : 'off') : isOn(k) ? 'pending-on' : 'pending-off');
            const card = (k: AgentView['skills'][number]) => {
              const on = isOn(k);
              return (
                <SkillCard key={k.name} name={k.name} essential={k.essential} state={stateOf(k)} onClick={() => s.ui$({ skillLib: { deptId: d.id, skill: k.name } })}
                  action={k.essential ? undefined : <button className={`btn ${on ? 'tertiary' : 'secondary'} small`} disabled={saving || !inv} aria-pressed={on} aria-label={`${k.name}: ${on ? 'unequip' : 'equip'}`} onClick={() => toggleSkill(k.name)}>{on ? 'Unequip' : 'Equip'}</button>} />
              );
            };
            // grouped by what Hermes has, so a toggled skill stays put (in amber) until the sync moves it
            const inHermes = (k: { enabled: boolean; essential: boolean }) => k.essential || k.enabled;
            const active = view.skills.filter(inHermes), rest = view.skills.filter((k) => !inHermes(k));
            return (
              <>
                <div className="sk-deck">{active.map(card)}</div>
                {rest.length > 0 && <details className="more"><summary>In Hermes, not equipped ({rest.length})</summary><div className="sk-deck">{rest.map(card)}</div></details>}
              </>
            );
          })()}
          {inv && view && inv.allowedSkillIds.some((n) => !view.skills.some((k) => k.name === n)) && <>
            <p className="field-err small"><Glyph k="awaiting" />Equipped here but Hermes does not have {inv.allowedSkillIds.filter((n) => !view.skills.some((k) => k.name === n)).length === 1 ? 'this skill' : 'these skills'}: install {inv.allowedSkillIds.filter((n) => !view.skills.some((k) => k.name === n)).length === 1 ? 'it' : 'them'} in Hermes, then sync.</p>
            <div className="sk-deck">{inv.allowedSkillIds.filter((n) => !view.skills.some((k) => k.name === n)).map((n) => <SkillCard key={n} name={n} state="missing" onClick={() => s.ui$({ skillLib: { deptId: d.id, skill: n } })}
              action={<button className="btn tertiary small" disabled={saving} onClick={() => toggleSkill(n)}>Unequip</button>} />)}</div>
          </>}
        </section>}


        {part === 'tools' && <section className="pane-sec">
          <h3 className="sec-t">Toolsets</h3>
          <p className="fine">Gear every agent on this floor carries. Flip a switch, then sync the floor to apply it in Hermes.</p>
          {report && !report.plain && <p className={`note${needOff.length ? ' warn' : ''}`}>{needOff.length
            ? `${needOff.length === 1 ? 'A tool' : `${needOff.length} tools`} this floor’s work needs ${needOff.length === 1 ? 'is' : 'are'} off (${needOff.map((t) => t.label).join(', ')}): its jobs will stall.`
            : riskyOn ? `Everything the work needs is on. ${riskyOn} risky tool${riskyOn === 1 ? ' it does not need is' : 's it does not need are'} on too: switch ${riskyOn === 1 ? 'it' : 'them'} off unless you mean it.`
            : 'Everything this floor’s work needs is on.'}</p>}
          {(() => {
            // grouped by what Hermes has, like the skills above, so a toggled toolset stays put until the sync moves it
            const slot = (t: Toolset) => {
              if (isRequiredToolset(t)) return <ToolSlot key={t} name={t} on disabled onToggle={() => undefined} title="Every agent carries it: Vibe City needs it to run tasks."
                foot={<>{needs.has(t) && <span className="tt-need">Needed</span>}<span className="tt-def">Always on</span></>} />;
              const allowedT = !!inv?.allowedToolsets.includes(t);
              const inHermes = observedTools.get(t);
              const pending = inHermes !== undefined && allowedT !== inHermes;
              return <ToolSlot key={t} name={t} on={allowedT} disabled={saving || !inv}
                onToggle={() => inv && save({ allowedToolsets: allowedT ? inv.allowedToolsets.filter((x) => x !== t) : [...inv.allowedToolsets, t] })}
                foot={<>{needs.has(t) && <span className="tt-need">Needed</span>}{pending ? <span className="tt-pend">{allowedT ? 'Turns on' : 'Turns off'} at the next sync</span> : inHermes === undefined ? <span className="tt-def">Not reported by Hermes</span> : null}</>} />;
            };
            const shown = TOOLSETS.filter(shownToolset);
            const on = shown.filter((t) => observedTools.get(t)), off = shown.filter((t) => !observedTools.get(t));
            return <div className="tool-groups">
              {on.length > 0 && <section aria-label="On in Hermes"><h4 className="tg-h">On in Hermes <span>{on.length}</span></h4><div className="tool-grid">{on.map(slot)}</div></section>}
              {off.length > 0 && <section aria-label="Off in Hermes"><h4 className="tg-h">Off in Hermes <span>{off.length}</span></h4><div className="tool-grid">{off.map(slot)}</div></section>}
            </div>;
          })()}
        </section>}


    </div>
  );
}

/** Sound on or off for the big moments (remembered in this browser). */
function SoundKey() {
  const [muted, setM] = useState(isMuted);
  useEffect(() => onMuted(setM), []);
  return (
    <button className="topkey snd" aria-pressed={!muted} aria-label={muted ? 'Sound off: turn on' : 'Sound on: turn off'} title={muted ? 'Sound off' : 'Sound on'}
      onClick={() => { setMuted(!muted); if (muted) play('tick'); }}>
      <Icon n={muted ? 'mute' : 'sound'} size={16} />
    </button>
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
          <h1 className="display" tabIndex={-1}>Floor settings</h1>
          <p className="sub">Edit the floor, inspect what Vibe City created or linked in Hermes, or archive the floor.</p>
        </section>
        <SettingsForm key={`${d.id}|${d.name}|${d.purpose}`} d={d} />
        <DeptLimits d={d} />
        <SyncInspector d={d} />
        <section className="pane-sec danger">
          <h3 className="sec-t">Archive</h3>
          <p className="fine">Removes the floor from the tower. Nothing is deleted in Hermes.</p>
          <Btn kind="destructive" onClick={() => s.ui$({ modal: 'archive' })}>Archive floor…</Btn>
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
      <Field label="Floor name" hint="Up to 80 characters. Unique among active floors." error={errs.name}>
        {(p) => <input {...p} className="input" value={f.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field label="Purpose / objective" hint="Every agent reads this when it works on jobs." error={errs.purpose}>
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
        {activeQuests > 0 && <p className="field-err"><Glyph k="awaiting" />{activeQuests} job{activeQuests === 1 ? ' is' : 's are'} still active on this floor and will keep running in Hermes.</p>}
        <Field label={`Type the floor name to confirm`} hint={<span className="mono">{d.name}</span>} error={error}>
          {(p) => <input {...p} className="input" value={typed} autoComplete="off" onChange={(e) => { setTyped(e.target.value); setError(null); }} />}
        </Field>
        <div className="row end"><Btn onClick={close} disabled={busy}>Keep floor</Btn>
          <button className="btn destructive lg" type="submit" disabled={typed.trim() !== d.name || busy} aria-busy={busy || undefined}>{busy ? 'Archiving…' : 'Archive floor'}</button></div>
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
  const info = useModelInfo();
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
              ...models.providers.flatMap((pr) => pr.models.map((m) => ({ value: modelKey({ provider: pr.slug, id: m }), label: m, group: `${pr.name}${pr.current ? ' · current provider' : ''}`, ...modelOption(m, info.get(m)) }))),
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
  const tab = s.ui.agentTab;
  const setTab = (agentTab: AgentTab) => s.ui$({ agentTab });
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
            <p className="fine">This floor's recurring jobs. Each one lands on the lead's desk at its time, like a job you create.</p>
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
          {(role === 'chief' ? !s.quests.some((q) => q.deptId === d.id) : tasks.length === 0) && <p className="muted small">{role === 'chief' ? 'No jobs yet. Every job goes to the lead first.' : 'Nothing yet.'}</p>}
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
            <p className="fine">This agent gets the floor’s skills and toolsets.{me?.skills.length ? ' On top of that it has its own skills from its hire.' : ''}</p>
            {me && agentKey && <ModelPicker label="Model" hint={`Changes apply when you sync again.${view?.provider ? ` Hermes now reports ${view.model ?? '—'} via ${view.provider}.` : ''}`}
              models={hermesModels.models} error={hermesModels.error} onRetry={() => void hermesModels.reload()}
              value={me.model} fallback={inv?.model ?? (view?.model && view.provider ? { provider: view.provider, id: view.model } : null)} disabled={saving} onChange={(m) => void setAgentModel(d.id, agentKey, m)} />}
            {(() => {
              // the agent's deck: its own skills first, then what its profile has on in Hermes
              const own = me?.skills ?? [];
              const onInHermes = view?.observedAt ? view.skills.filter((k) => k.enabled) : [];
              const names = [...new Set([...own, ...onInHermes.map((k) => k.name)])];
              if (!names.length) return <p className="muted small">{view?.observedAt ? 'No skills on in Hermes.' : 'Hermes has not reported this agent’s skills yet.'}</p>;
              const st = (n: string): SkillState | undefined => (!view?.observedAt ? 'pending-on' : view.skills.find((k) => k.name === n)?.enabled ? 'active' : view.skills.some((k) => k.name === n) ? 'pending-on' : 'missing');
              return (
                <>
                  <div className="sk-deck-h"><h4 className="sk-sub">Skill deck <span className="count">{names.length}</span></h4>
                    <button className="link" onClick={() => s.ui$({ skillLib: { deptId: d.id, skill: null } })}>Skill library</button></div>
                  <div className="sk-deck">{names.map((n) => <SkillCard key={n} name={n} compact own={own.includes(n)} essential={view?.skills.find((k) => k.name === n)?.essential} state={st(n)} onClick={() => s.ui$({ skillLib: { deptId: d.id, skill: n } })} />)}</div>
                </>
              );
            })()}
            {view?.observedAt && <KV rows={[
              ['Toolsets on in Hermes', <span className="mono">{view.toolsets.filter((t) => t.enabled && shownToolset(t.name)).map((t) => t.name).join(', ') || 'none'}</span>],
            ]} />}
            <div className="row"><Btn kind="secondary" onClick={() => s.openPanel('dept', { deptTab: 'tools' })}>Floor tools</Btn><Btn kind="secondary" onClick={() => s.openPanel('dept', { deptTab: 'skills' })}>Floor skills</Btn></div>
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

type BoardLayout = 'columns' | 'lanes';
const readLayout = (): BoardLayout => { try { return localStorage.getItem('vc.board.layout') === 'lanes' ? 'lanes' : 'columns'; } catch { return 'columns'; } };

export function QuestBoard() {
  const s = useStore();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<BoardSort>('newest');
  const [layout, setLayoutState] = useState<BoardLayout>(readLayout);
  const setLayout = (l: BoardLayout) => { setLayoutState(l); try { localStorage.setItem('vc.board.layout', l); } catch { /* storage off: fine */ } };
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
  // per floor, with the status/search/origin filters but not the floor filter
  const onFloor = (id: string | null) => searchSort(filterQuests(all, id, f), query, sort).filter(byOk);
  const open = s.ui.boardQuest && s.quests.some((q) => q.summary.id === s.ui.boardQuest) ? s.ui.boardQuest : null;
  const leave = () => { s.ui$({ boardQuest: null }); backToPlace(); };
  const cols = filterColumns(f);
  const column = (c: (typeof cols)[number], list: BoardQuest[], lane = false) => {
    const mine = list.filter((q) => c.has(q.summary.status));
    const color = statusColor(COL_GLYPH[c.key]);
    return (
      <section key={c.key} className={`col${mine.length ? '' : ' is-empty'}${lane ? ' in-lane' : ''}`} aria-label={`${c.title}: ${mine.length}`} style={{ ['--col' as string]: color }}>
        {!lane && <h2 className="col-h"><span className="rail-plate"><Glyph k={COL_GLYPH[c.key]} /><b>{RAIL_NAME[c.key]}</b><span className="col-n">{mine.length}</span></span><small className="col-hint">{c.title} · {COLUMN_HINT[c.key]}</small></h2>}
        <div className="col-list">{mine.map((q) => <QuestCard key={q.summary.id} q={q} open={open === q.summary.id} />)}</div>
        {mine.length === 0 && <div className="col-empty">{query ? 'No match' : lane ? '·' : 'Nothing here'}</div>}
      </section>
    );
  };
  return (
    <div className="pane sheet qb dispatch">
      <div className="pane-scroll">
        <section className="qb-head">
          <div className="qb-title">
            <span className="dsp-badge" aria-hidden="true"><i className={`dev-led ${attentionCount(s.quests) ? 'amber' : 'green'}`} /><Mark /><b>Vibe City</b>DISPATCH-1 · order rail</span>
            <h1 className="display" tabIndex={-1}>Ops board</h1>
            <p className="sync" aria-live="polite"><Icon n="refresh" size={12} />{withBoards.length === 0
              ? 'No floor has a Hermes board yet. Sync a floor to give it jobs.'
              : `Live from ${withBoards.length} Hermes board${withBoards.length === 1 ? '' : 's'} · ${all.length} job${all.length === 1 ? '' : 's'}`}</p>
            <div className="qb-layout" role="group" aria-label="Board layout">
              <button aria-pressed={layout === 'columns'} className={layout === 'columns' ? 'on' : ''} onClick={() => setLayout('columns')}>Columns</button>
              <button aria-pressed={layout === 'lanes'} className={layout === 'lanes' ? 'on' : ''} onClick={() => setLayout('lanes')}>By floor</button>
            </div>
            <div className="head-actions"><button className="dev-key hot" disabled={!canCreate} title={canCreate ? '' : 'No floor can take a job right now'} onClick={() => s.ui$({ composer: true, composerDept: dept })}>Print a job</button><button className="x boxed" onClick={leave} aria-label="Close the Ops board"><Icon n="x" /></button></div>
          </div>
          <div className="qb-floors" role="group" aria-label="Floor">
            <button aria-pressed={!dept} className={!dept ? 'on' : ''} onClick={() => s.ui$({ boardDept: null })}><Icon n="building" size={13} />All floors<span className="count">{onFloor(null).length}</span></button>
            {withBoards.map((d) => {
              const n = onFloor(d.id).length;
              const attn = all.filter((q) => q.deptId === d.id && columnOf(q.summary.status) === 'attention').length;
              return (
                <button key={d.id} aria-pressed={dept === d.id} className={dept === d.id ? 'on' : ''} onClick={() => s.ui$({ boardDept: dept === d.id ? null : d.id })} title={attn ? `${attn} need${attn === 1 ? 's' : ''} your attention` : undefined}>
                  <FloorKey n={String(floorNum(s.depts, d.id))} />{d.name}<span className="count">{n}</span>{attn > 0 && <i className="qb-attn" aria-label={`${attn} need attention`} />}
                </button>
              );
            })}
          </div>
          <div className="qb-tools" role="toolbar" aria-label="Filter, search and sort jobs">
            <div className="seg-row" role="group" aria-label="Filter by status">
              {(['all', 'active', 'attention', 'finished'] as const).map((k) => <button key={k} aria-pressed={f === k} className={f === k ? 'on' : ''} onClick={() => s.ui$({ boardFilter: k })}>{{ all: 'All', active: 'Active', attention: 'Attention', finished: 'Finished' }[k]}<span className="count">{count(k)}</span></button>)}
            </div>
            <label className="qb-search"><Icon n="search" size={14} /><input className="input" type="search" placeholder="Search jobs" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search jobs by title or floor" /></label>
            <div className="qb-by"><PixelSelect value={by} onChange={(v) => s.ui$({ boardBy: v as typeof by })} aria-describedby={undefined}
              options={[{ value: 'anyone', label: 'Assigned by anyone' }, { value: 'user', label: 'Assigned by you' }, { value: 'agent', label: 'Assigned by agents' }, { value: 'schedule', label: 'From schedules' }]} /></div>
            <div className="qb-sort"><PixelSelect value={sort} onChange={(v) => setSort(v as BoardSort)} aria-describedby={undefined}
              options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'title', label: 'Title A–Z' }]} /></div>
          </div>
        </section>
        <div aria-live="polite">
          {missing.length > 0 && (
            <div className={`banner qb-banner ${missing.some((m) => m.sync === 'not_loaded') ? 'bad' : 'warn'}`} role="status"><Glyph k="disconnected" />
              <div><b>{missing.some((m) => m.sync === 'not_loaded') ? 'Some jobs are missing from this board' : 'Some jobs may be out of date'}</b>{missing.map((m) => <p key={m.id}>{m.text}</p>)}</div></div>
          )}
        </div>
        {s.ui.composer && <QuestComposer targets={targets} />}
        {layout === 'columns' ? (
          <div className="board" style={{ ['--ncol' as string]: cols.length }}>{cols.map((c) => column(c, shown))}</div>
        ) : (
          <div className="lanes" style={{ ['--ncol' as string]: cols.length }}>
            <div className="lane-h" aria-hidden="true"><span />{cols.map((c) => <span key={c.key} style={{ color: statusColor(COL_GLYPH[c.key]) }}><Glyph k={COL_GLYPH[c.key]} />{c.title}</span>)}</div>
            {lanes(s.depts, shown).map((l) => (
              <section key={l.dept.id} className="lane" aria-label={`${l.floor} ${l.dept.name}: ${l.quests.length} jobs`}>
                <button className="lane-who" onClick={() => s.openFloor(l.dept.id)} title="Go to the floor">
                  <FloorKey n={l.floor.slice(1)} /><b>{l.dept.name}</b>
                  <span className="lane-crew">{l.dept.chief && <Portrait shirt="#fff" chief size={24} />}{l.dept.workers.slice(0, 4).map((w) => <Portrait key={w.id} shirt={w.shirt} size={24} />)}</span>
                  <small>{l.quests.length} job{l.quests.length === 1 ? '' : 's'}</small>
                </button>
                {cols.map((c) => column(c, l.quests, true))}
              </section>
            ))}
            {shown.length === 0 && <p className="col-empty">{query ? 'No match' : 'No jobs yet.'}</p>}
          </div>
        )}
      </div>
      {open && (
        <div className="qb-drawer-wrap">
          <button className="qb-scrim" aria-label="Close job details" onClick={() => s.ui$({ boardQuest: null })} />
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
  const [files, setFiles] = useState<File[]>([]);
  const [dept, setDept] = useState<string | null>(() => defaultTarget(targets, s.ui.composerDept));
  const reqId = useRef<{ fingerprint: string; id: string } | null>(null);
  const target = targets.find((t) => t.id === dept && !t.disabled) ?? null;
  const busy = !!(target && s.busy[`quest:${target.id}`]);
  const close = () => s.ui$({ composer: false, composerDept: null });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !title.trim() || !obj.trim() || busy) return;
    reqId.current = requestIdFor(JSON.stringify([target.id, title.trim(), obj.trim(), instr.trim()]), reqId.current, () => crypto.randomUUID());
    const id = await createQuest(target.id, { clientRequestId: reqId.current.id, title: title.trim(), objective: obj.trim(), ...(instr.trim() && { instructions: instr.trim() }) }, files);
    if (id) { setTitle(''); setObj(''); setInstr(''); setFiles([]); reqId.current = null; close(); }
  };
  return (
    <form className="composer printer" onSubmit={submit} aria-busy={busy} aria-labelledby="qc-h">
      <div className="printer-top" aria-hidden="true"><span className="dsp-badge"><i className={`dev-led ${busy ? 'amber' : 'green'}`} /><Mark /><b>Vibe City</b>PRINT-1 · job printer</span><span className="printer-slot" /></div>
      <div className="printer-paper">
      <h3 className="paper-h" id="qc-h">New job</h3>
      <Field label="Floor" hint="The job goes to this floor’s lead, who plans it and hands parts to teammates on the floor’s own board.">
        {(p) => (
          <PixelSelect {...p} value={dept ?? ''} onChange={(v) => setDept(v || null)} disabled={busy} placeholder="Choose a floor…"
            options={targets.map((t) => ({ value: t.id, label: t.label, disabled: !!t.disabled, ...(t.disabled ? { note: t.disabled } : {}) }))} />
        )}
      </Field>
      <Field label="Job title">{(p) => <input {...p} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoFocus />}</Field>
      <Field label="Objective">{(p) => <textarea {...p} className="input" rows={3} maxLength={8000} value={obj} onChange={(e) => setObj(e.target.value)} />}</Field>
      <Field label="Extra instructions (optional)">{(p) => <textarea {...p} className="input" rows={2} maxLength={8000} value={instr} onChange={(e) => setInstr(e.target.value)} />}</Field>
      <AttachTray files={files} onChange={setFiles} disabled={busy} />
      {target ? <small className="muted">Assigned to <b className="gold-n">{target.chief ? <AgentName deptId={target.id} agentKey="chief" /> : 'the lead'}</b></small> : <small className="muted">Choose a floor that is ready.</small>}
      {target && !s.conn.gateway && <p className="field-err"><Glyph k="awaiting" />{GATEWAY_WARNING}</p>}
      </div>
      <div className="printer-keys"><button className="dev-key hot" type="submit" aria-busy={busy || undefined} disabled={busy || !target || !title.trim() || !obj.trim()}>{busy ? (files.length ? 'Printing and attaching…' : 'Printing…') : 'Print to the rail'}</button><button className="dev-key" type="button" onClick={close} disabled={busy}>Cancel</button></div>
    </form>
  );
}

function QuestCard({ q, open }: { q: BoardQuest; open: boolean }) {
  const ui$ = useStore((s) => s.ui$);
  const detail = useStore((s) => s.details[q.summary.id]);
  const d = useStore((s) => s.depts.find((x) => x.id === q.deptId));
  const x = q.summary;
  const lines = cardLines(detail?.tasks);
  const k = questStatus(x.status);
  const origin = useStore((s) => s.origins[x.id]);
  const why = attentionReason(x);
  const crew = crewOf(detail?.tasks);
  const stamp = ticketStamp(x.status);
  const pct = x.counts.tasks ? Math.round((x.counts.done / x.counts.tasks) * 100) : 0;
  const cooking = x.status === 'running' || x.status === 'planning';
  return (
    <button className={`qcard ticket ${x.status}${open ? ' sel' : ''}${why ? ' attn-card' : ''}${stamp ? ' stamped' : ''}`} style={{ ['--st' as string]: statusColor(k) }} aria-expanded={open}
      onClick={() => ui$({ boardQuest: x.id })} aria-label={`${x.title}, ${STATUS[x.status].label}, ${q.deptName}${why ? `: ${why}` : ''}`}>
      <span className="tk-clip" aria-hidden="true" />
      <span className="tk-top">
        <span className="tk-no">#{x.id.slice(-4).toUpperCase()}</span>
        <span className="tk-dept">{q.floor} · {q.deptName}</span>
        <span className="tk-age" title={formatTime(x.createdAt)}>{age(x.createdAt)}</span>
      </span>
      <b className="tk-title">{x.title}</b>
      {(why || cooking || origin?.origin === 'agent' || origin?.origin === 'schedule') && <span className="tk-tags">
        {cooking && <span className="tk-live">{x.status === 'planning' ? 'Planning' : 'At work'}</span>}
        {why && <span className="tk-why"><Glyph k={k} size={9} />{why}</span>}
        {origin?.origin === 'agent' && origin.fromName && <span className="qcard-from" title={`Requested by ${origin.fromName}`}>from {origin.fromName}</span>}
        {origin?.origin === 'schedule' && <span className="qcard-from sched" title="Created by a schedule">scheduled</span>}
      </span>}
      <span className="tk-work">
        <span className="qcard-crew" aria-hidden="true">{crew.map((key) => {
          const w = d?.workers.find((y) => y.id === key);
          return key === 'chief' ? <Portrait key={key} shirt="#fff" chief size={20} /> : <Portrait key={key} shirt={w?.shirt ?? "#8E83B0"} size={20} />;
        })}</span>
        {x.counts.tasks > 0
          ? <span className="tk-prog" title={`${x.counts.done} of ${x.counts.tasks} tasks done`}><span className="tk-bar"><i style={{ width: `${pct}%` }} /></span><em>{x.counts.done}/{x.counts.tasks}</em></span>
          : <span className="tk-prog none"><em>no tasks yet</em></span>}
      </span>
      <span className="qcard-more" aria-hidden={!lines.plan && !lines.latest}>
        {lines.plan && <span className="qcard-line"><i>Plan</i>{lines.plan}</span>}
        {lines.latest && <span className={`qcard-line ${lines.latest.k}`}><Glyph k={lines.latest.k} size={8} />{lines.latest.text}</span>}
        {!lines.plan && !lines.latest && <span className="qcard-line muted">Open for the task tree and activity.</span>}
        {x.flags.unauthorizedAssignees && <span className="qcard-line failed"><Glyph k="awaiting" size={8} />Task outside this floor</span>}
      </span>
      {stamp && <span className={`tk-stamp ${stamp.tone}`} aria-hidden="true">{stamp.text}</span>}
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
            ? <button className="link" onClick={() => s.openPanel('dept')}><Icon n="back" size={14} />{s.depts.find((x) => x.id === s.ui.floorId)?.name ?? 'Floor'}</button>
            : <button className="link" onClick={() => s.openPanel('board')}><Icon n="back" size={14} />Ops board</button>}</div>
          <div className="title-row"><h1 className="display sm" tabIndex={-1}>{sum.title}</h1><Chip k={questStatus(sum.status)} label={STATUS[sum.status].label} /></div>
          <p className="meta"><span className="meta-f"><FloorKey n={'F' + floorNum(s.depts, item.deptId)} />{d?.name}</span><span>Lead <b className="gold-n">{d?.chief ? <AgentName deptId={d.id} agentKey="chief" /> : '—'}</b></span><span className="mono">{formatTime(sum.createdAt)}{sum.completedAt ? ` → ${formatTime(sum.completedAt)}` : ''}</span></p>
          <p className="fine">{STATUS[sum.status].hint}</p>
          <Tabs label="Job sections" idBase="quest" value={tab} onChange={setTab} options={(['overview', 'activity', 'results'] as const).map((t) => ({ key: t, label: t[0]!.toUpperCase() + t.slice(1) }))} />
        </section>
        <div aria-live="polite">
          {!s.conn.hermes && hasData && <div className="banner bad"><Glyph k="disconnected" /><div><b>Hermes is not reachable</b><p>Showing the last data received. It may be out of date.</p></div></div>}
          {extra?.error && <div className="banner bad" role="alert"><Glyph k="failed" /><div><b>{hasData ? 'Refresh failed: showing the last data received' : 'Could not load this job'}</b><p>{extra.error}</p><Btn kind="destructive" onClick={reload}>Retry</Btn></div></div>}
        </div>
        <div id="quest-panel" role="tabpanel" aria-labelledby={`quest-tab-${tab}`}>
          {tab === 'overview' && (
            <section className="pane-sec">
              {!detail && !extra?.error && <p className="muted" aria-busy="true">Loading…</p>}
              {detail && (
                <>
                  {note && <p className="note">{note}</p>}
                  {detail.warnings.map((w) => <div key={w} className="banner warn inline-b"><Glyph k="awaiting" /><div>{w}</div></div>)}
                  {detail.violations.length > 0 && <div className="banner bad inline-b"><Glyph k="failed" /><div><b>Tasks outside this floor</b>{detail.violations.map((v) => <p key={v}>{v}</p>)}<p className="fine">Detected, not prevented: Hermes cannot stop an agent from creating them.</p></div></div>}
                  <h3 className="sec-t">Objective</h3><p className="box-p">{objectiveText(detail.objective, sum.title) || 'No objective written.'}</p>
                  <ReferenceFiles deptId={item.deptId} questId={sum.id} status={sum.status} />
                  <h3 className="sec-t">Tasks <span className="count">{detail.counts.done}/{detail.counts.tasks} done</span></h3>
                  <TaskProgress c={detail.counts} />
                  <ul className="stack tasks">{treeRows(detail.tasks).map(({ node, depth }) => <TaskRow key={node.id} deptId={item.deptId} questId={sum.id} node={node} depth={depth} all={detail.tasks} />)}</ul>
                  {detail.truncated && <p className="note warn">Large job: the task tree was truncated by safety limits, so only part of it is shown and counts may be incomplete.</p>}
                  <CancellationSection deptId={item.deptId} questId={sum.id} status={sum.status} tasks={detail.tasks} />
                </>
              )}
            </section>
          )}
          {tab === 'activity' && (
            <section className="pane-sec" aria-busy={extra?.loading}>
              {extra?.loading && !extra.activity.length && <p className="muted">Loading…</p>}
              {extra && !extra.loading && !extra.error && !extra.activity.length && <p className="muted">No events yet.</p>}
              <ol className="timeline">{[...(extra?.activity ?? [])].reverse().map((e) => {
                const bad = /fail|block|crash|timed/i.test(e.kind);
                return <li key={e.id}><span className="mono muted" title={formatTime(e.at)}>{clock(e.at)}</span><Glyph k={bad ? 'failed' : /complet/i.test(e.kind) ? 'completed' : 'running'} />
                  <span><span>{e.label}</span> <small className="muted">{e.taskTitle}</small>{e.detail && <small className={bad ? 'err-t' : 'muted'}>{e.detail}</small>}</span></li>;
              })}</ol>
              {ACTIVE.has(sum.status) && <p className="muted small live"><Glyph k="running" />Live · refreshes when Hermes reports an event</p>}
            </section>
          )}
          {tab === 'results' && <ResultsSection deptId={item.deptId} status={sum.status} extra={extra} />}
        </div>
      </div>
    </div>
  );
}

/** How far the work is, as one bar: done, at work, waiting, stuck and failed, with words only for what is there. */
function TaskProgress({ c }: { c: { tasks: number; done: number; running: number; pending: number; blocked: number; failed: number; archived: number } }) {
  const parts = [['done', c.done, 'done', 'completed'], ['run', c.running, 'at work', 'running'], ['pend', c.pending, 'waiting to start', 'todo'], ['blk', c.blocked, 'stuck, need you', 'blocked'], ['fail', c.failed, 'failed', 'failed']] as const;
  const total = Math.max(1, c.tasks);
  return (
    <div className="tprog">
      <div className="tprog-bar" role="img" aria-label={parts.filter(([, n]) => n).map(([, n, w]) => `${n} ${w}`).join(', ') || 'No tasks yet'}>
        {parts.map(([k, n, , g]) => n > 0 && <i key={k} style={{ flexGrow: n / total, background: statusColor(g) }} />)}
      </div>
      <p className="tprog-legend">{parts.filter(([, n]) => n).map(([k, n, w, g]) => <span key={k}><i style={{ background: statusColor(g) }} />{n} {w}</span>)}{c.archived > 0 && <span className="muted">{c.archived} archived</span>}</p>
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
      <button type="button" className="trow" aria-expanded={open} aria-controls={did} onClick={() => setOpen(!open)} style={{ ['--c' as string]: statusColor(v.k) }}>
        <span className="tr-st"><Glyph k={v.k} /></span>
        <span className="tr-main"><b>{node.title}</b><small>{node.agentKey || node.assignee ? <AgentName deptId={deptId} agentKey={node.agentKey} /> : 'Unassigned'}{warn && <span className="err small"><Glyph k="awaiting" />outside the floor</span>}</small></span>
        <span className="tr-pill">{v.label}</span>
        <svg className="tr-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 5.5 7 8.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
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
              {v.archived.length > 0 && <><h4 className="mini-h">Archived by Vibe City ({v.archived.length})</h4><ul className="ids">{v.archived.map((r) => <li key={r.id}>{r.title}</li>)}</ul><p className="fine">Archived unfinished tasks cannot be dispatched again. Create a new job to redo the work.</p></>}
              {v.finished.length > 0 && <><h4 className="mini-h">Already finished, left untouched ({v.finished.length})</h4><ul className="ids">{v.finished.map((r) => <li key={r.id}>{r.title}</li>)}</ul><p className="fine">Their summaries and files stay in Results.</p></>}
            </div>
          </div>
        )}
      </div>
      {canCancel(status) && !confirming && (
        <Btn kind="destructive" busy={busy} disabled={busy || !s.conn.hermes} onClick={() => setConfirming(true)}>{busy ? 'Requesting…' : c?.state === 'requested' ? 'Request cancellation again' : 'Cancel job…'}</Btn>
      )}
      {confirming && (
        <div className="confirm" role="group" aria-labelledby={`cc-${questId}`}>
          <b id={`cc-${questId}`}>Cancel this job?</b>
          <ul className="conseq">{CANCEL_CONFIRM.map((t) => <li key={t}>{t}</li>)}</ul>
          <div className="row"><Btn kind="destructive" busy={busy} disabled={busy} onClick={() => { setConfirming(false); void cancelQuest(deptId, questId); }}>Yes, cancel the job</Btn><Btn onClick={() => setConfirming(false)}>Keep it running</Btn></div>
        </div>
      )}
      {canCancel(status) && !s.conn.hermes && <small className="muted">Cancelling needs Hermes to be reachable.</small>}
    </section>
  );
}

function ResultsSection({ deptId, status, extra }: { deptId: string; status: QuestStatus; extra: ReturnType<typeof useStore.getState>['extra'][string] | undefined }) {
  const r = extra?.results;
  // the CEO's own reference files are listed on the overview, not as output
  const tasks = r?.tasks.map((t) => ({ ...t, attachments: t.attachments.filter((a) => !a.fromCeo) }));
  const withOutput = tasks?.filter((t) => t.summary || t.error || t.attachments.length) ?? [];
  const silent = (tasks?.length ?? 0) - withOutput.length;
  return (
    <section className="pane-sec" aria-busy={extra?.loading}>
      {extra?.loading && !r && <p className="muted">Loading…</p>}
      {r && (
        <>
          {status === 'cancelling' || status === 'cancelled' ? <p className="fine">Results of tasks that finished before the cancellation are kept below.</p> : null}
          {r.leadSummary ? <><h3 className="sec-t">Summary from the lead</h3><p className="box-p">{r.leadSummary}</p></> : status !== 'completed' && <div className="empty"><Icon n="file" size={40} sw={1.5} /><b>Nothing final yet</b><p>The lead’s summary and any files appear as tasks finish. The job is complete only when every task is done.</p></div>}
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
  // brief 01: the form opens on the template grid; a picked template pre-fills every step
  const [picking, setPicking] = useState(true);
  const [tpl, setTpl] = useState<HireTemplate | null>(null);
  const open = s.ui.modal === 'create';
  useEffect(() => {
    if (!open) return;
    setPicking(true); setTpl(null);
    setStep(0); setName(''); setPurpose(''); setDefaults(null); setLoadErr(null); setCatalog(null); setCatalogErr(null); setToolsets([]); setSkills([]); setModel(null); setFilter(''); setWorkers(0); setProvisionNow(true);
  }, [open]);
  if (!open) return null;
  const busy = !!s.busy.create || !!Object.keys(s.busy).find((k) => k.startsWith('provision:') && s.busy[k]);
  const next = s.depts.length + 1;

  const fromTemplate = (t: HireTemplate) => {
    setToolsets(t.inventory.allowedToolsets.filter(isToolset)); setSkills(t.inventory.allowedSkillIds); setModel(t.inventory.model);
  };
  const pick = (t: HireTemplate | null) => {
    setTpl(t); setPicking(false); setStep(0);
    if (t) { setName(t.name); setPurpose(t.purpose); setWorkers(t.seats.length - 1); fromTemplate(t); }
  };
  const applyDefaults = (v: HermesDefaultsView, cat: HermesModelsView | null = catalog) => {
    // The default profile's current pair, when Hermes offers it.
    const cur = cat?.current;
    const offered = cur?.provider && cur.model && cat!.providers.some((p) => p.slug === cur.provider && p.models.includes(cur.model!));
    const current = offered ? { provider: cur!.provider!, id: cur!.model! } : null;
    if (tpl) {
      fromTemplate(tpl);
      // a template that names no model gets NEAR AI's private default when Hermes offers it, else the current one
      const priv = cat?.providers.find((p) => p.models.includes(DEFAULT_CHAT_MODEL));
      if (!tpl.inventory.model) setModel(priv ? { provider: priv.slug, id: DEFAULT_CHAT_MODEL } : current);
      return;
    }
    setToolsets(v.toolsets.filter((t) => t.enabled && t.manageable).map((t) => t.name).filter(isToolset));
    setSkills(v.skills.filter((x) => x.enabled).map((x) => x.name));
    setModel(current);
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
      ...(tpl ? { template: tpl.id } : {}),
    }, provisionNow && canProvision);
  };

  return (
    <DeskSheet title={picking ? 'Hire a floor' : 'New floor'} wide onClose={() => s.ui$({ modal: null })} className="create">
      <form className={`modal wide${!picking && step === 1 ? " caps" : ""}`} aria-labelledby="cd-t" aria-busy={busy}
        onSubmit={(e) => { e.preventDefault(); if (step < 2) { if (name.trim()) go(step + 1); } else submit(); }}>
        <div className="head-row"><Where n={'F' + next} tone="amber">New floor</Where></div>
        <h2 id="cd-t" className="display">{picking ? 'Hire a floor' : tpl ? `Hire the ${tpl.name}` : 'Create a floor'}</h2>
        {picking && <HireGrid onPick={pick} onBlank={() => pick(null)} onAssistant={() => s.ui$({ modal: null, newDept: true })} questTitle={(id) => s.game?.quests.find((q) => q.id === id)?.title ?? null} />}
        {!picking && <>
        <ol className="wiz-steps" aria-label="Steps">
          {WIZARD_STEPS.map((t, i) => <li key={t} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span className="num">{i + 1}</span>{t}</li>)}
        </ol>

        {step === 0 && <>
          <p className="sub">Each floor gets a Hermes board and one Hermes profile per agent. Next you choose what its agents may use.</p>
          <Field label="Floor name" hint="Shown on the floor sign. Up to 32 characters. Must be unique.">
            {(p) => <input {...p} className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <Field label="Purpose / objective" hint="Every agent reads this when it works on jobs.">
            {(p) => <textarea {...p} className="input" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
          </Field>
        </>}

        {step === 1 && <>
          <p className="sub">Pre-filled from Hermes’ <b className="mono">default</b> profile. Change anything; what you save here is copied into the floor and later changes to the default profile do not affect it.</p>
          <div aria-live="polite">
            {loading && <p className="muted small" role="status">Reading the default profile from Hermes…</p>}
            {loadErr && <div className="banner warn" role="alert"><Glyph k="awaiting" /><div><b>Could not read Hermes’ default profile</b><p>{loadErr}</p><Btn kind="secondary" onClick={() => void load()}>Try again</Btn></div></div>}
          </div>
          {defaults && <>
            <h3 className="inv-h">Tools <span>{toolsets.length} on</span></h3>
            <p className="fine">{tpl ? `Picked for the ${tpl.name}: what its work needs and the basics. Risky tools reach outside the company or run code; leave them off unless the work needs them.` : 'Risky tools reach outside the company or run code; give them only to floors whose work needs them.'}</p>
            <ToolPicker tools={defaults.toolsets.filter((t) => shownToolset(t.name))} selected={toolsets} needs={stationFor(tpl?.id)?.toolsets ?? []}
              onToggle={(t) => { if (isToolset(t)) toggle(toolsets, setToolsets, t); }} />
            <h3 className="inv-h">Skills <span>{skills.length} equipped</span></h3>
            <p className="fine">Click a card to equip or unequip it. Every agent on the floor carries these{tpl ? ', and each seat brings its own on top' : ''}.</p>
            <SkillPicker installed={defaults.skills} selected={skills} onChange={setSkills} featured={tpl ? [...new Set([...tpl.inventory.allowedSkillIds, ...tpl.seats.flatMap((x) => x.skills)])] : []} />
            <ModelPicker label="Model" hint={`The agents’ default model, from Hermes’ list. The default profile uses ${catalog?.current.model ?? defaults.model ?? 'none'}${catalog?.current.provider ? ` via ${catalog.current.provider}` : ''}. Hermes cannot stop an agent from picking another model.`}
              models={catalog} error={catalogErr} value={model} onChange={setModel}
              onRetry={() => void loadHermesModels().then((m) => { setCatalog(m.value); setCatalogErr(m.value ? null : m.error?.message ?? 'Could not read the model list from Hermes.'); })} />
            <button type="button" className="link" onClick={() => applyDefaults(defaults)}>Reset to Hermes defaults</button>
          </>}
        </>}

        {step === 2 && <>
          {tpl ? <p className="sub">The team comes with the template: {tpl.seats.map((x, i) => <span key={x.title}>{i ? ' · ' : ''}<b>{x.title}</b>{i === 0 ? ' (lead)' : ''}</span>)}.</p>
          : <Field label="Teammates (0–10)" hint={workers === 0 ? 'No teammates: the lead does the work itself. You can hire more later.' : `The lead may hand parts of a job to its teammates. ${LIMIT_COPY.teammates}`}>
            {(p) => <input {...p} className="input mono" type="number" min={0} max={10} value={workers} onChange={(e) => setWorkers(Math.max(0, Math.min(10, Math.round(Number(e.target.value)) || 0)))} />}
          </Field>}
          <KV rows={[
            ['Name', name.trim()],
            ['Toolsets', <span className="mono">{[...toolsets].sort().join(', ') || 'none'}</span>],
            ['Skills', skills.length ? `${skills.length} enabled` : 'none (Hermes keeps hermes-agent on)'],
            ['Model', <span className="mono">{model ? `${model.id} · ${model.provider}` : 'profile default'}</span>],
            ['Agents', workers === 0 ? '1 · the lead alone' : `${workers + 1} · a lead + ${workers} teammate${workers === 1 ? '' : 's'}`],
          ]} />
          <label className="consent"><input type="checkbox" checked={provisionNow && canProvision} disabled={!canProvision} onChange={(e) => setProvisionNow(e.target.checked)} />
            <span>Sync now: create the board and {workers > 0 ? `${workers + 1} agent profiles` : 'the lead\'s profile'} in Hermes and apply these settings.{!canProvision && ' Hermes is not reachable, so the floor is only saved; sync it from its floor later.'}</span></label>
        </>}

        <div className="row end">
          {step === 0 ? <Btn onClick={() => setPicking(true)}>Back</Btn> : <Btn onClick={() => setStep(step - 1)} disabled={busy}>Back</Btn>}
          {step < 2
            ? <button className="btn primary lg" type="submit" disabled={!name.trim() || (step === 1 && loading)}>{step === 1 && !defaults ? 'Continue without defaults' : 'Next'}</button>
            : <button className="btn primary lg" type="submit" aria-busy={busy || undefined} disabled={!name.trim() || busy}>{busy ? (s.busy.create ? 'Creating…' : 'Syncing…') : provisionNow && canProvision ? 'Create and sync' : 'Create floor'}</button>}
        </div>
        </>}
      </form>
    </DeskSheet>
  );
}

/** A floor's purpose is the brief every agent reads, often a paragraph of instructions. The panel shows its first
    sentence; the rest is one click away. */
function Purpose({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const m = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  const first = m?.[1] ?? text, rest = text.trim().slice(first.length).trim();
  if (!rest) return <p className="sub">{text}</p>;
  return (
    <div className="purpose">
      <p className="sub">{first}{!open && <> <button type="button" className="link small" aria-expanded={false} onClick={() => setOpen(true)}>Team brief</button></>}</p>
      {open && <p className="sub purpose-rest">{rest} <button type="button" className="link small" aria-expanded onClick={() => setOpen(false)}>Hide</button></p>}
    </div>
  );
}
