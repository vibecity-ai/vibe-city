/* What a skill looks like in the game (pure, tested). A Hermes skill is only a name; here it gets a school (colour and
   pixel glyph), a rarity and a one-line description, so it reads as a card you collect and equip. All of this is
   presentation: whether a skill is on comes only from Hermes' read-back (see skillState). */
import { TEMPLATES } from '@vibe-city/shared';

export type School = 'core' | 'wallet' | 'markets' | 'code' | 'research' | 'docs' | 'security' | 'creative' | 'comms' | 'ops';
export type Rarity = 'core' | 'standard' | 'signature';

export interface SchoolInfo { label: string; color: string; /** Darker tone for frames and glyph shading. */ deep: string }

export const SCHOOLS: Record<School, SchoolInfo> = {
  core: { label: 'Core', color: '#C9B8FF', deep: '#5B4A9E' },
  wallet: { label: 'Wallet', color: '#FFC75A', deep: '#8A5A12' },
  markets: { label: 'Markets', color: '#7CF5B4', deep: '#1E7A50' },
  code: { label: 'Code', color: '#3EE6FF', deep: '#126A80' },
  research: { label: 'Research', color: '#FF8AD8', deep: '#8A2A6E' },
  docs: { label: 'Documents', color: '#FFA86B', deep: '#8A4A1E' },
  security: { label: 'Security', color: '#FF5C7A', deep: '#8A1E34' },
  creative: { label: 'Creative', color: '#B98CFF', deep: '#5A2E9E' },
  comms: { label: 'Comms', color: '#6BD1FF', deep: '#1E5A8A' },
  ops: { label: 'Utility', color: '#A9A3C9', deep: '#4A4570' },
};

/** First match wins, so the specific schools come before the broad ones. */
const RULES: [School, RegExp][] = [
  ['wallet', /custody|wallet|near-|near_|treasury|\bdao\b|sputnik|token|outlayer|payment|stripe|invoice/],
  ['markets', /hyperliquid|polymarket|trad(e|ing)|market|perp|price|odds|defi|swap|exchange|finance|stock|crypto/],
  ['security', /secur|recon|pentest|vuln|audit|\bcve\b|red-team|blue-team|threat|forensic|malware|osint/],
  ['code', /github|gitlab|\bgit\b|code|repo|pull-request|\bpr\b|test|\bci\b|docker|kube|terraform|python|typescript|node|rust|debug|refactor|deploy|sql|api/],
  ['research', /arxiv|research|paper|scholar|search|wiki|news|browse|scrape|crawl|summar|youtube/],
  ['docs', /pdf|docx?\b|spreadsheet|excel|xlsx|csv|pptx|slides|markdown|notion|obsidian|writ|ocr|note/],
  ['creative', /image|video|design|art\b|draw|music|audio|tts|voice|meme|figma|animation|svg/],
  ['comms', /email|mail|slack|discord|telegram|whatsapp|social|twitter|\bx-|tweet|outreach|crm|calendar|linkedin/],
];

export const schoolOf = (name: string, essential = false): School => {
  if (essential || name === 'hermes-agent') return 'core';
  const n = name.toLowerCase();
  return RULES.find(([, re]) => re.test(n))?.[0] ?? 'ops';
};

/** Skills a template's floor is built around (its seats' own skills and its loadout). */
const SIGNATURE: ReadonlySet<string> = new Set(TEMPLATES.flatMap((t) => [...t.inventory.allowedSkillIds, ...t.seats.flatMap((s) => s.skills)]));

export const rarityOf = (name: string, essential = false): Rarity => (essential || name === 'hermes-agent' ? 'core' : SIGNATURE.has(name) ? 'signature' : 'standard');
export const RARITY_LABEL: Record<Rarity, string> = { core: 'Core', standard: 'Standard', signature: 'Signature' };

