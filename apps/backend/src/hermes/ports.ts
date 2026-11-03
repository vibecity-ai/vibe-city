import type { HealthView, ModelChoice } from '@vibe-city/shared';

/** Hermes could not be reached or answered with a server-side/transient failure. Retry later. */
export class HermesUnavailableError extends Error {}
/** Hermes rejected our credentials (401/403). Needs a configuration change, not a retry. */
export class HermesAuthError extends Error {}
/** Hermes (or its CLI) refused the request: bad input/state. */
export class HermesRejectedError extends Error {}
/** Hermes answered 404: the board/task/attachment does not exist (anymore). */
export class HermesNotFoundError extends HermesRejectedError {}
/** The `hermes` executable could not be run. */
export class HermesCliMissingError extends HermesRejectedError {}

export interface ProfileInfo {
  name: string;
  isDefault: boolean;
  model: string | null;
  description: string | null;
}

export interface BoardInfo {
  slug: string;
  name: string;
  archived: boolean;
}

export interface SkillInfo {
  name: string;
  enabled: boolean;
}

/** A Hermes session row reduced to the fields Vibe City may relay (times are epoch seconds). */
export interface SessionInfo {
  id: string;
  title: string | null;
  source: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  lastActive: number | null;
  active: boolean;
  messageCount: number | null;
  toolCallCount: number | null;
  endReason: string | null;
}

export interface ModelCatalog {
  current: { provider: string | null; model: string | null };
  providers: { slug: string; name: string; current: boolean; models: string[] }[];
}

export type HermesHealth = HealthView['hermes'];

/**
 * Everything Vibe City needs from Hermes. Implemented over supported interfaces only
 * (dashboard REST + `hermes` CLI); never Hermes' databases or source.
 * All profile-scoped methods touch exactly the named profile.
 */
export interface HermesRuntime {
  health(): Promise<HermesHealth>;

  listProfiles(): Promise<ProfileInfo[]>;
  /** Creates a profile cloned from the active one (config, credentials, skills; NOT sessions/memory history). */
  createProfile(name: string, opts: { description: string }): Promise<void>;

  listBoards(): Promise<BoardInfo[]>;
  createBoard(slug: string, name: string): Promise<void>;

  /** Map of toolset name -> enabled, for every toolset Hermes lists (built-in and plugin). */
  getToolsets(profile: string): Promise<Record<string, boolean>>;
  setToolsets(profile: string, change: { enable: string[]; disable: string[] }): Promise<void>;

  listSkills(profile: string): Promise<SkillInfo[]>;
  setDisabledSkills(profile: string, names: string[]): Promise<void>;

  /** The profile's main model and its provider, as written in its config (null when unset). */
  getModel(profile: string): Promise<{ id: string | null; provider: string | null }>;
  /** Sets the profile's main model and provider together; returns the pair Hermes normalized and wrote. */
  setModel(profile: string, choice: ModelChoice): Promise<ModelChoice>;
  /** Hermes' model picker data: authenticated providers and their model ids, plus what `default` uses. */
  listModels(): Promise<ModelCatalog>;

  readInstructions(profile: string): Promise<string | null>;
  writeInstructions(profile: string, text: string): Promise<void>;

  /** Most recent sessions of one profile (dashboard `GET /api/sessions?profile=`), newest activity first. */
  listSessions(profile: string, limit: number): Promise<SessionInfo[]>;

  /** Host-wide `kanban.max_in_progress_per_profile`, or null when unset/unlimited. */
  getConcurrencyCap(): Promise<number | null>;
  /** Adds (or replaces) one MCP server in a profile's config (`mcp_servers.<name>`). Optional: not every runtime has it. */
  setMcpServer?(profile: string, name: string, config: { url: string; headers: Record<string, string>; tools: { include: string[] } }): Promise<void>;
}
