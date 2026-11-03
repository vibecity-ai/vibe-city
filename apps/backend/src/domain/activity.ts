import type { RawEvent } from '../hermes/kanbanApi.ts';
import { scrub } from './scrub.ts';

/** Events that describe Hermes plumbing rather than something a user cares about. */
const NOISE = new Set(['heartbeat', 'owner_admitted', 'worker_bound', 'tip_scratch_workspace', 'worker_result', 'spawned']);

const LABELS: Record<string, string> = {
  created: 'Task created',
  claimed: 'Worker started',
  completed: 'Task completed',
  blocked: 'Task blocked',
  unblocked: 'Task unblocked',
  archived: 'Task archived',
  crashed: 'Run crashed',
  gave_up: 'Task failed (retries exhausted)',
  reclaimed: 'Run reclaimed',
  commented: 'Comment added',
  attached: 'File attached',
  worker_lost: 'Worker lost',
  promoted: 'Task ready',
  assigned: 'Task assigned',
  edited: 'Task edited',
  status: 'Status changed',
  review_requested: 'Review requested',
  archive_worker_termination: 'Worker terminated',
  skipped_nonspawnable: 'Assignee profile not runnable',
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Normalized, path-free description of a Hermes event. Raw payloads are never forwarded. */
export function describeEvent(e: RawEvent): { label: string; detail: string | null } | null {
  if (NOISE.has(e.kind)) return null;
  const p = e.payload ?? {};
  let detail: string | null = null;
  switch (e.kind) {
    case 'completed': detail = str(p.summary); break;
    case 'blocked': detail = str(p.reason); break;
    case 'crashed':
    case 'gave_up': detail = str(p.error) ?? str(p.attempt_note); break;
    case 'attached': detail = str(p.filename); break;
    case 'assigned':
    case 'created': detail = str(p.assignee) ? `assignee: ${str(p.assignee)}` : null; break;
    case 'archive_worker_termination': detail = str(p.outcome) ?? str(p.result); break;
    case 'skipped_nonspawnable': detail = str(p.assignee) ? `assignee: ${str(p.assignee)}` : null; break;
    default: detail = null;
  }
  return { label: LABELS[e.kind] ?? e.kind, detail: scrub(detail, 500) };
}
