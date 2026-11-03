import {
  HermesAuthError, HermesRejectedError, HermesUnavailableError,
  type BoardInfo, type HermesHealth, type HermesRuntime, type ProfileInfo, type SessionInfo, type SkillInfo,
} from '../hermes/ports.ts';

type Method = keyof HermesRuntime;

interface FakeProfile {
  description: string; model: string; toolsets: Record<string, boolean>; skills: Record<string, boolean>; soul: string;
}

export const FAKE_TOOLSETS = ['web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'skills', 'todo', 'kanban', 'memory', 'delegation', 'cronjob', 'tts'];
export const FAKE_SKILLS = ['hermes-agent', 'pdf', 'arxiv', 'github', 'omarchy'];
const FAKE_ESSENTIAL = ['hermes-agent']; // mirrors Hermes: essential skills cannot be disabled

/** In-memory Hermes for tests: no network, no processes. Supports offline mode and one-shot fault injection. */
export class FakeHermes implements HermesRuntime {
  online = true;
  authOk = true;
  gatewayRunning = true;
  concurrencyCap: number | null = null;
  profiles = new Map<string, FakeProfile>();
  boards = new Map<string, BoardInfo>();
  calls: string[] = [];
  /** Sessions per profile, newest first (already reduced to SessionInfo, as the real adapter does). */
  sessions = new Map<string, SessionInfo[]>();
  private faults: { method: Method; err: Error; times: number }[] = [];

  constructor() {
    this.profiles.set('default', this.freshProfile('default profile'));
  }

  private freshProfile(description: string): FakeProfile {
    return {
      description, model: 'base-model',
      toolsets: Object.fromEntries(FAKE_TOOLSETS.map((t) => [t, true])),
      skills: Object.fromEntries(FAKE_SKILLS.map((s) => [s, true])),
      soul: '# Soul\nBe helpful.\n',
    };
  }

  /** Make the next `times` calls of `method` throw `err`. */
  failNext(method: Method, err: Error, times = 1) {
    this.faults.push({ method, err, times });
  }

  addProfile(name: string, description = '') {
    this.profiles.set(name, this.freshProfile(description));
  }

  private enter(method: Method, args: unknown[] = []) {
    this.calls.push(`${method}(${args.map(String).join(',')})`);
    if (!this.online) throw new HermesUnavailableError('Hermes dashboard unreachable');
    if (!this.authOk && method !== 'health') throw new HermesAuthError('Hermes rejected the session token');
    const f = this.faults.find((x) => x.method === method && x.times > 0);
    if (f) {
      f.times -= 1;
      throw f.err;
    }
  }

  private profile(name: string): FakeProfile {
    const p = this.profiles.get(name);
    if (!p) throw new HermesRejectedError(`profile ${name} not found`);
    return p;
  }

  async health(): Promise<HermesHealth> {
    this.calls.push('health()');
    if (!this.online) return { dashboard: 'down', auth: 'unknown', gateway: 'unknown', version: null, detail: 'dashboard unreachable' };
    return { dashboard: 'up', auth: this.authOk ? 'ok' : 'rejected', gateway: this.gatewayRunning ? 'running' : 'stopped', version: 'fake', detail: null };
  }

  async listProfiles(): Promise<ProfileInfo[]> {
    this.enter('listProfiles');
    return [...this.profiles].map(([name, p]) => ({ name, isDefault: name === 'default', model: p.model, description: p.description }));
  }

  async createProfile(name: string, opts: { description: string }) {
    this.enter('createProfile', [name]);
    if (this.profiles.has(name)) throw new HermesRejectedError(`profile ${name} already exists`);
    this.profiles.set(name, this.freshProfile(opts.description));
  }

  async listBoards(): Promise<BoardInfo[]> {
    this.enter('listBoards');
    return [...this.boards.values()];
  }

  async createBoard(slug: string, name: string, opts: { defaultWorkdir?: string }) {
    this.enter('createBoard', [slug]);
    if (!this.boards.has(slug)) this.boards.set(slug, { slug, name, archived: false, defaultWorkdir: opts.defaultWorkdir ?? null });
  }

  async getToolsets(profile: string) {
    this.enter('getToolsets', [profile]);
    return { ...this.profile(profile).toolsets };
  }

  async setToolsets(profile: string, change: { enable: string[]; disable: string[] }) {
    this.enter('setToolsets', [profile]);
    const p = this.profile(profile);
    for (const n of change.enable) if (n in p.toolsets) p.toolsets[n] = true;
    for (const n of change.disable) if (n in p.toolsets) p.toolsets[n] = false;
  }

  async listSkills(profile: string): Promise<SkillInfo[]> {
    this.enter('listSkills', [profile]);
    return Object.entries(this.profile(profile).skills).map(([name, enabled]) => ({ name, enabled }));
  }

  async setDisabledSkills(profile: string, names: string[]) {
    this.enter('setDisabledSkills', [profile]);
    const p = this.profile(profile);
    for (const s of Object.keys(p.skills)) p.skills[s] = FAKE_ESSENTIAL.includes(s) || !names.includes(s);
  }

  async getModel(profile: string) {
    this.enter('getModel', [profile]);
    return this.profile(profile).model;
  }

  async setModel(profile: string, model: string) {
    this.enter('setModel', [profile]);
    this.profile(profile).model = model;
  }

  async readInstructions(profile: string) {
    this.enter('readInstructions', [profile]);
    return this.profile(profile).soul;
  }

  async writeInstructions(profile: string, text: string) {
    this.enter('writeInstructions', [profile]);
    this.profile(profile).soul = text;
  }

  async listSessions(profile: string, limit: number) {
    this.enter('listSessions', [profile]);
    this.profile(profile);
    return (this.sessions.get(profile) ?? []).slice(0, limit);
  }

  async getConcurrencyCap() {
    this.enter('getConcurrencyCap');
    return this.concurrencyCap;
  }
}
