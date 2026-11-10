import type { HermesRun } from '../hermes/kanbanClient.ts';

export type RunState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

/** Maps a Hermes run row to Vibe City's minimal run state. Unrecognized values are `unknown`, never guessed. */
export function runState(r: Pick<HermesRun, 'status' | 'outcome' | 'ended_at'>): RunState {
  const v = `${r.outcome ?? ''} ${r.status}`.toLowerCase();
  if (/reclaim|cancel|terminat/.test(v)) return 'cancelled';
  if (/crash|fail|timed_out|spawn_failed|gave_up|error/.test(v)) return 'failed';
  if (r.ended_at === null) return /running|claimed|active/.test(v) ? 'running' : 'queued';
  if (/complet|done|success/.test(v)) return 'completed';
  return 'unknown';
}
