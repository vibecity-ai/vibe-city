/* Reference files the CEO hands a job: a tray on the job printer's paper (picked or dropped before printing) and a
   section in the job's overview (what was attached, plus adding more while the job runs). Hermes keeps each file on
   the quest's root task, where the lead's context lists it; the 25 MB cap is Hermes' own. */
import { useRef, useState } from 'react';
import { QUEST_FILES_MAX, type QuestStatus } from '@vibe-city/shared';
import { useStore } from '../store';
import { addQuestFiles } from '../data/live';
import { pickFiles } from '../data/views.ts';
import { formatBytes, formatTime } from './format.ts';
import { Icon } from './kit';

function useDrop(onFiles: (f: File[]) => void, disabled?: boolean) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (disabled || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => { setOver(false); if (disabled) return; e.preventDefault(); onFiles([...e.dataTransfer.files]); },
    },
  };
}

/** The printer's paper-clip tray. */
export function AttachTray({ files, onChange, disabled }: { files: File[]; onChange: (f: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const add = (picked: File[]) => { const r = pickFiles(files, picked); setErr(r.error); onChange(r.files); };
  const drop = useDrop(add, disabled);
  return (
    <div className="field">
      <span className="lbl" id="att-l">Reference files (optional)</span>
      <div className={`attach${drop.over ? ' over' : ''}`} {...drop.props}>
        <button type="button" className="attach-btn" aria-describedby="att-h" disabled={disabled || files.length >= QUEST_FILES_MAX} onClick={() => input.current?.click()}>
          <Icon n="clip" size={15} />{files.length ? 'Attach more' : 'Attach files'}
        </button>
        <span className="attach-or" aria-hidden="true">or drop them here</span>
        <input ref={input} type="file" multiple hidden aria-labelledby="att-l" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} />
      </div>
      {files.length > 0 && (
        <ul className="clips" aria-label="Files to attach">
          {files.map((f) => (
            <li key={f.name} className="clip"><Icon n="clip" size={13} /><span className="clip-n">{f.name}</span><small className="mono">{formatBytes(f.size)}</small>
              <button type="button" className="clip-x" aria-label={`Remove ${f.name}`} disabled={disabled} onClick={() => { setErr(null); onChange(files.filter((x) => x !== f)); }}><Icon n="x" size={12} /></button></li>
          ))}
        </ul>
      )}
      <small id="att-h" className="muted">The lead reads them before planning and passes them to teammates. Up to {QUEST_FILES_MAX} files, 25 MB each.</small>
      {err && <small className="field-err" role="alert">{err}</small>}
    </div>
  );
}

const OPEN = new Set<QuestStatus>(['queued', 'planning', 'running', 'awaiting_input', 'in_review', 'failed']);

/** Overview section: the CEO's files on this job, and a way to add one while the job is still open. */
export function ReferenceFiles({ deptId, questId, status }: { deptId: string; questId: string; status: QuestStatus }) {
  const results = useStore((s) => s.extra[questId]?.results);
  const busy = useStore((s) => !!s.busy[`files:${questId}`]);
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const mine = results?.tasks.find((t) => t.taskId === questId)?.attachments.filter((a) => a.fromCeo) ?? [];
  const canAdd = OPEN.has(status);
  const add = (picked: File[]) => {
    const r = pickFiles([], picked);
    setErr(r.error);
    if (r.files.length) void addQuestFiles(deptId, questId, r.files);
  };
  const drop = useDrop(add, !canAdd || busy);
  if (!mine.length && !canAdd) return null;
  return (
    <div className={`ref-files${drop.over ? ' over' : ''}`} {...drop.props}>
      <h3 className="sec-t">Reference files{mine.length > 0 && <span className="count">{mine.length}</span>}</h3>
      {mine.map((a) => (
        <div key={a.id} className="file"><span className="file-ic"><Icon n="clip" /></span>
          <span className="grow"><b>{a.filename}</b><small className="mono muted">{formatBytes(a.size)} · {formatTime(a.createdAt)}</small></span>
          <a className="btn tertiary" href={a.downloadUrl} download={a.filename} aria-label={`Download ${a.filename}`}><Icon n="download" size={14} />Download</a></div>
      ))}
      {canAdd && (
        <div className="row">
          <button type="button" className="btn small" disabled={busy} aria-busy={busy || undefined} onClick={() => input.current?.click()}><Icon n="clip" size={14} />{busy ? 'Attaching…' : mine.length ? 'Add another file' : 'Add a file'}</button>
          <small className="muted">{mine.length ? 'A new file reaches the lead as a comment on the job.' : 'The lead gets a comment and reads it before the remaining work. 25 MB each.'}</small>
          <input ref={input} type="file" multiple hidden aria-label="Add reference files" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
      )}
      {err && <small className="field-err" role="alert">{err}</small>}
    </div>
  );
}
