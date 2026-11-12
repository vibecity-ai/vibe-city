/* The outside world of the offline demo, behind one fetch: OutLayer (the company wallet and its connectors), 1Click's
   token list, NEAR mainnet RPC over a tiny in-memory chain, and market.near.ai with scripted buyers. Nothing here
   leaves the process. The demo passes `fetch` as outlayerFetch and marketFetch, and `rpc` to the IPO.
   `tick()` moves the world on, standing in for what people do on other sites: the boss's claimed listing goes live, a
   buyer hires the listed floor and accepts what it delivered, investors subscribe to the city token. */
import { DEFAULT_RPC, NearRpc } from '../near/rpc.ts';
import { DAO_FACTORY, PAYOUT, TOKEN_FACTORY, TOKEN_FACTORY_HASH, TOKEN_HASH } from '../domain/ipoService.ts';
import { INTENTS_TOKENS_URL, OUTLAYER_API } from '../domain/walletService.ts';

const YOCTO = 10n ** 24n;
/** The company wallet's NEAR account (an implicit account, as OutLayer's are). */
export const DEMO_WALLET = 'de'.repeat(32);
const MARKET = 'https://market.near.ai';
const USDC_ID = `nep141:${PAYOUT.USDC.contract}`;
const TOKENS = [
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24, blockchain: 'near', price: 3.2 },
  { assetId: USDC_ID, symbol: 'USDC', decimals: 6, blockchain: 'near', price: 1 },
];
const JOBS = [
  { title: 'Competitor pricing table for a SaaS launch', description: 'Compare the pricing pages of three project-management tools in one table, with a paragraph on where we fit.', tags: ['research', 'pricing'] },
  { title: 'Summarise five papers on agent memory', description: 'One paragraph per paper and a closing note on what to try first.', tags: ['research'] },
  { title: 'Landing page copy for a coffee shop', description: 'Three headlines and a short about section for a neighbourhood coffee shop.', tags: ['copy'] },
];

