import { KANBAN_EVENT_LABELS as LABELS, KANBAN_EVENT_NOISE } from '@vibe-city/shared';
import type { RawEvent } from '../hermes/kanbanApi.ts';
import { scrub } from './scrub.ts';

const NOISE = new Set(KANBAN_EVENT_NOISE);


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
