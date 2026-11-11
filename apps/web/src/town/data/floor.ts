/* What a department floor holds (pure, tested): the objects every floor shares, the station each template brings,
   and which tools each kind of floor really needs. The city draws and hit-tests the objects (world/floorRoom.ts); the
   sheets that open show this data. */
import { REQUIRED_TOOLSETS, TEMPLATE_BASE_TOOLSETS, type Inventory, type Toolset } from '@vibe-city/shared';

/** On for every agent whatever the floor's allowance says: the backend adds them at every sync. */
export const isRequiredToolset = (t: string) => (REQUIRED_TOOLSETS as readonly string[]).includes(t);

/* ---------------- tools ---------------- */

export interface ToolInfo {
  label: string;
  /** What it lets an agent do, in plain words. */
  does: string;
  /** Reaches outside the company or runs code: on only where the floor's work needs it. */
  risky: boolean;
}

export const TOOL_INFO: Partial<Record<Toolset, ToolInfo>> = {
  web: { label: 'Web search', does: 'Search and read public web pages.', risky: false },
  browser: { label: 'Browser', does: 'Drive a real browser: click, fill forms, log in.', risky: true },
  terminal: { label: 'Terminal', does: 'Run shell commands in the agent\'s sandbox (git, gh, scripts).', risky: true },
  file: { label: 'Files', does: 'Read and write files in the agent\'s workspace.', risky: false },
  code_execution: { label: 'Code runner', does: 'Run Python to compute, test and analyse.', risky: true },
  vision: { label: 'Vision', does: 'Look at images and screenshots.', risky: false },
  image_gen: { label: 'Image maker', does: 'Generate images.', risky: false },
  video: { label: 'Video', does: 'Watch and understand video.', risky: false },
  video_gen: { label: 'Video maker', does: 'Generate video.', risky: false },
  x_search: { label: 'X search', does: 'Search posts on X.', risky: false },
  tts: { label: 'Voice', does: 'Turn text into speech.', risky: false },
  stt: { label: 'Transcription', does: 'Turn speech into text.', risky: false },
  memory: { label: 'Memory', does: 'Remember facts across jobs.', risky: false },
  session_search: { label: 'Past chats', does: 'Search its own earlier conversations.', risky: false },
  skills: { label: 'Skills', does: 'Load the skills in its loadout.', risky: false },
  todo: { label: 'To-do list', does: 'Keep a checklist while it works.', risky: false },
  kanban: { label: 'Kanban', does: 'Take and hand out jobs on the floor\'s board.', risky: false },
  context_engine: { label: 'Context', does: 'Manage long working context.', risky: false },
  connections: { label: 'Connections', does: 'Use the accounts connected to Hermes.', risky: true },
  clarify: { label: 'Ask back', does: 'Stop and ask a question when stuck.', risky: false },
  computer_use: { label: 'Computer use', does: 'Control a desktop with mouse and keyboard.', risky: true },
};

/** Every template floor gets these (TEMPLATE_BASE_TOOLSETS) and every floor gets Kanban, so they are not listed as
    "needed" or "extra". */
export const BASE: readonly string[] = [...TEMPLATE_BASE_TOOLSETS, 'kanban', 'context_engine'];

/* ---------------- stations: one per template ---------------- */

export interface Station {
  /** The object's name in the room. */
  name: string;
  /** One line: what this station is for. */
  blurb: string;
  /** The tools and skills the floor's work really needs (the rest of the loadout is optional). */
  toolsets: Toolset[];
  skills: string[];
  /** The marker its agents write in results, if the game reads one. */
  marker: string | null;
  /** Spends from the shared company wallet. */
  wallet: boolean;
}