/** What a skill does, for the ones the game knows. Others only say that Hermes has them: we do not guess. */
const KNOWN: Record<string, string> = {
  'hermes-agent': 'Hermes\' own skill about itself. Always on; Hermes does not let it be switched off.',
  'agent-custody': 'Holds and spends from the company wallet through OutLayer, only inside the wallet policy you set.',
  'hyperliquid-connector': 'Reads Hyperliquid markets and places perpetual futures trades with the company wallet.',
  'polymarket-connector': 'Reads Polymarket and takes positions on prediction markets with the company wallet.',
  'near-cli-rs': 'Runs the NEAR command line: accounts, contracts, tokens and DAO proposals.',
  github: 'Works with GitHub: issues, branches, pull requests and reviews.',
  arxiv: 'Searches arXiv and reads research papers.',
  pdf: 'Reads, fills and writes PDF files.',
};

/** OutLayer skills that move the company's money (brief 03). */
const WALLET: ReadonlySet<string> = new Set(['agent-custody', 'hyperliquid-connector', 'polymarket-connector']);

export interface SkillMeta { name: string; label: string; school: School; rarity: Rarity; blurb: string; /** Spends from the company wallet. */ wallet: boolean }

/** `agent-custody` -> `Agent Custody`; keeps known acronyms in capitals. */
export const skillLabel = (name: string) => name.split(/[-_]+/).filter(Boolean)
  .map((w) => (/^(pdf|cli|api|ai|ci|pr|sql|csv|x|rs|near|mcp|tts|ocr|dao|ui)$/i.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(' ');

export function skillMeta(name: string, essential = false): SkillMeta {
  const school = schoolOf(name, essential);
  return { name, label: skillLabel(name), school, rarity: rarityOf(name, essential), blurb: KNOWN[name] ?? 'A skill installed in Hermes. Its own instructions say what it does.', wallet: WALLET.has(name) };
}

/* ---------------- state on a floor ---------------- */

/** Where a skill stands for a floor: from its saved loadout (what you asked for) and Hermes' read-back (what is real). */
export type SkillState = 'active' | 'pending-on' | 'pending-off' | 'off' | 'missing';
export const STATE_LABEL: Record<SkillState, string> = { active: 'Equipped', 'pending-on': 'Equips at next sync', 'pending-off': 'Unequips at next sync', off: 'In the library', missing: 'Not in Hermes' };

/**
 * @param allowed the floor's saved allowance; empty means Hermes' defaults (everything the default profile has on)
 * @param inHermes the floor lead's profile as Hermes reports it (null before the first read-back)
 */
export function skillState(name: string, allowed: readonly string[], defaultsOn: readonly string[], inHermes: { name: string; enabled: boolean; essential: boolean }[] | null): SkillState {
  const h = inHermes?.find((k) => k.name === name);
  const want = h?.essential || (allowed.length ? allowed.includes(name) : defaultsOn.includes(name));
  if (inHermes && !h) return want ? 'missing' : 'off';
  if (!inHermes) return want ? 'pending-on' : 'off';
  if (h!.essential) return 'active';
  return want === h!.enabled ? (want ? 'active' : 'off') : want ? 'pending-on' : 'pending-off';
}

/** The allowance after equipping or unequipping one skill. An empty allowance (Hermes' defaults) is first made
    explicit, so equipping one skill never drops the defaults the floor already had. */
export function toggleAllowance(allowed: readonly string[], defaultsOn: readonly string[], name: string, on: boolean): string[] {
  const base = allowed.length ? [...allowed] : [...defaultsOn];
  const next = on ? [...new Set([...base, name])] : base.filter((x) => x !== name);
  return next;
}

/** Library order: wallet and markets first (what earns), then the rest by school, then name. */
const ORDER: School[] = ['core', 'wallet', 'markets', 'code', 'security', 'research', 'docs', 'comms', 'creative', 'ops'];
export const bySchool = (a: SkillMeta, b: SkillMeta) => ORDER.indexOf(a.school) - ORDER.indexOf(b.school) || a.name.localeCompare(b.name);

/** Every skill a template asks for that Hermes does not have: shown in the library as "not in Hermes yet". */
export const templateSkills = (): string[] => [...SIGNATURE].sort();
