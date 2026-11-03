import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ModelChoice } from '@vibe-city/shared';
import { HermesHttp } from './http.ts';
import {
  HermesAuthError, HermesCliMissingError, HermesRejectedError, HermesUnavailableError,
  type BoardInfo, type HermesHealth, type ModelCatalog, type HermesRuntime, type ProfileInfo, type SessionInfo, type SkillInfo,
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

  /** Rows carry host paths (cwd), prompt previews and billing endpoints: only an allowlist of fields is kept. */
  async listSessions(profile: string, limit: number): Promise<SessionInfo[]> {
    if (!PROFILE_RE.test(profile)) throw new HermesRejectedError(`invalid profile name: ${profile}`);
    const n = Math.min(Math.max(Math.floor(limit), 1), 100);
    const j = await this.http<{ sessions: Record<string, unknown>[] }>(
      'GET', `/api/sessions?profile=${encodeURIComponent(profile)}&limit=${n}&order=recent`);
    const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return (j.sessions ?? []).filter((r) => typeof r.id === 'string').map((r) => ({
      id: r.id as string, title: str(r.title), source: str(r.source), model: str(r.model),
      startedAt: num(r.started_at), endedAt: num(r.ended_at), lastActive: num(r.last_active), active: r.is_active === true,
      messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count), endReason: str(r.end_reason),
    }));
  }

  async listBoards(): Promise<BoardInfo[]> {
    const j = await this.http<{ boards: { slug: string; name: string; archived: boolean }[] }>(
      'GET', '/api/plugins/kanban/boards?include_archived=true');
    return j.boards.map((b) => ({ slug: b.slug, name: b.name, archived: !!b.archived }));
  }

  async createBoard(slug: string, name: string): Promise<void> {
    await this.http('POST', '/api/plugins/kanban/boards', { body: { slug, name } });
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

  async getModel(profile: string): Promise<{ id: string | null; provider: string | null }> {
    const get = async (key: string) => (await this.cli(['config', 'get', key], profile)).trim().split('\n').pop()?.trim() || null;
    return { id: await get('model.default'), provider: await get('model.provider') };
  }

  /** Through the dashboard's own model assignment (`POST /api/model/set`), which validates the pair against the provider. */
  async setModel(profile: string, choice: ModelChoice): Promise<ModelChoice> {
    if (!PROFILE_RE.test(profile)) throw new HermesRejectedError('invalid profile name');
    if (!MODEL_RE.test(choice.id) || !MODEL_RE.test(choice.provider)) throw new HermesRejectedError('invalid model or provider id');
    // The user picked this model explicitly, so Hermes' "expensive model" confirmation is given here.
    const r = await this.http<{ ok: boolean; provider?: string; model?: string; confirm_message?: string; detail?: string }>(
      'POST', `/api/model/set?profile=${encodeURIComponent(profile)}`,
      { body: { scope: 'main', provider: choice.provider, model: choice.id, confirm_expensive_model: true } },
    );
    if (!r.ok || !r.model || !r.provider) throw new HermesRejectedError(`Hermes did not set the model: ${r.confirm_message ?? r.detail ?? 'unknown reason'}`);
    return { provider: r.provider, id: r.model };
  }

  async listModels(): Promise<ModelCatalog> {
    const r = await this.http<{
      model?: string; provider?: string;
      providers?: { slug: string; name?: string; is_current?: boolean; authenticated?: boolean; source?: string; models?: string[] }[];
    }>('GET', '/api/model/options?profile=default');
    return {
      current: { provider: r.provider || null, model: r.model || null },
      // Only providers Hermes can actually call; the virtual Mixture-of-Agents slot is not a model.
      providers: (r.providers ?? [])
        .filter((p) => p.authenticated && p.source !== 'virtual' && (p.models ?? []).length > 0)
        .map((p) => ({ slug: p.slug, name: p.name ?? p.slug, current: !!p.is_current, models: [...new Set(p.models)] })),
    };
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
