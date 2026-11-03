import { useEffect, useRef, useState } from 'react';
import type { ActivityEvent, CancellationStatus, QuestStatus, QuestSummary } from '@vibe-city/shared';
import { api, ApiError } from '../api.ts';
import { STATUS, canCancel, formatBytes, formatTime, planningNote, requestIdFor, treeRows } from './format.ts';
import { useLoad } from '../hooks.ts';

export function StatusBadge({ status }: { status: QuestStatus }) {
  const s = STATUS[status];
  return <span className={`badge ${s.tone}`} title={s.hint}>{s.label}</span>;
}

function TaskStatus({ status, failed }: { status: string; failed: boolean }) {
  const tone = failed ? 'bad' : status === 'done' ? 'good' : status === 'running' ? 'active' : status === 'blocked' || status === 'review' ? 'warn' : 'neutral';
  return <span className={`badge small ${tone}`}>{failed ? 'failed' : status}</span>;
}

function ErrorNote({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div role="alert" className={`banner ${error.hermesUnavailable ? 'warn' : 'bad'}`}>
      {error.hermesUnavailable
        ? 'Hermes is unavailable, so this cannot be loaded right now. Nothing is shown rather than guessing.'
        : error.code === 'backend_unreachable' ? error.message : `Request failed: ${error.message}`}
      {onRetry && <button className="link" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function QuestList(p: {
  quests: QuestSummary[]; loading: boolean; error: ApiError | null; stale: boolean;
  selectedId: string | null; onSelect: (id: string) => void; onRetry: () => void;
}) {
  if (p.loading) return <p className="note" aria-busy="true">Loading quests…</p>;
  if (p.error && !p.quests.length) return <ErrorNote error={p.error} onRetry={p.onRetry} />;
  return (
    <>
      {p.error && p.stale && <ErrorNote error={p.error} onRetry={p.onRetry} />}
      {p.error && p.stale && <p className="note warn">Showing the last data received; it may be out of date.</p>}
      {!p.quests.length && !p.error && <div className="empty"><h3>No quests yet</h3><p>Create a quest to give this department a goal.</p></div>}
      <ul className="quests">
        {p.quests.map((q) => (
          <li key={q.id}>
            <button className={`quest ${p.selectedId === q.id ? 'sel' : ''}`} onClick={() => p.onSelect(q.id)} aria-current={p.selectedId === q.id}>
              <span className="qtitle">{q.title}</span>
              <StatusBadge status={q.status} />
              <span className="qmeta">{q.counts.done}/{q.counts.tasks} tasks done · {formatTime(q.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function CreateQuestForm(p: { departmentId: string; disabled: boolean; onCreated: (id: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const reqId = useRef<{ fingerprint: string; id: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Same content -> same clientRequestId, so a retry after a timeout cannot create a duplicate quest.
    reqId.current = requestIdFor(JSON.stringify([title, objective, instructions]), reqId.current, () => crypto.randomUUID());
    try {
      const r = await api.createQuest(p.departmentId, {
        clientRequestId: reqId.current.id, title, objective, ...(instructions.trim() ? { instructions } : {}),
      });
      setWarnings(r.warnings);
      if (!r.warnings.length) p.onCreated(r.questId);
      else { setBusy(false); setTimeout(() => p.onCreated(r.questId), 2500); }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} aria-label="Create quest">
      <h2>New quest</h2>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={busy} /></label>
      <label>Objective<textarea value={objective} onChange={(e) => setObjective(e.target.value)} required rows={5} maxLength={8000} disabled={busy}
        placeholder="What should this department achieve?" /></label>
      <label>Execution instructions <span className="muted">(optional)</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={8000} disabled={busy} /></label>
      {error && <ErrorNote error={error} />}
      {warnings.map((w) => <div key={w} role="status" className="banner warn">{w}</div>)}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || p.disabled || !title.trim() || !objective.trim()}>{busy ? 'Creating…' : 'Create quest'}</button>
        <button type="button" onClick={p.onCancel} disabled={busy}>Cancel</button>
      </div>
      {p.disabled && <p className="note warn">Hermes is unavailable; quests cannot be created right now.</p>}
    </form>
  );
}

type Tab = 'overview' | 'tasks' | 'activity' | 'results';

export function QuestDetailView(p: { departmentId: string; questId: string; refreshSignal: number; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('overview');
  const detail = useLoad(() => api.quest(p.departmentId, p.questId), [p.departmentId, p.questId, p.refreshSignal]);
  const q = detail.data;

  if (detail.loading && !q) return <p className="note" aria-busy="true">Loading quest…</p>;
  if (detail.error && !q) return <ErrorNote error={detail.error} onRetry={detail.reload} />;
  if (!q) return null;
  const note = planningNote(q);

  return (
    <article className="quest-detail">
      <header className="row between">
        <div>
          <h2>{q.title}</h2>
          <p className="muted">Hermes task <code>{q.id}</code></p>
        </div>
        <StatusBadge status={q.status} />
      </header>
      {detail.error && <ErrorNote error={detail.error} onRetry={detail.reload} />}
      {detail.stale && <p className="note warn">Showing the last data received; it may be out of date.</p>}
      <nav className="tabs" role="tablist">
        {(['overview', 'tasks', 'activity', 'results'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div role="tabpanel">
          <p>{STATUS[q.status].hint}</p>
          {note && <p className="note">{note}</p>}
          <dl className="facts">
            <dt>Tasks</dt><dd>{q.counts.tasks} total · {q.counts.done} done · {q.counts.running} running · {q.counts.pending} waiting{q.counts.blocked ? ` · ${q.counts.blocked} blocked` : ''}{q.counts.failed ? ` · ${q.counts.failed} failed` : ''}</dd>
            <dt>Created</dt><dd>{formatTime(q.createdAt)}</dd>
            <dt>Completed</dt><dd>{formatTime(q.completedAt)}</dd>
          </dl>
          <h3>Objective</h3>
          <pre className="text">{q.objective || '—'}</pre>
          {q.violations.length > 0 && (
            <div role="alert" className="banner bad"><b>Unexpected assignments</b><ul>{q.violations.map((v) => <li key={v}>{v}</li>)}</ul>
              <span>These tasks are outside this department's chief/worker profiles. Vibe City cannot prevent them; review before trusting the results.</span></div>
          )}
          {q.warnings.map((w) => <p key={w} className="note warn">{w}</p>)}
          <CancelPanel departmentId={p.departmentId} questId={p.questId} status={q.status} cancellation={q.cancellation}
            onChanged={() => { detail.reload(); p.onChanged(); }} />
        </div>
      )}
      {tab === 'tasks' && (
        <div role="tabpanel">
          <ul className="tree">
            {treeRows(q.tasks).map(({ node, depth }) => (
              <li key={node.id} style={{ marginLeft: depth * 20 }}>
                <div className="task">
                  <span className="ttitle">{node.title}</span>
                  <TaskStatus status={node.status} failed={node.failed} />
                  <span className="muted">{node.role === 'chief' ? 'chief' : node.role === 'worker' ? 'worker' : 'other profile'} · {node.assignee ?? 'unassigned'}</span>
                  {node.error && <span className="err">{node.error}</span>}
                  {node.runs.length > 0 && <span className="muted">{node.runs.length} run{node.runs.length > 1 ? 's' : ''}; latest {node.runs.at(-1)!.state}</span>}
                </div>
              </li>
            ))}
          </ul>
          {q.truncated && <p className="note warn">Only part of a very large task tree is shown.</p>}
        </div>
      )}
      {tab === 'activity' && <ActivityTab departmentId={p.departmentId} questId={p.questId} refreshSignal={p.refreshSignal} />}
      {tab === 'results' && <ResultsTab departmentId={p.departmentId} questId={p.questId} refreshSignal={p.refreshSignal} />}
    </article>
  );
}

function CancelPanel(p: { departmentId: string; questId: string; status: QuestStatus; cancellation: CancellationStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [confirming, setConfirming] = useState(false);
  const c = p.cancellation;

  // while a cancellation is pending, keep asking Hermes (via the backend) until it confirms
  useEffect(() => {
    if (c.state !== 'requested') return;
    const t = setInterval(p.onChanged, 3000);
    return () => clearInterval(t);
  }, [c.state, p.onChanged]);

  const request = async () => {
    setBusy(true); setError(null);
    try { await api.cancel(p.departmentId, p.questId); } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'error', String(e))); }
    setBusy(false); setConfirming(false); p.onChanged();
  };

  return (
    <section className="cancel" aria-label="Cancellation">
      <h3>Cancellation</h3>
      {c.state === 'none' && canCancel(p.status) && !confirming && <button className="danger" onClick={() => setConfirming(true)}>Cancel quest…</button>}
      {confirming && (
        <div className="confirm" role="alertdialog" aria-label="Confirm cancellation">
          <p>This stops all unfinished tasks of this quest. Finished work and its results are kept.</p>
          <button className="danger" onClick={request} disabled={busy}>{busy ? 'Requesting…' : 'Yes, request cancellation'}</button>
          <button onClick={() => setConfirming(false)} disabled={busy}>Keep running</button>
        </div>
      )}
      {c.state === 'requested' && (
        <p className="note warn" role="status">Cancellation requested {formatTime(c.requestedAt)}. <b>Not confirmed yet:</b> {c.remaining.length} task{c.remaining.length === 1 ? '' : 's'} not stopped according to Hermes. Checking…
          {' '}<button className="link" onClick={request} disabled={busy}>Request again</button></p>
      )}
      {c.state === 'confirmed' && <p className="note good" role="status">Cancellation confirmed {formatTime(c.confirmedAt)}: {c.archivedTaskIds.length} task{c.archivedTaskIds.length === 1 ? '' : 's'} stopped, {c.alreadyFinishedTaskIds.length} already finished.</p>}
      {c.state === 'none' && !canCancel(p.status) && <p className="muted">Nothing to cancel.</p>}
      {error && <ErrorNote error={error} />}
    </section>
  );
}

function ActivityTab(p: { departmentId: string; questId: string; refreshSignal: number }) {
  const l = useLoad(() => api.activity(p.departmentId, p.questId), [p.departmentId, p.questId, p.refreshSignal]);
  if (l.loading && !l.data) return <p className="note" aria-busy="true">Loading activity…</p>;
  if (l.error && !l.data) return <ErrorNote error={l.error} onRetry={l.reload} />;
  const events: ActivityEvent[] = l.data ?? [];
  if (!events.length) return <p className="note">No activity yet.</p>;
  return (
    <ol className="timeline" role="tabpanel" aria-live="polite">
      {[...events].reverse().map((e) => (
        <li key={e.id}>
          <time dateTime={e.at}>{formatTime(e.at)}</time>
          <span className="what"><b>{e.label}</b> <span className="muted">— {e.taskTitle}</span>{e.detail && <span className="detail">{e.detail}</span>}</span>
        </li>
      ))}
    </ol>
  );
}

function ResultsTab(p: { departmentId: string; questId: string; refreshSignal: number }) {
  const l = useLoad(() => api.results(p.departmentId, p.questId), [p.departmentId, p.questId, p.refreshSignal]);
  if (l.loading && !l.data) return <p className="note" aria-busy="true">Loading results…</p>;
  if (l.error && !l.data) return <ErrorNote error={l.error} onRetry={l.reload} />;
  const r = l.data;
  if (!r) return null;
  const withOutput = r.tasks.filter((t) => t.summary || t.error || t.attachments.length);
  return (
    <div role="tabpanel">
      <h3>Chief summary</h3>
      {r.chiefSummary ? <pre className="text">{r.chiefSummary}</pre> : <p className="note">The chief has not completed its task yet.</p>}
      <h3>Task results</h3>
      {!withOutput.length && <p className="note">No task has produced output yet.</p>}
      <ul className="results">
        {withOutput.filter((t) => t.role !== 'chief').map((t) => (
          <li key={t.taskId}>
            <div className="row"><b>{t.title}</b><TaskStatus status={t.status} failed={!!t.error && t.status === 'blocked'} /></div>
            {t.summary && <pre className="text">{t.summary}</pre>}
            {t.error && <p className="err">{t.error}</p>}
            {t.attachments.length > 0 && (
              <ul className="files">
                {t.attachments.map((a) => (
                  <li key={a.id}><a href={a.downloadUrl} download={a.filename}>{a.filename}</a> <span className="muted">{formatBytes(a.size)}</span></li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
