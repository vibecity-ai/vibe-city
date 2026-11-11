import { execFile } from 'node:child_process';
import { reasoningEffortFor } from './reasoningEffort.ts';
import { promisify } from 'node:util';
import type { ModelChoice } from '@vibe-city/shared';
import { HermesHttp } from './http.ts';
import {
  HermesAuthError, HermesCliMissingError, HermesRejectedError, HermesUnavailableError,
  type BoardInfo, type HermesHealth, type ModelCatalog, type HermesRuntime, type ProfileInfo, type SessionInfo, type SessionMessage, type SkillInfo, type ToolsetPlatform,
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
const SESSION_RE = /^[A-Za-z0-9._-]{1,128}$/;

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

  /** A profile-scoped dashboard call (milliseconds, where the equivalent CLI call starts a Python process for 2-5 s). */
  private profileHttp<T>(method: string, path: string, profile: string, body?: unknown): Promise<T> {
    if (!PROFILE_RE.test(profile)) throw new HermesRejectedError('invalid profile name');
    return this.http<T>(method, path.replace(':p', encodeURIComponent(profile)), body === undefined ? {} : { body });
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
      messageCount: num(r.message_count), toolCallCount: num(r.tool_call_count), endReason: str(r.end_reason), preview: str(r.preview),
    }));
  }

  async sessionMessages(profile: string, sessionId: string, limit: number): Promise<SessionMessage[]> {
    if (!PROFILE_RE.test(profile)) throw new HermesRejectedError('invalid profile name');
    if (!SESSION_RE.test(sessionId)) throw new HermesRejectedError('invalid session id');
    const n = Math.min(Math.max(Math.floor(limit), 1), 500);
    type Call = { id?: unknown; call_id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const j = await this.http<{ messages: { role?: unknown; content?: unknown; timestamp?: unknown; tool_calls?: unknown; tool_call_id?: unknown; tool_name?: unknown }[] }>(
      'GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages?profile=${encodeURIComponent(profile)}&limit=${n}&order=latest`);
    const s = (v: unknown) => (typeof v === 'string' ? v : null);
    return (j.messages ?? []).flatMap((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' ? [{
      role: m.role, content: s(m.content) ?? '', at: typeof m.timestamp === 'number' ? new Date(m.timestamp * 1000).toISOString() : null,
      calls: (Array.isArray(m.tool_calls) ? (m.tool_calls as Call[]) : []).map((c) => ({
        id: s(c.call_id) ?? s(c.id) ?? '', name: s(c.function?.name) ?? 'tool', args: s(c.function?.arguments) ?? '',
      })),
      toolCallId: s(m.tool_call_id), toolName: s(m.tool_name),
    }] : []));
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

  async getToolsets(profile: string, platform: ToolsetPlatform = 'cli'): Promise<Record<string, boolean>> {
    const map = parseToolsList(await this.cli(['tools', 'list', '--platform', platform], profile));
    if (!Object.keys(map).length) throw new HermesRejectedError('could not read toolsets (unexpected CLI output)');
    return map;
  }

  async setToolsets(profile: string, change: { enable: string[]; disable: string[] }, platform: ToolsetPlatform = 'cli'): Promise<void> {
    for (const n of [...change.enable, ...change.disable]) if (!TOOLSET_RE.test(n)) throw new HermesRejectedError('invalid toolset name');
    if (change.enable.length) await this.cli(['tools', 'enable', ...change.enable, '--platform', platform], profile);
    if (change.disable.length) await this.cli(['tools', 'disable', ...change.disable, '--platform', platform], profile);
  }

  async listSkills(profile: string): Promise<SkillInfo[]> {
    const rows = await this.profileHttp<{ name: string; enabled: boolean }[]>('GET', '/api/skills?profile=:p', profile);
    return rows.map((r) => ({ name: r.name, enabled: r.enabled === true }));
  }

  async setDisabledSkills(profile: string, names: string[]): Promise<void> {
    await this.cli(['config', 'set', 'skills.disabled', JSON.stringify([...names].sort()), '--force'], profile);
  }

  async getModel(profile: string): Promise<{ id: string | null; provider: string | null }> {
    const r = await this.profileHttp<{ model?: string | null; provider?: string | null }>('GET', '/api/model/info?profile=:p', profile);
    return { id: r.model || null, provider: r.provider || null };
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
    // the effort this model accepts (Qwen 3.x rejects the 'high' every other profile runs with)
    await this.cli(['config', 'set', 'agent.reasoning_effort', reasoningEffortFor(r.model)], profile);
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

  async readInstructions(profile: string): Promise<string | null> {
    return (await this.profileHttp<{ content?: string | null }>('GET', '/api/profiles/:p/soul', profile)).content || null;
  }

  async writeInstructions(profile: string, text: string): Promise<void> {
    await this.profileHttp('PUT', '/api/profiles/:p/soul', profile, { content: text });
  }

  async setMcpServer(profile: string, name: string, config: { url: string; headers: Record<string, string>; tools: { include: string[] } }): Promise<void> {
    // Same mechanism as skills.disabled: a JSON value under a dotted key of the profile's config.yaml.
    await this.cli(['config', 'set', `mcp_servers.${name}`, JSON.stringify(config), '--force'], profile);
  }

  async setPlatformMcpServers(profile: string, platform: ToolsetPlatform, servers: string[]): Promise<void> {
    for (const s of servers) if (!PROFILE_RE.test(s)) throw new HermesRejectedError('invalid MCP server name');
    // `tools enable` refuses MCP names, but its later saves keep them in the list, so writing them once sticks.
    const on = Object.entries(await this.getToolsets(profile, platform)).filter(([, v]) => v).map(([k]) => k);
    await this.cli(['config', 'set', `platform_toolsets.${platform}`, JSON.stringify([...new Set([...on, ...servers])].sort()), '--force'], profile);
  }

  async setProfileEnv(profile: string, vars: Record<string, string>): Promise<void> {
    for (const [name, value] of Object.entries(vars)) {
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name) || !value || /[\r\n\0]/.test(value)) throw new HermesRejectedError(`invalid env variable ${name}`);
      // An UPPER_SNAKE name: `config set` stores it in the profile's .env, not config.yaml.
      await this.cli(['config', 'set', name, value], profile);
    }
  }

  async setProviderBaseUrl(profile: string, provider: string, url: string): Promise<void> {
    if (!PROFILE_RE.test(provider) || !/^https?:\/\/[\w.:/-]+$/.test(url)) throw new HermesRejectedError('invalid provider base URL');
    await this.cli(['config', 'set', `providers.${provider}.api`, url], profile);
  }

  async unsetProfileEnv(profile: string, names: string[]): Promise<void> {
    for (const name of names) {
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new HermesRejectedError(`invalid env variable ${name}`);
      // `config unset` routes an UPPER_SNAKE name to the profile's .env, and exits non-zero when the name is not set
      // there: that refusal means it is already gone. Timeouts and a missing CLI still throw.
      try { await this.cli(['config', 'unset', name], profile); } catch (e) { if (!(e instanceof HermesRejectedError)) throw e; }
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
