/* View model for the city. Everything here is derived from the Vibe City backend (see data/derive.ts):
   a department is a floor, the chief and workers are derived from real Kanban tasks, quests are Hermes tasks.
   Nothing is invented: no worker exists without a task, no percentage without counts. */
import type { DepartmentView, ProvisioningState, WorkspaceView } from '@vibe-city/shared';

export type AgentStatus = 'running' | 'idle' | 'completed' | 'failed' | 'disconnected' | 'awaiting';
export type DeptState = 'active' | 'idle' | 'attention' | 'offline' | 'unconfigured';

/** A desk in the office. `id` is a stable seat label (W-01…) for the lifetime of the task; `taskId` is the Hermes task. */
export interface Worker { id: string; taskId: string; task: string; status: AgentStatus; since: string; shirt: string }
export interface Chief { name: string; profile: string; model: string | null; status: AgentStatus; activity: string; since: string }

export interface Dept {
  id: string; name: string; purpose: string; state: DeptState;
  provisioning: ProvisioningState;
  chief: Chief | null; workers: Worker[];
  /** The requested worker limit. Hermes only enforces a host-wide cap, so this is never presented as a guarantee. */
  maxWorkers: number;
  theme: { floor: string; accent: string };
  workspace: WorkspaceView;
  chiefProfileRef: string | null;
  workerProfileRef: string | null;
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
