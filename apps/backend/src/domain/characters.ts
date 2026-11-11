/* Characters: one persona per agent (the department lead, or a teammate desk W-01…).
   Generated deterministically from the department id + seat, stored on first use so a later edit sticks.
   A persona changes how an agent talks in the dialogue window. It never changes what the agent may do. */
import type { DatabaseSync } from 'node:sqlite';
import { CharacterSchema, type Character } from '@vibe-city/shared';

export const FIRST = [
  'Dina', 'Marco', 'Yuki', 'Ade', 'Lena', 'Rafa', 'Priya', 'Tomasz', 'Noor', 'Iker', 'Sofia', 'Kofi', 'Mila', 'Jonah',
  'Amara', 'Luca', 'Hana', 'Diego', 'Freya', 'Omar', 'Ines', 'Viktor', 'Zara', 'Felix', 'Rosa', 'Theo', 'Aiko', 'Bram',
];
export const LAST = [
  'Varga', 'Okafor', 'Silva', 'Lindqvist', 'Moreau', 'Haddad', 'Kowalski', 'Tanaka', 'Mensah', 'Rossi', 'Novak', 'Reyes',
  'Albescu', 'Kaur', 'Duarte', 'Fischer', 'Osei', 'Petrov', 'Laine', 'Ortega', 'Brandt', 'Nakamura', 'Costa', 'Ward',
];
export const TRAITS = [
  'sharp', 'impatient', 'loyal', 'cheerful', 'dry-witted', 'meticulous', 'dramatic', 'calm', 'ambitious', 'nerdy',
  'blunt', 'optimistic', 'skeptical', 'competitive', 'laid-back', 'curious',
];
export const STYLES = [
  'short sentences, dry jokes', 'warm and chatty', 'formal, a little old-fashioned', 'fast, full of slang from the 80s',
  'precise and numbers-first', 'theatrical, loves a big line', 'quiet, says exactly enough', 'enthusiastic, lots of exclamation',
];
export const QUIRKS = [
  'never puts down their coffee', 'wears sunglasses indoors', 'paces when thinking', 'talks to the office plant',
  'keeps a lucky pixel cactus on the desk', 'hums synthwave while working', 'collects rubber ducks', 'always has a snack',
];
export const COLORS = ['#2EE6F0', '#FF3EA5', '#FFC75A', '#7CF5B4', '#9B5CFF', '#FF7A6B', '#FFB547', '#5AB8FF'];

/** FNV-1a: small, stable, platform independent. */
export function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function pick<T>(list: readonly T[], seed: number, salt: number): T {
  return list[(hash(`${seed}:${salt}`) % list.length)]!;
}

/** `taken`: names already in the company. A hash collision picks again, so two agents never share a name. */
export function generateCharacter(departmentId: string, deptName: string, agentKey: string, taken: ReadonlySet<string> = new Set()): Character {
  const seed = hash(`${departmentId}:${agentKey}`);
  let name = `${pick(FIRST, seed, 1)} ${pick(LAST, seed, 2)}`;
  for (let k = 1; taken.has(name) && k < 100; k++) name = `${pick(FIRST, seed, 100 + k)} ${pick(LAST, seed, 200 + k)}`;
  const role = agentKey === 'chief' ? 'chief' : 'worker';
  const t1 = pick(TRAITS, seed, 3);
  let t2 = pick(TRAITS, seed, 4);
  if (t2 === t1) t2 = TRAITS[(TRAITS.indexOf(t1) + 5) % TRAITS.length]!;
  return CharacterSchema.parse({
    departmentId, agentKey, role,
    name,
    title: role === 'chief' ? `${deptName} lead` : `${deptName} specialist`,
    traits: [t1, t2],
    speechStyle: pick(STYLES, seed, 5),
    quirk: pick(QUIRKS, seed, 6),
    color: role === 'chief' ? '#FFC75A' : pick(COLORS, seed, 7),
    voice: 180 + (hash(`${seed}:8`) % 260),
  });
}

/** The Chief of Staff: one person in the Executive Office who drafts floors and hires (the assistant and AR, merged).
    Seeded like the former assistant, so existing companies keep the same person. */
export function chiefOfStaff(companyId: string): Character {
  const seed = hash(`${companyId}:assistant`);
  return {
    departmentId: 'company', agentKey: 'assistant', role: 'chief',
    name: `${pick(FIRST, seed, 1)} ${pick(LAST, seed, 2)}`, title: 'Chief of Staff',
    traits: ['organised', 'sharp'], speechStyle: 'warm, brisk and practical; calls you "boss"',
    quirk: 'carries a tablet with the tower blueprint and a clipboard of candidates',
    color: '#9B5CFF', voice: 300 + (seed % 80),
  };
}

/** Every persona name in the company: a name is unique across floors, so a toast or a call naming someone is never ambiguous. */
export function takenNames(db: DatabaseSync): Set<string> {
  return new Set((db.prepare("SELECT json_extract(character_json, '$.name') AS name FROM agent_character").all() as { name: string }[]).map((r) => r.name));
}

export class CharacterService {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  /** The stored persona, created on first use. The title follows the department's current name. */
  get(departmentId: string, deptName: string, agentKey: string): Character {
    const row = this.db.prepare('SELECT character_json FROM agent_character WHERE department_id = ? AND agent_key = ?')
      .get(departmentId, agentKey) as { character_json: string } | undefined;
    if (row) {
      const c = CharacterSchema.parse(JSON.parse(row.character_json));
      // a generated title follows the department's name; a template seat's title ("Risk Officer") is kept
      if (!/ (lead|specialist)$/.test(c.title)) return c;
      const fresh = generateCharacter(departmentId, deptName, agentKey);
      return { ...c, title: fresh.title };
    }
    const c = generateCharacter(departmentId, deptName, agentKey, takenNames(this.db));
    this.db.prepare('INSERT OR IGNORE INTO agent_character (department_id, agent_key, character_json, created_at) VALUES (?, ?, ?, ?)')
      .run(departmentId, agentKey, JSON.stringify(c), new Date().toISOString());
    return c;
  }

  /** Replaces the stored persona of a seat (a hire from AR brings its own persona). */
  save(departmentId: string, agentKey: string, c: Character): void {
    const v = CharacterSchema.parse({ ...c, departmentId, agentKey });
    this.db.prepare('INSERT INTO agent_character (department_id, agent_key, character_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (department_id, agent_key) DO UPDATE SET character_json = excluded.character_json')
      .run(departmentId, agentKey, JSON.stringify(v), new Date().toISOString());
  }
}
