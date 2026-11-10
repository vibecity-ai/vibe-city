/* Screens opened from objects in the Executive Office (feature spec 3.1): the money screen behind the safe (spec 6.1)
   and the schedules behind the calendar (spec 8). The kanban board on the wall opens the Ops board itself. */
import { useStore } from '../store';
import { DeskSheet } from './Desk';
import { SchedulesView } from './Schedules';
import { MoneyScreen } from './Money';

export function ExecRoomModal() {
  const m = useStore((s) => s.ui.execModal);
  const depts = useStore((s) => s.depts);
  const scheduleDept = useStore((s) => s.ui.scheduleDept);
  const close = () => useStore.getState().ui$({ execModal: null, scheduleDept: null });
  if (!m) return null;
  const title = m === 'calendar' && scheduleDept ? `Schedules · ${depts.find((d) => d.id === scheduleDept)?.name ?? ''}` : { safe: 'The safe', calendar: 'Calendar' }[m];
  return (
    <DeskSheet title={title} onClose={close} className={`exec-modal${m === 'safe' ? ' devhost' : ''}`}>
        <header className="hire-head">
          <div><span className="dlg-tag">Executive office</span><h2>{title}</h2></div>
        </header>
        {m === 'safe' && <MoneyScreen />}
        {m === 'calendar' && <SchedulesView deptId={scheduleDept} />}
    </DeskSheet>
  );
}
