/* What a skill looks like in the game (pure, tested). A Hermes skill is only a name; here it gets a school (colour and
   pixel glyph), a rarity and a one-line description, so it reads as a card you collect and equip. All of this is
   presentation: whether a skill is on comes only from Hermes' read-back (see skillState). */
import { TEMPLATES } from '@vibe-city/shared';
import { STATIONS } from './floor.ts';

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
  ['security', /secur|recon|pentest|vuln|audit|\bcve\b|red-team|blue-team|threat|forensic|malware|osint|differential-review/],
  ['wallet', /custody|wallet|treasury|\bdao\b|sputnik|outlayer|payment|stripe|invoice|mercury|near-intents|near-cli/],
  ['markets', /hyperliquid|polymarket|coingecko|defillama|backtest|risk-metric|regime|trad(e|ing)|market|perp|price|odds|defi|swap|exchange|finance|stock|crypto/],
  ['code', /github|gitlab|\bgit\b|\bgh-|code|repo|\bpr\b|test|\bci\b|docker|kube|terraform|python|typescript|node|rust|debug|refactor|deploy|sql|api|compiler|merge|deslop|ponytail|review|ship|react|solana|near-|dapp|contract|spike|dogfood|verify|simplif/],
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

/** The few skills a floor is built around: its station's (data/floor.ts). Templates now name dozens of skills, so
    "every skill a template names" would make nearly everything rare. */
const SIGNATURE: ReadonlySet<string> = new Set(Object.values(STATIONS).flatMap((s) => s.skills));
/** Every skill a template names (its loadout and its seats' own). */
const TEMPLATE_SKILLS: ReadonlySet<string> = new Set(TEMPLATES.flatMap((t) => [...t.inventory.allowedSkillIds, ...t.seats.flatMap((s) => s.skills)]));

export const rarityOf = (name: string, essential = false): Rarity => (essential || name === 'hermes-agent' ? 'core' : SIGNATURE.has(name) ? 'signature' : 'standard');
export const RARITY_LABEL: Record<Rarity, string> = { core: 'Core', standard: 'Standard', signature: 'Signature' };

/** What a skill does, in one line, for the skills this repo installs (docker/skills and HERMES_OPTIONAL; taken from
    each skill's own SKILL.md) and Hermes' own. Others only say that Hermes has them: we do not guess. A test fails
    when a vendored skill has no line here. */
