import { useEffect, useMemo, useState } from 'react';
import type { DepartmentView } from '@vibe-city/shared';
import { api } from '../api.ts';
import { connectionBanner } from './format.ts';
import { useLive, useLoad } from '../hooks.ts';
import { CreateQuestForm, QuestDetailView, QuestList } from './components.tsx';

export function App() {
  const departments = useLoad(() => api.departments(), []);
  const health = useLoad(() => api.health(), []);
  const [deptId, setDeptId] = useState<string | null>(null);
  const [questId, setQuestId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const depts = departments.data ?? [];
  const selected: DepartmentView | undefined = depts.find((d) => d.id === deptId);
  const ready = selected?.state === 'ready';

  useEffect(() => {
    if (!deptId && depts.length) setDeptId((depts.find((d) => d.state === 'ready') ?? depts[0])!.id);
  }, [depts, deptId]);

  const quests = useLoad(selected && selected.hermesBoardRef ? () => api.quests(selected.id) : null, [selected?.id]);

  // one refresh signal for everything that depends on Hermes state
  const [signal, setSignal] = useState(0);
  const live = useLive(selected?.hermesBoardRef ? selected.id : null, () => { setSignal((x) => x + 1); quests.reload(); health.reload(); });
  const banner = connectionBanner(live.link, live.hermes);

  const hermesDown = health.data?.hermes.dashboard === 'down' || quests.error?.hermesUnavailable;
  const questList = useMemo(() => quests.data ?? [], [quests.data]);

  return (
    <div className="app">
      <header className="top">
        <h1>VIBE CITY <span className="tag">Quest Board</span></h1>
        <label className="picker">
          <span>Department</span>
          <select value={deptId ?? ''} onChange={(e) => { setDeptId(e.target.value || null); setQuestId(null); setCreating(false); }} disabled={!depts.length}>
            {!depts.length && <option value="">No departments</option>}
            {depts.map((d) => <option key={d.id} value={d.id}>{d.name}{d.state !== 'ready' ? ` (${d.state})` : ''}</option>)}
          </select>
        </label>
        <HermesChip health={health.data} failed={!!health.error} />
      </header>

      {banner && <div role="status" className={`banner ${banner.tone}`}>{banner.text}</div>}
      {departments.error && <div role="alert" className="banner bad">Could not load departments: {departments.error.message}</div>}

      {!departments.loading && !departments.error && !depts.length && (
        <Empty title="No departments yet" text="Create and provision a department first (Milestones 1–2 API). Quests run inside a provisioned department." />
      )}

      {selected && !selected.hermesBoardRef && (
        <Empty title={`${selected.name} is not provisioned`} text={`State: ${selected.state}. Provision this department against Hermes before creating quests.`} />
      )}

      {selected && selected.hermesBoardRef && (
        <main className="layout">
          <section className="col list" aria-label="Quests">
            <div className="row">
              <h2>Quests</h2>
              <button className="primary" onClick={() => { setCreating(true); setQuestId(null); }} disabled={!ready || !!hermesDown}
                title={!ready ? `Department is ${selected.state}` : undefined}>New quest</button>
            </div>
            {!ready && <p className="note warn">This department is <b>{selected.state}</b>; new quests are disabled. Existing quests are still shown.</p>}
            <QuestList
              quests={questList} loading={quests.loading && !quests.data} error={quests.error} stale={quests.stale}
              selectedId={questId} onSelect={(id) => { setQuestId(id); setCreating(false); }} onRetry={quests.reload}
            />
          </section>
          <section className="col detail" aria-label="Quest details">
            {creating && ready && (
              <CreateQuestForm
                departmentId={selected.id} disabled={!!hermesDown}
                onCreated={(id) => { setCreating(false); setQuestId(id); quests.reload(); }} onCancel={() => setCreating(false)}
              />
            )}
            {!creating && questId && <QuestDetailView key={questId} departmentId={selected.id} questId={questId} refreshSignal={signal} onChanged={quests.reload} />}
            {!creating && !questId && <Empty title="Select a quest" text="Pick a quest on the left, or create a new one." />}
          </section>
        </main>
      )}
    </div>
  );
}

function HermesChip({ health, failed }: { health: ReturnType<typeof useLoad<import('@vibe-city/shared').HealthView>>['data']; failed: boolean }) {
  if (failed) return <span className="chip bad" role="status">Backend unreachable</span>;
  if (!health) return <span className="chip" role="status">Checking Hermes…</span>;
  const h = health.hermes;
  if (h.dashboard === 'down') return <span className="chip bad" role="status">Hermes dashboard offline</span>;
  if (h.auth === 'rejected') return <span className="chip bad" role="status">Hermes rejected the token</span>;
  if (h.gateway !== 'running') return <span className="chip warn" role="status">Hermes gateway not running</span>;
  return <span className="chip good" role="status">Hermes {h.version ?? ''} connected</span>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><h3>{title}</h3><p>{text}</p></div>;
}
