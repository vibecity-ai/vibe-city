/* The chat model behind the dialogue window: any OpenAI-compatible chat completions endpoint. In the container this
   is NEAR AI Cloud (NEAR_AI_API_KEY / NEAR_AI_BASE_URL / NEAR_AI_MODEL, the same settings Hermes uses).
   The key stays on the server and is never put in an error message or a response. */

export interface ChatTurn { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatOpts { maxTokens?: number; temperature?: number; /** Override the configured model id. */ model?: string }
export interface ChatRun { content: string; tokens: number | null; model: string }

export interface ChatModel {
  /** True when a key (or a fake) is configured. */
  readonly ready: boolean;
  complete(messages: ChatTurn[], opts?: ChatOpts): Promise<string>;
  /** Like complete, with the token count and the model that answered (for interview stats). */
  run?(messages: ChatTurn[], opts?: ChatOpts): Promise<ChatRun>;
}

export class ModelUnavailableError extends Error {}
export class ModelFailedError extends Error {}

export interface OpenAiCompatOptions {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class OpenAiCompatModel implements ChatModel {
  private o: OpenAiCompatOptions;
  constructor(o: OpenAiCompatOptions) { this.o = o; }
  get ready() { return !!this.o.apiKey; }

  async complete(messages: ChatTurn[], opts: ChatOpts = {}): Promise<string> {
    return (await this.run(messages, opts)).content;
  }

  async run(messages: ChatTurn[], opts: ChatOpts = {}): Promise<ChatRun> {
    if (!this.o.apiKey) throw new ModelUnavailableError('No chat model is configured. Set NEAR_AI_API_KEY and restart.');
    const f = this.o.fetch ?? globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await f(`${this.o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({ model: opts.model ?? this.o.model, messages, max_tokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.8 }),
      });
    } catch (e) {
      throw new ModelFailedError((e as Error).name === 'AbortError' ? 'The model took too long to answer.' : 'The model endpoint could not be reached.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) throw new ModelFailedError('The model provider rejected the API key.');
    if (!res.ok) throw new ModelFailedError(`The model provider answered HTTP ${res.status}.`);
    const body = (await res.json().catch(() => null)) as { model?: unknown; usage?: { total_tokens?: unknown }; choices?: { message?: { content?: unknown } }[] } | null;
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new ModelFailedError('The model returned an empty answer.');
    const tokens = typeof body?.usage?.total_tokens === 'number' ? body.usage.total_tokens : null;
    return { content, tokens, model: typeof body?.model === 'string' ? body.model : (opts.model ?? this.o.model) };
  }
}

/** Scripted model for tests and the offline demo. */
export class FakeChatModel implements ChatModel {
  ready = true;
  calls: ChatTurn[][] = [];
  private answer: (messages: ChatTurn[]) => string;
  constructor(answer: (messages: ChatTurn[]) => string = () => JSON.stringify({ say: 'On it, boss.', mood: 'happy', replies: ['Thanks'], proposal: null })) { this.answer = answer; }
  async complete(messages: ChatTurn[]): Promise<string> {
    this.calls.push(messages);
    return this.answer(messages);
  }
  async run(messages: ChatTurn[], opts: ChatOpts = {}): Promise<ChatRun> {
    const content = await this.complete(messages);
    return { content, tokens: Math.round(content.length / 4) + messages.reduce((n, m) => n + Math.round(m.content.length / 4), 0), model: opts.model ?? 'fake-model' };
  }
}
