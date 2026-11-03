import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HermesHttp } from './http.ts';
import {
  HermesAuthError, HermesCliMissingError, HermesRejectedError, HermesUnavailableError,
  type BoardInfo, type HermesHealth, type HermesRuntime, type ProfileInfo, type SkillInfo,
} from './ports.ts';

const execFileP = promisify(execFile);

export interface RealRuntimeOptions {
  baseUrl: string; // dashboard, e.g. http://127.0.0.1:9119
  sessionToken: string; // server-side only
  hermesBin?: string;
  requestTimeoutMs?: number;
  cliTimeoutMs?: number;
  log?: (msg: string) => void;
}

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOOLSET_RE = /^[a-z0-9_]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,128}$/;

// ---- parsers for `hermes` CLI output (exported for fixture tests) ------------

/** Parses `hermes tools list`: lines like "  ✓ enabled  web  🔍 Web Search". */
export function parseToolsList(out: string): Record<string, boolean> {
  const res: Record<string, boolean> = {};
  for (const line of out.split('\n')) {
    const m = /^\s*[✓✗]\s+(enabled|disabled)\s+([a-z0-9_]+)\b/.exec(line);
    if (m) res[m[2]!] = m[1] === 'enabled';
  }
  return res;
}

/** Parses the rich table printed by `hermes skills list` (rows start with │). */
export function parseSkillsList(out: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line.trimStart().startsWith('│')) continue;
    const cells = line.split('│').slice(1, -1).map((c) => c.trim());
    const name = cells[0];
    const status = cells[cells.length - 1];
    if (name && (status === 'enabled' || status === 'disabled')) skills.push({ name, enabled: status === 'enabled' });
  }
  // A truncated name would silently produce a wrong disable list: refuse instead of guessing.
  if (skills.some((s) => s.name.includes('…'))) throw new HermesRejectedError('skills table was truncated by the terminal width');
  return skills;
}

export class RealHermesRuntime implements HermesRuntime {
  private o: Required<Omit<RealRuntimeOptions, 'log'>> & { log: (m: string) => void };
  private web: HermesHttp;

  constructor(opts: RealRuntimeOptions) {
    this.o = {
      hermesBin: 'hermes', requestTimeoutMs: 15_000, cliTimeoutMs: 120_000, log: () => {}, ...opts,
    };
    this.web = new HermesHttp({ baseUrl: this.o.baseUrl, sessionToken: this.o.sessionToken, timeoutMs: this.o.requestTimeoutMs });
  }

  // ---- dashboard REST -------------------------------------------------------

  private http<T>(method: string, path: string, opts: { auth?: boolean; body?: unknown } = {}): Promise<T> {
    return this.web.json<T>(method, path, opts);
  }

  async health(): Promise<HermesHealth> {
    let status: { gateway_running?: boolean; gateway_state?: string; displayVersion?: string; version?: string };
    try {
      status = await this.http('GET', '/api/status', { auth: false });
    } catch (e) {
      if (e instanceof HermesAuthError) throw e;
      return { dashboard: 'down', auth: 'unknown', gateway: 'unknown', version: null, detail: 'dashboard unreachable' };
    }
    const gateway = status.gateway_running ? 'running' : 'stopped';
    let auth: HermesHealth['auth'] = 'ok';
    try {
      await this.http('GET', '/api/plugins/kanban/profiles');
    } catch (e) {
      if (e instanceof HermesAuthError) auth = 'rejected';
      else if (e instanceof HermesUnavailableError) return { dashboard: 'down', auth: 'unknown', gateway: 'unknown', version: null, detail: 'dashboard unreachable' };
    }
    return { dashboard: 'up', auth, gateway, version: status.displayVersion ?? status.version ?? null, detail: status.gateway_state ?? null };
  }

  async listProfiles(): Promise<ProfileInfo[]> {
    const j = await this.http<{ profiles: { name: string; is_default: boolean; model: string | null; description: string | null }[] }>(
      'GET', '/api/plugins/kanban/profiles');
    return j.profiles.map((p) => ({ name: p.name, isDefault: p.is_default, model: p.model ?? null, description: p.description ?? null }));
  }

  async listBoards(): Promise<BoardInfo[]> {
    const j = await this.http<{ boards: { slug: string; name: string; archived: boolean; default_workdir: string | null }[] }>(
      'GET', '/api/plugins/kanban/boards?include_archived=true');
    return j.boards.map((b) => ({ slug: b.slug, name: b.name, archived: !!b.archived, defaultWorkdir: b.default_workdir ?? null }));
  }

