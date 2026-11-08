/* What a department floor holds (pure, tested): the objects every floor shares, the station each template brings,
   and which tools each kind of floor really needs. The city draws and hit-tests the objects (world/floorRoom.ts); the
   sheets that open show this data. */
import type { Inventory, Toolset } from '@vibe-city/shared';

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
  memory: { label: 'Memory', does: 'Remember facts across quests.', risky: false },
  session_search: { label: 'Past chats', does: 'Search its own earlier conversations.', risky: false },
  skills: { label: 'Skills', does: 'Load the skills in its loadout.', risky: false },
  todo: { label: 'To-do list', does: 'Keep a checklist while it works.', risky: false },
  kanban: { label: 'Kanban', does: 'Take and hand out quests on the floor\'s board.', risky: false },
  context_engine: { label: 'Context', does: 'Manage long working context.', risky: false },
  connections: { label: 'Connections', does: 'Use the accounts connected to Hermes.', risky: true },
  clarify: { label: 'Ask back', does: 'Stop and ask a question when stuck.', risky: false },
  computer_use: { label: 'Computer use', does: 'Control a desktop with mouse and keyboard.', risky: true },
};

/** Always on for every floor (the floor cannot work without them), so not listed as "needed". */
const BASE: readonly string[] = ['memory', 'todo', 'kanban', 'skills', 'session_search', 'context_engine', 'clarify'];

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
  software: { name: 'CI wall', blurb: 'Where the team ships: branches, pull requests and test runs.', toolsets: ['terminal', 'file', 'code_execution', 'web'], skills: [], marker: '[pr url=…]', wallet: false },
  'trading-desk': { name: 'Market wall', blurb: 'Prices, funding and open positions. Every trade stays inside the wallet policy.', toolsets: ['web', 'terminal'], skills: ['agent-custody', 'hyperliquid-connector'], marker: '[pnl usd=…]', wallet: true },
  'token-treasury': { name: 'Vault', blurb: 'The treasury, the DAO and the token. Nothing moves without your OK.', toolsets: ['web', 'terminal'], skills: ['agent-custody', 'near-cli-rs'], marker: '[token symbol=… supply=…]', wallet: true },
  'prediction-desk': { name: 'Odds board', blurb: 'Markets the desk follows, its estimates and open positions.', toolsets: ['web'], skills: ['agent-custody', 'polymarket-connector'], marker: '[pnl usd=…]', wallet: true },
  'red-team': { name: 'Recon table', blurb: 'Our own code and infrastructure, mapped for weak spots. Findings go to the Blue Team only.', toolsets: ['terminal', 'web', 'browser'], skills: [], marker: null, wallet: false },
  'blue-team': { name: 'Watch screens', blurb: 'Findings to fix, alerts and the patches that closed them.', toolsets: ['terminal', 'file', 'web'], skills: [], marker: null, wallet: false },
};

export const stationFor = (templateId: string | undefined | null): Station | null => (templateId ? STATIONS[templateId] ?? null : null);

/* ---------------- the tools report behind the server rack ---------------- */

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
  const on = new Set(inv.allowedToolsets);
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

export type FloorObjectId = 'board' | 'lead' | 'meeting' | 'rack' | 'clock' | 'elevator' | 'station';

/** What a click opens, so the screen copy and the test agree. */
export const FLOOR_OBJECT_HELP: Record<FloorObjectId, string> = {
  board: 'This floor\'s quests on the Ops board',
  lead: 'The lead\'s profile and chat',
  meeting: 'The loadout: skills, tools, model',
  rack: 'Tools & access: what this floor needs',
  clock: 'This floor\'s schedules',
  elevator: 'Hire someone for this floor',
  station: 'The station: what this team works with',
};
