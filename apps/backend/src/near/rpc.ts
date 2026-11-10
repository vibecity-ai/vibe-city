/* A small NEAR JSON-RPC client: account balances and contract view calls (no keys, read-only). */

export const DEFAULT_RPC = { mainnet: 'https://rpc.mainnet.fastnear.com', testnet: 'https://rpc.testnet.fastnear.com' } as const;

export class NearRpcError extends Error {
  /** The RPC's error cause (UNKNOWN_ACCOUNT, ...), when it gave one. */
  cause_: string;
  constructor(message: string, cause_ = '') { super(message); this.cause_ = cause_; }
}

/** An account's contract: `codeHash` is all ones when it runs a global contract, named by `globalCodeHash`. */
export interface AccountInfo { amount: string; codeHash: string; globalCodeHash: string | null }

export interface NearReader {
  /** Liquid balance in yoctoNEAR, or throws (unknown account included). */
  balance(accountId: string): Promise<string>;
  view<T = unknown>(contract: string, method: string, args?: Record<string, unknown>): Promise<T>;
  /** null when the account does not exist. */
  account(accountId: string): Promise<AccountInfo | null>;
  /** How many access keys the account has (0: nobody can sign for it). */
  keyCount(accountId: string): Promise<number>;
}

export class NearRpc implements NearReader {
  private url: string; private f: typeof fetch; private timeoutMs: number;
  constructor(url: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) { this.url = url; this.f = opts.fetch ?? globalThis.fetch; this.timeoutMs = opts.timeoutMs ?? 8000; }

  private async query(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.f(this.url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'vc', method: 'query', params: { finality: 'final', ...params } }) });
    } catch (e) { throw new NearRpcError((e as Error).name === 'AbortError' ? 'The NEAR RPC took too long to answer.' : 'The NEAR RPC could not be reached.'); }
    finally { clearTimeout(t); }
    const body = (await res.json().catch(() => null)) as { result?: Record<string, unknown>; error?: { cause?: { name?: string }; data?: string; message?: string } } | null;
    if (!res.ok || !body) throw new NearRpcError(`The NEAR RPC answered HTTP ${res.status}.`);
    if (body.error) {
      const name = body.error.cause?.name ?? '';
      throw new NearRpcError(name === 'UNKNOWN_ACCOUNT' ? 'This account does not exist on this network.' : name === 'NO_CONTRACT_CODE' ? 'This account has no contract (is it a Sputnik DAO?).' : `NEAR RPC error: ${body.error.data ?? body.error.message ?? name}`.slice(0, 200), name);
    }
    const r = body.result ?? {};
    if (typeof r.error === 'string') throw new NearRpcError(`Contract error: ${r.error}`.slice(0, 200));
    return r;
  }

  async balance(accountId: string): Promise<string> {
    const r = await this.query({ request_type: 'view_account', account_id: accountId });
    if (typeof r.amount !== 'string') throw new NearRpcError('Unexpected account answer from the NEAR RPC.');
    return r.amount;
  }

  async view<T = unknown>(contract: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.query({ request_type: 'call_function', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    if (!Array.isArray(r.result)) throw new NearRpcError('Unexpected view answer from the NEAR RPC.');
    return JSON.parse(Buffer.from(r.result as number[]).toString('utf8')) as T;
  }

  async account(accountId: string): Promise<AccountInfo | null> {
    let r: Record<string, unknown>;
    try { r = await this.query({ request_type: 'view_account', account_id: accountId }); }
    catch (e) { if (e instanceof NearRpcError && e.cause_ === 'UNKNOWN_ACCOUNT') return null; throw e; }
    if (typeof r.amount !== 'string' || typeof r.code_hash !== 'string') throw new NearRpcError('Unexpected account answer from the NEAR RPC.');
    return { amount: r.amount, codeHash: r.code_hash, globalCodeHash: typeof r.global_contract_hash === 'string' ? r.global_contract_hash : null };
  }

  async keyCount(accountId: string): Promise<number> {
    const r = await this.query({ request_type: 'view_access_key_list', account_id: accountId });
    if (!Array.isArray(r.keys)) throw new NearRpcError('Unexpected key list from the NEAR RPC.');
    return r.keys.length;
  }
}
