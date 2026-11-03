import type { HealthView } from '@vibe-city/shared';

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
  defaultWorkdir: string | null;
}

export interface SkillInfo {
  name: string;
  enabled: boolean;
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
  createBoard(slug: string, name: string, opts: { defaultWorkdir?: string }): Promise<void>;

  /** Map of toolset name -> enabled, for every toolset Hermes lists (built-in and plugin). */
  getToolsets(profile: string): Promise<Record<string, boolean>>;
  setToolsets(profile: string, change: { enable: string[]; disable: string[] }): Promise<void>;

  listSkills(profile: string): Promise<SkillInfo[]>;
  setDisabledSkills(profile: string, names: string[]): Promise<void>;

  getModel(profile: string): Promise<string | null>;
  setModel(profile: string, model: string): Promise<void>;

  readInstructions(profile: string): Promise<string | null>;
  writeInstructions(profile: string, text: string): Promise<void>;

  /** Host-wide `kanban.max_in_progress_per_profile`, or null when unset/unlimited. */
  getConcurrencyCap(): Promise<number | null>;
}
