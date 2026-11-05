/* Screens opened from objects in the Executive Office (feature spec 3.1): the org chart behind the tower map, and the
   safe and calendar, which say plainly what is not built yet (money is spec section 6, schedules section 8). */
import { useRef } from 'react';
import { useStore, floorNum } from '../store';
import { Glyph, Icon, deptStatus, useDialog } from './kit';
import { SchedulesView } from './Schedules';
import type { Dept } from '../data/types';
import { AgentName } from './AgentView';

/** Agents working right now: the lead and the teammates with a running task. */
const busyOf = (d: Dept) => (d.chief?.status === 'running' ? 1 : 0) + d.workers.filter((w) => w.status === 'running').length;

export function ExecRoomModal() {
  const m = useStore((s) => s.ui.execModal);
  const depts = useStore((s) => s.depts);
  const quests = useStore((s) => s.quests);
  const ref = useRef<HTMLDivElement>(null);
  const scheduleDept = useStore((s) => s.ui.scheduleDept);
  const close = () => useStore.getState().ui$({ execModal: null, scheduleDept: null });
  useDialog(ref, !!m, close);
  if (!m) return null;
  const open = (id: string) => { close(); useStore.getState().openFloor(id); };
  return (
    <div className="hire-scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="hire exec-modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="em-t">
        <header className="hire-head">
          <div><span className="dlg-tag">Executive office</span><h2 id="em-t">{m === 'calendar' && scheduleDept ? `Schedules · ${depts.find((d) => d.id === scheduleDept)?.name ?? ''}` : { org: 'Org chart', safe: 'The safe', calendar: 'Calendar' }[m]}</h2></div>
          <button className="dlg-icon" onClick={close} aria-label="Close"><Icon n="x" size={14} /></button>
        </header>
        {m === 'org' && (
          <ol className="org">
            <li className="org-row ph"><span className="fkey gold">PH</span><b>Executive office</b><span className="muted">You, the assistant, AR</span></li>
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
                    <span className="muted">{active} active quest{active === 1 ? '' : 's'}</span>
                    <span className="org-st"><Glyph k={st.k} />{st.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {m === 'safe' && (
          <div className="exec-note">
            <p>The safe will hold three separate pots, never added together: <b>credits</b> the agents spend on models, your <b>NEAR wallet</b>, and the <b>company treasury</b> in a Sputnik DAO multisig.</p>
            <p className="muted">Not connected yet (feature spec section 6). Nothing in the game can move money today, and agents will never hold keys: spending is always signed by people.</p>
          </div>
        )}
        {m === 'calendar' && <SchedulesView deptId={scheduleDept} />}
      </div>
    </div>
  );
}
