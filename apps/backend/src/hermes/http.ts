import { HermesAuthError, HermesNotFoundError, HermesRejectedError, HermesUnavailableError } from './ports.ts';

export interface HermesHttpOptions {
  baseUrl: string;
  /** Server-side only. */
  sessionToken: string;
  timeoutMs?: number;
}

/** Shared dashboard HTTP access: auth header, timeouts, one retry for idempotent reads, error classification. */
export class HermesHttp {
  private o: Required<HermesHttpOptions>;
  constructor(opts: HermesHttpOptions) {
    this.o = { timeoutMs: 15_000, ...opts };
  }

  /** Returns an OK response (body unread) or throws a classified Hermes error. */
  async raw(method: string, path: string, opts: { auth?: boolean; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const url = new URL(path, this.o.baseUrl);
    let res: Response | undefined;
    const attempts = method === 'GET' ? 2 : 1; // reads are idempotent; writes are never retried automatically
    for (let attempt = 0; attempt < attempts && !res; attempt++) {
      try {
        res = await fetch(url, {
          method,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs),
          headers: {
            ...(opts.auth === false ? {} : { 'X-Hermes-Session-Token': this.o.sessionToken }),
            ...(opts.body ? { 'content-type': 'application/json' } : {}),
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
        });
      } catch (e) {
        if (attempt === attempts - 1) throw new HermesUnavailableError(`Hermes dashboard unreachable (${(e as Error).name})`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!res) throw new HermesUnavailableError('Hermes dashboard unreachable');
    if (res.status === 401 || res.status === 403) throw new HermesAuthError('Hermes rejected the session token');
    if (res.status >= 500) throw new HermesUnavailableError(`Hermes error ${res.status}`);
    if (res.status === 404) throw new HermesNotFoundError('Hermes: not found');
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { detail?: unknown };
      throw new HermesRejectedError(`Hermes ${res.status}: ${typeof j.detail === 'string' ? j.detail : res.statusText}`);
    }
    return res;
  }

  async json<T>(method: string, path: string, opts: { auth?: boolean; body?: unknown } = {}): Promise<T> {
    return (await (await this.raw(method, path, opts)).json()) as T;
  }
}