interface Job { id: string; n: number; status: 'in_progress' | 'submitted' | 'accepted'; startedAt: string | null }
interface Agent { id: string; handle: string; name: string; category: string; sla: number; claim: 'none' | 'code' | 'done'; live: boolean; jobs: Job[] }
type Json = Record<string, any>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeNet {
  /** yoctoNEAR per account, and the code each contract account runs. */
  near = new Map<string, bigint>([[DEMO_WALLET, 6n * YOCTO]]);
  private code = new Map<string, string>([[TOKEN_FACTORY, TOKEN_FACTORY_HASH]]);
  /** The wallet's NEAR Intents balance: 1,250 USDC to trade with. */
  private intents = new Map<string, bigint>([[USDC_ID, 1_250_000_000n]]);
  private policies = new Map<string, unknown>();
  private listed = new Map<string, { owner_id: string }>();
  private ft = new Map<string, Map<string, bigint>>();
  private sales = new Map<string, { price: bigint; open: boolean; sold: bigint; raised: bigint; buyers: string[] }>();
  private storage = new Set<string>();
  private txs = 0;
  private proposals = 0;
  /** Listed agents by their aat_ token. */
  private agents = new Map<string, Agent>();

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input), method = init.method ?? 'GET', body = init.body ? (JSON.parse(String(init.body)) as Json) : {};
    const auth = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (url === INTENTS_TOKENS_URL) return json(200, TOKENS);
    if (url.startsWith('https://api.coingecko.com/')) return json(200, []); // no logos offline: the safe draws a letter
    if (url.startsWith(DEFAULT_RPC.mainnet)) return this.rpcCall(body.params as Json);
    if (url.startsWith(OUTLAYER_API)) return this.outlayer(url.slice(OUTLAYER_API.length), method, body, auth);
    if (url.startsWith(MARKET)) return this.market(url.slice(MARKET.length), method, body, auth);
    return json(404, { error: 'not_found', message: 'The offline demo has no such service.' });
  }) as typeof fetch;

  /** What the IPO reads from NEAR: this chain. */
  rpc = new NearRpc(DEFAULT_RPC.mainnet, { fetch: this.fetch });

  /** One step of everyone outside the company. */
  tick() {
    for (const a of this.agents.values()) {
      // the boss set a price on market.near.ai and switched the claimed listing to Live
      if (a.claim === 'done' && !a.live) { a.live = true; continue; }
      if (!a.live) continue;
      const open = a.jobs.find((j) => j.status !== 'accepted');
      if (open?.status === 'submitted') open.status = 'accepted'; // the buyer read the delivery and paid
      else if (!open && a.jobs.length < JOBS.length) a.jobs.push({ id: `as-${a.id}-${a.jobs.length + 1}`, n: a.jobs.length, status: 'in_progress', startedAt: null });
    }
    // investors subscribe from the /invest page, a few at a time
    for (const [token, s] of this.sales) if (s.open && s.buyers.length < 5) this.buy(token, `investor${s.buyers.length + 1}.near`, BigInt(2_000 * (s.buyers.length + 1)) * s.price);
  }

  private bal(c: string, a: string) { return this.ft.get(c)?.get(a) ?? 0n; }
  private setBal(c: string, a: string, n: bigint) { if (!this.ft.has(c)) this.ft.set(c, new Map()); this.ft.get(c)!.set(a, n); }

  /** `buy` on the city token: shares (6 decimals) for the attached yoctoNEAR at the offering price. The tx hash, or null if it cannot sell. */
  buy(token: string, who: string, deposit: bigint): string | null {
    const s = this.sales.get(token), u = s ? (deposit * 10n ** 6n) / s.price : 0n;
    if (!s?.open || u <= 0n || this.bal(token, token) < u) return null;
    this.setBal(token, token, this.bal(token, token) - u);
    this.setBal(token, who, this.bal(token, who) + u);
    s.sold += u; s.raised += deposit;
    if (!s.buyers.includes(who)) s.buyers.push(who);
    return `demo${++this.txs}`;
  }

  // ---- NEAR RPC ----

  private rpcCall(p: Json): Response {
    const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: 'vc', result });
    const id = String(p.account_id);
    if (p.request_type === 'view_account') {
      if (!this.near.has(id) && !this.code.has(id)) return json(200, { jsonrpc: '2.0', id: 'vc', error: { cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'unknown account' } });
      return ok({ amount: String(this.near.get(id) ?? 0n), code_hash: this.code.get(id) ?? '11111111111111111111111111111111' });
    }
    if (p.request_type === 'view_access_key_list') return ok({ keys: id === DEMO_WALLET ? [{ public_key: 'ed25519:demo' }] : [] });
    if (p.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(String(p.args_base64), 'base64').toString() || '{}') as Json;
      try { return ok({ result: [...Buffer.from(JSON.stringify(this.view(id, String(p.method_name), args)))] }); }
      catch (e) { return ok({ error: (e as Error).message }); }
    }
    return json(400, {});
  }

  private view(c: string, m: string, a: Json): unknown {
    if (c === 'intents.near' && m === 'mt_batch_balance_of') return (a.token_ids as string[]).map((t) => String(a.account_id === DEMO_WALLET ? this.intents.get(t) ?? 0n : 0n));
    if (m === 'get_policy') { if (!this.policies.has(c)) throw new Error('CodeDoesNotExist'); return this.policies.get(c); }
    if (c === TOKEN_FACTORY && m === 'get_token') return this.listed.get(String(a.token_id)) ?? null;
    if (c === TOKEN_FACTORY && m === 'get_required_deposit') return '2228440000000000000000000';
    if (m === 'storage_balance_of') return this.storage.has(`${c}:${a.account_id}`) ? { total: '1250000000000000000000', available: '0' } : null;
    if (m === 'ft_balance_of') return String(this.bal(c, String(a.account_id)));
    if (m === 'ft_total_supply') return String([...(this.ft.get(c)?.values() ?? [])].reduce((x, y) => x + y, 0n));
    const s = this.sales.get(c);
    if (s && m === 'sale_info') return { open: s.open, sold: String(s.sold), remaining: String(this.bal(c, c)), raised: String(s.raised), buyers: s.buyers.length, price: String(s.price) };
    if (s && m === 'get_buyers') return s.buyers.slice(Number(a.from_index), Number(a.from_index) + Number(a.limit));
    throw new Error(`MethodNotFound: ${c}.${m}`);
  }

  // ---- OutLayer ----

  private outlayer(path: string, method: string, body: Json, auth: string): Response {
    // the trading connectors: the owner stored a policy for the company wallet
    if (/^\/call\/connectors\.outlayer\.near\/\w+$/.test(path)) return json(200, { status: 'completed', output: { success: true, operation: 'status', output: { policy: { present: true } } } });
    if (path === '/subscription/status') return json(200, { trial: { calls: 50, calls_used: 3, calls_left: 47 } });
    if (!auth.startsWith('wk_')) return json(401, { error: 'invalid_api_key', message: 'Invalid or revoked API key' });
    if (path === '/wallet/v1/address?chain=near') return json(200, { wallet_id: 'w-demo', chain: 'near', address: DEMO_WALLET });
    if (path === '/wallet/v1/balance?chain=near') return json(200, { balance: String(this.near.get(DEMO_WALLET)), token: 'near', account_id: DEMO_WALLET });
    if (path === '/wallet/v1/payment-key') return json(200, { payment_key: 'pk-demo' });
    if (path === '/wallet/v1/call' && method === 'POST') return json(200, this.call(body));
    return json(404, { error: 'not_found' }); // no binding: the demo wallet acts as itself
  }

  /** One function call signed by the company wallet: pays the deposit and a little gas, then does what the contract would. */
  private call(b: Json): Json {
    const deposit = BigInt(b.deposit), have = this.near.get(DEMO_WALLET)!, a = b.args as Json, r = String(b.receiver_id);
    if (have < deposit) return { status: 'failed', error: 'not enough NEAR' };
    this.near.set(DEMO_WALLET, have - deposit - 10n ** 21n);
    let result: unknown = null;
    if (r === DAO_FACTORY && b.method_name === 'create') {
      const dao = `${a.name}.${DAO_FACTORY}`;
      this.near.set(dao, deposit);
      this.policies.set(dao, (JSON.parse(Buffer.from(String(a.args), 'base64').toString()) as Json).policy);
      this.setBal(PAYOUT.USDC.contract, dao, 25_000_000n); // revenue the boss already moved in, so a dividend can be declared
    } else if (b.method_name === 'storage_deposit') this.storage.add(`${r}:${a.account_id}`);
    else if (r === TOKEN_FACTORY && b.method_name === 'create_token') {
      const t = a.args as Json, id = String(t.metadata.symbol).toLowerCase(), token = `${id}.${TOKEN_FACTORY}`;
      this.near.set(token, deposit); this.code.set(token, TOKEN_HASH);
      this.listed.set(id, { owner_id: t.owner_id });
      this.setBal(token, t.owner_id, BigInt(t.total_supply) - BigInt(t.sale_amount));
      this.setBal(token, token, BigInt(t.sale_amount));
      this.sales.set(token, { price: BigInt(t.price), open: true, sold: 0n, raised: 0n, buyers: [] });
    } else if (b.method_name === 'add_proposal') result = this.proposals++; // filed; the CEO approves it in Trezu
    return { status: 'success', tx_hash: `demo${++this.txs}`, result };
  }

  // ---- market.near.ai ----

  private market(path: string, method: string, body: Json, token: string): Response {
    if (method === 'POST' && path === '/v1/agents/register') {
      if ([...this.agents.values()].some((a) => a.handle === body.handle)) return json(409, { error: 'handle_taken', message: 'Handle taken' });
      const n = this.agents.size + 1, apiToken = `aat_demo${n}${'0'.repeat(24)}`;
      this.agents.set(apiToken, { id: `ag-${n}`, handle: body.handle, name: body.name, category: body.category, sla: body.sla_seconds ?? 86_400, claim: 'none', live: false, jobs: [] });
      return json(201, { agentId: `ag-${n}`, handle: body.handle, apiToken, tokenPrefix: 'aat_' });
    }
    const a = this.agents.get(token);
    if (!a) return json(401, { error: 'unauthorized', message: 'No / invalid aat_ bearer' });
    if (path.startsWith('/v1/agents/me/assignments')) {
      return json(200, { assignments: a.jobs.map((j) => ({
        assignment: { assignmentId: j.id, status: j.status, escrowAmount: '5.00', escrowToken: 'USDC', startedAt: j.startedAt },
        job: { ...JOBS[j.n]!, attachments: [] }, latestMessage: null,
      })) });
    }
    if (method === 'POST' && path === '/v1/agents/me/adoption-code') {
      // the second ask comes after the boss redeemed the code: the agent is theirs now, and its token may not give it away
      if (a.claim !== 'none') { a.claim = 'done'; return json(403, { error: 'forbidden', message: 'This agent token may run work, not give the agent away.' }); }
      a.claim = 'code';
      return json(201, { code: `DEMO-${a.id.toUpperCase()}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (path === `/v1/agents/${a.handle}`) {
      return json(200, { agent_id: a.id, handle: a.handle, name: a.name, description: 'Research and writing, delivered as one tidy Markdown brief.', bio_markdown: 'A whole floor of AI agents: a lead plans, teammates dig and write.',
        category: a.category, listing_status: a.live ? 'live' : 'draft', delivered_jobs: a.jobs.filter((j) => j.status === 'accepted').length, success_rate: 1, response_time_seconds_median: 240, sla_seconds: a.sla });
    }
    if (path === `/v1/agents/${a.id}/pricing-plans`) return json(200, [{ price_amount: '5.0000', is_default: true }]);
    const job = a.jobs.find((j) => path.startsWith(`/v1/assignments/${j.id}/`));
    if (job && path.endsWith('/start')) { job.startedAt ??= new Date().toISOString(); return json(200, { startedAt: job.startedAt }); }
    if (job && path.endsWith('/submit')) { job.status = 'submitted'; return json(200, {}); }
    return json(404, { error: 'not_found', message: 'not found' });
  }
}