const KNOWN: Record<string, string> = {
  'hermes-agent': 'Hermes\' own skill about itself. Always on; Hermes does not let it be switched off.',
  // money and markets (OutLayer, NEAR, data)
  'agent-custody': 'The company\'s OutLayer custody wallet: balances, transfers and signing, keys held in a TEE, inside your policy.',
  'hyperliquid-connector': 'Trades Hyperliquid perpetuals from the custody wallet: orders, leverage, stop-losses.',
  'polymarket-connector': 'Trades Polymarket prediction markets from the custody wallet: finds markets, buys and sells outcomes.',
  'mercury-connector': 'Runs the owner\'s Mercury business bank account: payments, invoices, balances.',
  'near-intents': 'Swaps tokens across chains through NEAR Intents.',
  'near-cli-rs': 'Writes NEAR CLI commands: accounts, token transfers, staking, contract deploys.',
  outlayer: 'The map of OutLayer\'s skills: which one to load for a task.',
  'outlayer-connectors': 'How to call any OutLayer connector: auth, secrets, fees and the free trial.',
  'building-outlayer-apps': 'Builds verifiable off-chain apps on NEAR OutLayer.',
  coingecko: 'Crypto prices, market caps, volumes and history from CoinGecko.',
  defillama: 'DeFi data from DefiLlama: TVL, yields, stablecoins, DEX volume and fees.',
  'crypto-regime-analyzer': 'Reads the crypto market\'s regime from free data (prices and funding rates).',
  'backtest-expert': 'Backtests trading strategies before real money goes in.',
  'risk-metrics-calculation': 'Portfolio risk: VaR, CVaR, Sharpe, Sortino and drawdowns.',
  hyperliquid: 'Hermes\' read-only Hyperliquid skill: markets, prices and funding.',
  polymarket: 'Hermes\' read-only Polymarket skill: markets and odds.',
  'marketplace-worker': 'Works the Agents Marketplace: finds jobs, bids, delivers and gets paid.',
  'near-ai-cloud': 'Private, verifiable inference on NEAR AI Cloud.',
  // building
  'near-api-js': 'Talks to NEAR from JavaScript and TypeScript (near-api-js v7).',
  'near-kit': 'Talks to NEAR from TypeScript with near-kit.',
  'near-dapp': 'Builds NEAR dApps end to end.',
  'near-smart-contracts': 'Writes NEAR smart contracts in Rust.',
  'solana-dev': 'Builds on Solana: Anchor programs, tokens, wallet connections and tests.',
  solana: 'Hermes\' Solana skill: accounts, tokens and transactions.',
  'new-branch-and-pr': 'Starts a branch, does the work and opens a pull request.',
  'review-and-ship': 'Reviews the branch, runs or writes tests, commits and opens or updates the PR.',
  'gh-address-comments': 'Works through review comments on the open pull request.',
  'gh-fix-ci': 'Finds why GitHub Actions checks fail and fixes them.',
  'loop-on-ci': 'Watches a pull request\'s checks and fixes failures until they are green.',
  'make-pr-easy-to-review': 'Tidies a pull request for reviewers without changing what it does.',
  'fix-merge-conflicts': 'Resolves merge conflicts, then checks the build and tests.',
  'check-compiler-errors': 'Runs the compiler and type checks and reports what fails.',
  deslop: 'Strips AI-generated slop from code and cleans up its style.',
  'simplify-code': 'Makes code simpler without changing what it does.',
  spike: 'A quick throwaway experiment to answer one question before building.',
  ponytail: 'Senior-dev mode: the smallest change that fully solves the task.',
  'ponytail-debt': 'Lists every shortcut left in the code as a debt ledger.',
  'vercel-react-best-practices': 'React and Next.js performance rules from Vercel.',
  'node-inspect-debugger': 'Debugs Node.js with the inspector: breakpoints and stepping.',
  'rest-graphql-debug': 'Debugs REST and GraphQL APIs request by request.',
  'docker-management': 'Builds, runs and inspects Docker containers.',
  // checking
  'property-based-testing': 'Property-based tests that hunt for edge cases (Hypothesis, fast-check, proptest…).',
  'thermo-nuclear-code-quality-review': 'An extremely strict maintainability review: abstractions, giant files, tangled conditions.',
  'ponytail-review': 'Reviews a change: right logic, safe, holds under load, tested, fast enough.',
  'verify-this': 'Checks a claim with fresh evidence and answers verified or not.',
  dogfood: 'Uses the product like a real user and reports what breaks.',
  // security
  'security-threat-model': 'Threat-models the repo: trust boundaries, assets, attackers and fixes.',
  'security-best-practices': 'Reviews code for security best practices in its language and framework.',
  'differential-review': 'A security review of a code change.',
  'ponytail-audit': 'Audits a whole repo: bugs, security holes, untested risk, slow paths.',
  'near-contract-audit': 'Security audit for NEAR smart contracts in Rust.',
  'solana-vulnerability-scanner': 'Scans Solana programs for the common critical vulnerabilities.',
  // Hermes bundled skills the templates name
  'codebase-inspection': 'Hermes\' skill for reading an unfamiliar codebase and mapping how it fits together.',
  'systematic-debugging': 'Hermes\' step-by-step debugging: reproduce, isolate, fix, confirm.',
  'test-driven-development': 'Hermes\' test-first workflow: a failing test, then the code that passes it.',
  'requesting-code-review': 'Hermes\' skill for asking for, and acting on, a code review.',
  // Hermes bundled skills the demo uses
  github: 'Works with GitHub: issues, branches, pull requests and reviews.',
  arxiv: 'Searches arXiv and reads research papers.',
  pdf: 'Reads, fills and writes PDF files.',
};

/** OutLayer skills that move the company's money (brief 03). */
const WALLET: ReadonlySet<string> = new Set(['agent-custody', 'hyperliquid-connector', 'polymarket-connector', 'near-intents', 'mercury-connector']);

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
export const templateSkills = (): string[] => [...TEMPLATE_SKILLS].sort();
