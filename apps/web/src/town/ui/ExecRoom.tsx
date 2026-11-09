/* Screens opened from objects in the Executive Office (feature spec 3.1): the org chart behind the tower map, and the
   the money screen behind the safe (spec 6.1) and the schedules behind the calendar (spec 8). */
import { useStore, floorNum } from '../store';
import { Glyph, deptStatus } from './kit';
import { DeskSheet } from './Desk';
import { SchedulesView } from './Schedules';
import { MoneyScreen } from './Money';
import type { Dept } from '../data/types';
import { AgentName } from './AgentView';

/** Agents working right now: the lead and the teammates with a running task. */
const busyOf = (d: Dept) => (d.chief?.status === 'running' ? 1 : 0) + d.workers.filter((w) => w.status === 'running').length;

export function ExecRoomModal() {
  const m = useStore((s) => s.ui.execModal);
  const depts = useStore((s) => s.depts);
  const quests = useStore((s) => s.quests);
  const scheduleDept = useStore((s) => s.ui.scheduleDept);
  const close = () => useStore.getState().ui$({ execModal: null, scheduleDept: null });
  if (!m) return null;
  const open = (id: string) => { close(); useStore.getState().openFloor(id); };
  const title = m === 'calendar' && scheduleDept ? `Schedules · ${depts.find((d) => d.id === scheduleDept)?.name ?? ''}` : { org: 'Org chart', safe: 'The safe', calendar: 'Calendar' }[m];
  return (
    <DeskSheet title={title} onClose={close} className={`exec-modal${m === 'safe' ? ' devhost' : ''}`}>
        <header className="hire-head">
          <div><span className="dlg-tag">Executive office</span><h2>{title}</h2></div>
        </header>
        {m === 'org' && (
          <ol className="org">
            <li className="org-row ph"><span className="fkey gold">PH</span><b>Executive office</b><span className="muted">You and your Chief of Staff</span></li>
            {depts.map((d) => {
              const st = deptStatus(d.state);
              const active = quests.filter((q) => q.deptId === d.id && !['completed', 'cancelled'].includes(q.summary.status)).length;
              return (
                <li key={d.id}>
                  <button className="org-row" onClick={() => open(d.id)}>
                    <span className="fkey cyan">F{floorNum(depts, d.id)}</span>
                    <b>{d.name}</b>
                    <span className="org-chief">{d.chief ? <><Glyph k={d.chief.status} /> <AgentName deptId={d.id} agentKey="chief" /></> : <span className="muted">no lead yet</span>}</span>
                    <span className="org-seats" aria-label={`${busyOf(d)} of ${d.teamSize} agents busy`}>{Array.from({ length: d.teamSize }, (_, i) => <i key={i} className={i < busyOf(d) ? 'on' : ''} />)}</span>
                    <span className="muted">{active} active job{active === 1 ? '' : 's'}</span>
                    <span className="org-st"><Glyph k={st.k} />{st.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {m === 'safe' && <MoneyScreen />}
        {m === 'calendar' && <SchedulesView deptId={scheduleDept} />}
    </DeskSheet>
  );
}
