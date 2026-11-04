/* View model for the city. Everything here is derived from the Vibe City backend (see data/derive.ts):
   a department is a floor, every agent on it is a real Hermes profile (the lead at the big desk, teammates at desks
   W-01…), and what each one is doing comes from the Kanban tasks assigned to it. Nothing is invented: no percentage
   without counts. */
import type { DepartmentView, ProvisioningState } from '@vibe-city/shared';

export type AgentStatus = 'running' | 'idle' | 'completed' | 'failed' | 'disconnected' | 'awaiting';
export type DeptState = 'active' | 'idle' | 'attention' | 'offline' | 'unconfigured';

/** A teammate's desk. `id` is the agent key (W-01…); `taskId`/`task` are the Hermes task it is on (null/'' when free). */
export interface Worker { id: string; profile: string | null; taskId: string | null; task: string; status: AgentStatus; since: string; shirt: string }
/** The lead agent: new quests are assigned to it. Same kind of agent as a teammate, at the big desk. */
export interface Chief { name: string; profile: string; model: string | null; status: AgentStatus; activity: string; since: string }

export interface Dept {
  id: string; name: string; purpose: string; state: DeptState;
  provisioning: ProvisioningState;
  /** The lead (null until the floor is provisioned) and its teammates (one desk each, up to MAX_DESKS drawn). */
  chief: Chief | null; workers: Worker[];
  /** Agents on the floor, lead included (may exceed the desks drawn). */
  teamSize: number;
  theme: { floor: string; accent: string };
  /** Why the floor needs a person (provisioning error, failed task, ...). */
  attention?: string;
  /** The backend snapshot this floor was derived from (settings and inspectors read it directly). */
  view: DepartmentView;
}

export interface Connection {
  /** The Vibe City backend answers. */
  backend: boolean;
  /** Hermes dashboard reachable with an accepted token. */
  hermes: boolean;
  /** Hermes gateway running: workers can actually run. */
  gateway: boolean;
}