export const STATIONS: Record<string, Station> = {
  'trading-desk': { name: 'Market wall', blurb: 'Prices, funding and open positions. Every trade stays inside the wallet policy.', toolsets: ['web', 'terminal'], skills: ['agent-custody', 'hyperliquid-connector'], marker: '[pnl usd=…]', wallet: true },
  'treasury-ops': { name: 'Swap board', blurb: 'Wallet and Intents balances, and every swap in flight. Nothing moves outside the wallet policy.', toolsets: ['web', 'terminal'], skills: ['agent-custody'], marker: '[pnl usd=…]', wallet: true },
  'prediction-desk': { name: 'Odds board', blurb: 'Markets the desk follows, its estimates and open positions.', toolsets: ['web', 'terminal'], skills: ['agent-custody', 'polymarket-connector'], marker: '[pnl usd=…]', wallet: true },
  // not a template: the floor listed on the Agent Market (see stationKeyOf)
  market: { name: 'Marketplace board', blurb: 'Jobs buyers hired this floor for on the NEAR AI Agent Market: in progress, delivered, paid.', toolsets: [], skills: ['marketplace-worker'], marker: null, wallet: false },
};

/** How long the city takes to put up a station that appears while you watch (a floor just listed on the market). */
export const STATION_BUILD_MS = 2400;
export const stationFor = (templateId: string | undefined | null): Station | null => (templateId ? STATIONS[templateId] ?? null : null);
/** Which station a floor has: the marketplace board on the floor listed on the Agent Market (never a template floor: those all
    spend from the company wallet and can't be listed), else its template's own, else none (the lounge stays). */
export const stationKeyOf = (d: { id: string; view: { templateId?: string | null } }, listed: readonly string[]): string | null =>
  listed.includes(d.id) ? 'market' : stationFor(d.view.templateId) ? d.view.templateId! : null;
/** The floors on the Agent Market (each its own agent). */
export const listedFloors = (m: { agents: { departmentId: string }[] } | null | undefined): string[] => m?.agents.map((a) => a.departmentId) ?? [];

/* ---------------- what a floor's work needs (the loadout and the station show it) ---------------- */

export interface ToolLine { id: string; label: string; does: string; risky: boolean; on: boolean }
export interface ToolsReport {
  /** What this floor's work needs (from its template); `on` false = missing, the work will stall. */
  needed: ToolLine[];
  /** On but not needed: fine, unless risky (then worth switching off). */
  extra: ToolLine[];
  /** Skills the work needs and whether the loadout allows them. */
  skills: { id: string; on: boolean }[];
  /** Floors without a template: every enabled tool, no judgement. */
  plain: boolean;
}

const line = (id: string, on: boolean): ToolLine => {
  const i = TOOL_INFO[id as Toolset];
  return { id, label: i?.label ?? id, does: i?.does ?? '', risky: i?.risky ?? false, on };
};

export function toolsReport(templateId: string | undefined | null, inv: Pick<Inventory, 'allowedToolsets' | 'allowedSkillIds'>): ToolsReport {
  const on = new Set([...inv.allowedToolsets, ...REQUIRED_TOOLSETS]);
  const st = stationFor(templateId);
  if (!st) return { needed: [], extra: inv.allowedToolsets.filter((t) => !BASE.includes(t)).map((t) => line(t, true)), skills: [], plain: true };
  const need = new Set<string>(st.toolsets);
  return {
    needed: st.toolsets.map((t) => line(t, on.has(t))),
    extra: inv.allowedToolsets.filter((t) => !need.has(t) && !BASE.includes(t)).map((t) => line(t, true)).sort((a, b) => Number(b.risky) - Number(a.risky)),
    skills: st.skills.map((id) => ({ id, on: inv.allowedSkillIds.length === 0 || inv.allowedSkillIds.includes(id) })),
    plain: false,
  };
}

/* ---------------- the objects every floor shares ---------------- */

export type FloorObjectId = 'board' | 'lead' | 'archive' | 'rack' | 'library' | 'keys' | 'clock' | 'station';

/** What a click opens, so the screen copy and the test agree. */
export const FLOOR_OBJECT_HELP: Record<FloorObjectId, string> = {
  board: 'This floor\'s jobs on the Ops board',
  lead: 'The lead\'s profile and chat',
  archive: 'The file archive: every file on this floor\'s jobs',
  rack: 'Tools: the toolsets every agent here carries',
  library: 'This floor’s skills: what its agents may use, and what they carry',
  keys: 'Env variables: keys the floor\'s tools read',
  clock: 'This floor\'s schedules',
  station: 'The station: what this team works with',
};