  async createBoard(slug: string, name: string, opts: { defaultWorkdir?: string }): Promise<void> {
    await this.http('POST', '/api/plugins/kanban/boards', {
      body: { slug, name, ...(opts.defaultWorkdir ? { default_workdir: opts.defaultWorkdir } : {}) },
    });
  }

  // ---- hermes CLI ---------------------------------------------------------------

  private async cli(args: string[], profile?: string): Promise<string> {
    if (profile !== undefined && !PROFILE_RE.test(profile)) throw new HermesRejectedError('invalid profile name');
    const full = [...(profile ? ['-p', profile] : []), ...args];
    try {
      // COLUMNS: Hermes prints rich tables that truncate long names ("name…") at narrow widths.
      const { stdout } = await execFileP(this.o.hermesBin, full, {
        timeout: this.o.cliTimeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, COLUMNS: '250', NO_COLOR: '1' },
      });
      return stdout;
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (err.code === 'ENOENT') throw new HermesCliMissingError('the hermes executable was not found');
      if (err.killed) throw new HermesUnavailableError('hermes CLI timed out');
      // stderr can contain host paths: keep it in the server log, not in API-visible messages.
      this.o.log(`hermes ${full.join(' ')} failed: ${err.stderr ?? err.message}`);
      throw new HermesRejectedError(`hermes ${args.slice(0, 2).join(' ')} failed`);
    }
  }

  async createProfile(name: string, opts: { description: string }): Promise<void> {
    if (!PROFILE_RE.test(name)) throw new HermesRejectedError('invalid profile name');
    await this.cli(['profile', 'create', name, '--clone', '--no-alias', '--description', opts.description]);
  }

  async getToolsets(profile: string): Promise<Record<string, boolean>> {
    const map = parseToolsList(await this.cli(['tools', 'list'], profile));
    if (!Object.keys(map).length) throw new HermesRejectedError('could not read toolsets (unexpected CLI output)');
    return map;
  }

  async setToolsets(profile: string, change: { enable: string[]; disable: string[] }): Promise<void> {
    for (const n of [...change.enable, ...change.disable]) if (!TOOLSET_RE.test(n)) throw new HermesRejectedError('invalid toolset name');
    if (change.enable.length) await this.cli(['tools', 'enable', ...change.enable], profile);
    if (change.disable.length) await this.cli(['tools', 'disable', ...change.disable], profile);
  }

  async listSkills(profile: string): Promise<SkillInfo[]> {
    return parseSkillsList(await this.cli(['skills', 'list'], profile));
  }

  async setDisabledSkills(profile: string, names: string[]): Promise<void> {
    await this.cli(['config', 'set', 'skills.disabled', JSON.stringify([...names].sort()), '--force'], profile);
  }

  async getModel(profile: string): Promise<string | null> {
    const out = (await this.cli(['config', 'get', 'model.default'], profile)).trim().split('\n').pop()?.trim();
    return out ? out : null;
  }

  async setModel(profile: string, model: string): Promise<void> {
    if (!MODEL_RE.test(model)) throw new HermesRejectedError('invalid model id');
    await this.cli(['config', 'set', 'model.default', model], profile);
  }

  private async soulPath(profile: string): Promise<string> {
    const out = await this.cli(['profile', 'show', profile]);
    const m = /^Path:\s*(.+)$/m.exec(out);
    if (!m) throw new HermesRejectedError('could not resolve profile directory');
    return join(m[1]!.trim(), 'SOUL.md');
  }

  async readInstructions(profile: string): Promise<string | null> {
    try {
      return await readFile(await this.soulPath(profile), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e instanceof HermesRejectedError ? e : new HermesRejectedError('could not read profile instructions');
    }
  }

  async writeInstructions(profile: string, text: string): Promise<void> {
    const path = await this.soulPath(profile);
    const tmp = `${path}.vc-tmp`;
    try {
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, path);
    } catch {
      throw new HermesRejectedError('could not write profile instructions');
    }
  }

  async getConcurrencyCap(): Promise<number | null> {
    try {
      const out = (await this.cli(['config', 'get', 'kanban.max_in_progress_per_profile'])).trim().split('\n').pop() ?? '';
      const n = Number(out);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
}
