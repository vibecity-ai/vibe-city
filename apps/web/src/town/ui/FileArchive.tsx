/* The file archive (the filing cabinets on every floor): every file on the department's jobs, what the agents made and
   the reference files the CEO attached, newest first. Downloads go through each job's own attachment route. */
import { useEffect, useMemo, useState } from 'react';
import type { DepartmentFiles } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { agentLabel } from '../data/views.ts';
import { formatBytes, formatTime } from './format.ts';
import { DeskSheet } from './Desk';
import { Icon } from './kit';

type Who = 'all' | 'agents' | 'ceo';

export function FileArchive({ deptId }: { deptId: string }) {
  const d = useStore((s) => s.depts.find((x) => x.id === deptId));
  const personas = useStore((s) => s.personas);
  const [data, setData] = useState<DepartmentFiles | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [who, setWho] = useState<Who>('all');
  const close = () => useStore.getState().ui$({ floorSheet: null });
  const load = () => { setErr(null); api.departmentFiles(deptId).then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not read the archive.')); };
  useEffect(load, [deptId]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.files ?? []).filter((f) => (who === 'all' || (who === 'ceo') === f.fromCeo)
      && (!needle || `${f.filename} ${f.questTitle} ${f.taskTitle}`.toLowerCase().includes(needle)));
  }, [data, q, who]);
  const openJob = (questId: string) => { close(); useStore.getState().openPanel('quest', { questId, questFrom: 'dept' }); };
  if (!d) return null;
  return (
    <DeskSheet title="File archive" onClose={close} className="exec-modal fs archive">
      <header className="hire-head">
        <div><span className="dlg-tag">{d.name}</span><h2>File archive</h2></div>
      </header>
      <p className="fs-lead">Every file on this floor’s jobs: what the agents produced and the reference files you attached.</p>
      <div className="ar-tools">
        <input className="input" type="search" placeholder="Search files and jobs" aria-label="Search the archive" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg-row" role="group" aria-label="Who made it">
          {(['all', 'agents', 'ceo'] as const).map((w) => <button key={w} type="button" aria-pressed={who === w} className={who === w ? 'on' : ''} onClick={() => setWho(w)}>{w === 'all' ? 'All' : w === 'agents' ? 'From agents' : 'From you'}</button>)}
        </div>
      </div>
      {err && <p className="err-t" role="alert">{err} <button className="link" onClick={load}>Retry</button></p>}
      {!data && !err && <p className="muted small" role="status">Opening the cabinets…</p>}
      {data && shown.length === 0 && <div className="empty"><Icon n="folder" size={36} sw={1.5} /><b>{data.files.length ? 'No file matches' : 'The archive is empty'}</b><p>{data.files.length ? 'Try another search.' : 'Files appear here when an agent attaches output to a task, or when you attach a reference file to a job.'}</p></div>}
      <ul className="ar-list">
        {shown.map((f) => (
          <li key={`${f.questId}:${f.id}`} className="file">
            <span className="file-ic"><Icon n={f.fromCeo ? 'clip' : 'file'} /></span>
            <span className="grow"><b>{f.filename}</b>
              <small className="mono muted">{formatBytes(f.size)} · {formatTime(f.createdAt)} · {f.fromCeo ? 'from you' : f.agentKey ? agentLabel(f.agentKey, personas[`${deptId}:${f.agentKey}`]) : 'outside the floor'}</small>
              <small className="ar-job"><button className="link" onClick={() => openJob(f.questId)}>{f.questTitle}</button>{f.taskTitle !== f.questTitle && <span className="muted"> · {f.taskTitle}</span>}</small>
            </span>
            <a className="btn tertiary" href={f.downloadUrl} download={f.filename} aria-label={`Download ${f.filename}`}><Icon n="download" size={14} />Download</a>
          </li>
        ))}
      </ul>
      {data?.truncated && <p className="fine">Only the latest 50 jobs are read, so older files are not listed.</p>}
    </DeskSheet>
  );
}
