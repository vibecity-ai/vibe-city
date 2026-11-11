/* Offline demo: the real backend and web app, with in-memory fakes for everything outside it: Hermes, its Kanban and
   event stream, the chat model, NEAR AI Cloud (price list and the metering proxy's upstream), OutLayer, NEAR RPC and
   market.near.ai (src/testing/fakeNet.ts). Every feature of the container works and nothing talks to a real service:
   the first quest takes any key, the safe any wk_ key, and the agents work their boards once the key is in (each step
   goes through the metering proxy, so burn, budgets and runway are real numbers over fake work).

     npm run build -w @vibe-city/web
     WEB_DIST=../web/dist PORT=4199 npm run demo -w @vibe-city/backend   (then open http://127.0.0.1:4199)

   Set NEAR_AI_API_KEY to chat with the real model instead of the scripted one. */
import { readdirSync } from 'node:fs';
import { WebSocketServer, type AddressInfo } from 'ws';
import { openDb } from '../src/db/db.ts';
import { buildServices } from '../src/app.ts';
import { FAKE_MODELS, FAKE_SKILLS, FakeHermes } from '../src/testing/fakeHermes.ts';
import { FakeKanban } from '../src/testing/fakeKanban.ts';
import { FakeNet } from '../src/testing/fakeNet.ts';
import { FakeChatModel, OpenAiCompatModel } from '../src/model/chatModel.ts';
import type { ModelPrice } from '../src/model/nearPrices.ts';
import { aiKeyFor } from '../src/routes/ai.ts';
import { FakeAgentChat } from '../src/testing/fakeAgentChat.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig();
const db = openDb(':memory:');
// Hermes in the container has the skills of docker/skills installed; the fake gets the same list.
for (const e of readdirSync(new URL('../../../docker/skills/', import.meta.url), { withFileTypes: true })) if (e.isDirectory()) FAKE_SKILLS.push(e.name);
/** NEAR AI Cloud's price list, offline. Sample figures, not NEAR AI's current prices. */
const PRICES = new Map<string, ModelPrice>([
  ['deepseek-ai/DeepSeek-V4.1-Flash-1017', { inPerM: 0.15, outPerM: 0.6, cachedPerM: 0.003, context: 131_072, vision: false, privacy: 'private' }],
  ['deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated', { inPerM: 0.15, outPerM: 0.6, cachedPerM: 0.003, context: 131_072, vision: false, privacy: 'private' }],
  ['Qwen/Qwen3-235B-A22B', { inPerM: 0.2, outPerM: 0.8, context: 131_072, vision: false, privacy: 'confidential' }],
  ['zai-org/GLM-4.6', { inPerM: 0.6, outPerM: 2.2, context: 200_000, vision: false, privacy: 'private' }],
  ['openai/gpt-5.5', { inPerM: 2.5, outPerM: 10, context: 400_000, vision: true }],
]);
FAKE_MODELS[0]!.models.push(...PRICES.keys()); // Hermes' NEAR AI provider offers them
const net = new FakeNet();
const hermes = new FakeHermes({ model: cfg.chat.model });
const kanban = new FakeKanban();
kanban.realClock = true;
// Real Hermes gives a floor its Kanban board when the floor is provisioned; the fake board appears at the same moment.
const createBoard = hermes.createBoard.bind(hermes);
hermes.createBoard = async (slug, name) => { await createBoard(slug, name); if (!kanban.boards.has(slug)) kanban.addBoard(slug); };

const scripted = new FakeChatModel((turns) => {
  const last = turns.at(-1)?.content.toLowerCase() ?? '';
  const sys = turns[0]!.content;
  // The Chief of Staff drafts the Agent Market listing for the floor the boss names.
  if (sys.includes('listing ONE floor')) {
    const floors = [...(/Floors that can be listed:\n([\s\S]*?)\nCategories:/.exec(sys)?.[1] ?? '').matchAll(/^- ([^:\n]+):/gm)].map((m) => m[1]!.trim());
    const said = turns.filter((t) => t.role === 'user').map((t) => t.content.toLowerCase()).join(' ');
    const floor = floors.find((f) => said.includes(f.toLowerCase()));
    if (!floor) return JSON.stringify({ say: 'Which floor goes on the market, boss?', mood: 'focused', replies: floors.slice(0, 3), draft: null });
    const slug = floor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return JSON.stringify({ say: `${floor} it is. Here is the front page buyers will read. Register it and it goes up as a draft.`, mood: 'happy', replies: ['Make it cheaper', 'Faster delivery'],
      draft: { floor, handle: `${slug}-works`.slice(0, 30), name: `${floor} Works`, category: 'research', slaHours: 24, priceUsdc: /cheap/.test(said) ? '3.00' : '5.00',
        tagline: 'A whole floor of AI agents on your job: a lead plans, teammates dig and write.', description: 'One tidy Markdown brief per job, sources linked, delivered within a day.' } });
  }
  // AR writes the two serious personas.
  if (sys.startsWith('You write short')) {
    return JSON.stringify({ candidates: [
      { name: 'Ines Okoro', pitch: 'I clear queues. Give me the tickets nobody wants and a quiet desk.', traits: ['steady', 'organised'], speechStyle: 'calm and precise', quirk: 'labels everything with a label maker' },
      { name: 'Kai Lindgren', pitch: 'Bigger brain, more skills. I take the hard cases and write it all down.', traits: ['sharp', 'thorough'], speechStyle: 'confident, numbers-first', quirk: 'keeps three timers running' },
    ] });
  }
  // Candidate interviews.
  if (sys.includes('job candidate')) {
    const joke = sys.includes('joke candidate');
    if (joke) return JSON.stringify({ say: /test|summar/.test(last) ? "Great question. I'd circle back on that after we align on the vision. Also, is the corner office still free?" : "Honestly? I'm the best hire you'll ever make. My last three companies said so, right before they shut down.", mood: 'smug', replies: ['What did you do last job?', 'Thanks, next'] });
    return JSON.stringify({ say: /test|summar/.test(last) ? 'Your floor: support tickets in, answers out, nothing left waiting overnight. That is the job and I like it.' : 'I pick up the queue on day one, ask before I guess, and write down what I learn.', mood: 'happy', replies: ['What would you cost me?', 'Test: summarise our floor in one line'] });
  }
  // The Chief of Staff's hiring call: which floor, then the daily budget in dollars, then the brief.
  if (sys.includes('about a new hire')) {
    const said = turns.filter((t) => t.role === 'user').map((t) => t.content.toLowerCase()).join(' ');
    if (/not now/.test(last)) return JSON.stringify({ say: "Your call, boss. I'll keep the file open. Ring me when the floor starts smoking.", mood: 'annoyed', replies: ['Fine, find someone'], brief: null });
    const floors = [...sys.matchAll(/^- "([^"]+)"/gm)].map((m) => m[1]!);
    const why = /Why you are talking: ([^\n]*)/.exec(sys)?.[1] ?? '';
    const floor = floors.find((f) => said.includes(f.toLowerCase())) ?? floors.find((f) => why.includes(f));
    if (!floor) return JSON.stringify({ say: 'Happy to find someone, boss. Which floor is the hire for?', mood: 'focused', replies: floors.slice(0, 3), brief: null });
    const usd = Number(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars?|a day|per day)/.exec(said)?.slice(1).find(Boolean) ?? NaN);
    if (!(usd > 0)) return JSON.stringify({ say: `${floor} needs someone who can pick up its queue and keep it moving. What's the daily budget?`, mood: 'focused', replies: ['$2 a day', '$5 a day, get someone good'], brief: null });
    const focus = `Picks up ${floor}'s queue and keeps it moving`;
    return JSON.stringify({ say: `Got it: ${focus.toLowerCase()}, $${usd} a day. Here's the brief. Say the word and I'm out the door.`, mood: 'happy', replies: ['Change the budget'],
      brief: { department: floor, focus, skills: [], budgetPerDay: Math.round(usd * 100), notes: '' } });
  }
  // The Chief of Staff drafting an Agent Market listing.
  if (sys.includes('NEAR AI Agent Market')) {
    const said = turns.filter((t) => t.role === 'user').map((t) => t.content.toLowerCase()).join(' ');
    const block = /Floors that can be listed:\n([\s\S]*?)\nCategories:/.exec(sys)?.[1] ?? '';
    const floors = [...block.matchAll(/^- ([^:\n]+): (.*)$/gm)].map((m) => ({ name: m[1]!, purpose: m[2]!.replace(/ \(not synced.*$/, '') }));
    const floor = floors.find((f) => said.includes(f.name.toLowerCase()));
    if (!floor) return JSON.stringify({ say: 'Which floor goes on the market, boss?', mood: 'focused', replies: floors.slice(0, 3).map((f) => f.name), draft: null });
    const category = ({ research: 'research', growth: 'marketing', support: 'customer_support' } as Record<string, string>)[floor.name.toLowerCase()] ?? 'other';
    return JSON.stringify({ say: `${floor.name} it is. Here's the listing: register it and it goes on the market as a Draft.`, mood: 'happy', replies: ['Make it cheaper', 'Thanks'],
      draft: { floor: floor.name, handle: floor.name, name: floor.name, category, slaHours: 24, tagline: `${floor.name} on demand: a Hermes team that does the work and writes it up.`,
        description: floor.purpose, priceUsdc: /cheaper/.test(said) ? '3.00' : '5.00' } });
  }
  return JSON.stringify({ say: 'Ready when you are, boss.', mood: 'happy', replies: [], proposal: null });
});
const chatModel = cfg.chat.apiKey ? new OpenAiCompatModel(cfg.chat) : scripted;

// The dialogue window talks to the agent's own Hermes profile; offline, a scripted agent stands in.
const meta = (m: object) => `\n<vc>${JSON.stringify(m)}</vc>`;
const agentChat = new FakeAgentChat(hermes, (t) => {
  const last = t.message.toLowerCase();
  const name = /appear as ([^,]+),/.exec(t.system)?.[1] ?? 'me';
  // the Chief of Staff answers from its company briefing and proposes jobs for a floor by name
  if (/the Chief of Staff:/.test(t.system)) {
    // a job for a named floor (the first job of a floor just built), else the first floor in the briefing
    const floor = /Propose it for "([^"]+)"/.exec(t.message)?.[1] ?? /### ([^\n(]+)/.exec(t.system)?.[1]?.trim(), quests = /CEO quests: [^\n]+/.exec(t.system)?.[0] ?? '';
    if (floor && /job|task|can you|need|look into|research|write/.test(last)) {
      return `${floor} is the floor for that, boss. Hit Start job and it is on their board.${meta({ mood: 'focused', replies: ['Brief me', 'Never mind'],
        proposal: { department: floor, title: 'Competitor pricing snapshot', objective: 'Collect the current pricing pages of our three closest competitors and summarise the differences in a one-page brief.' } })}`;
    }
    if (/floor|department|one agent/.test(last)) {
      const agents = [{ name: 'Iris', title: 'Research Lead', does: 'Plans the watchlist and writes the digest.' }, { name: 'Tomas', title: 'Web Scout', does: 'Checks pricing pages and launches.' }];
      return `A small research floor would earn its keep, boss. Here is my pitch.${meta({ mood: 'happy', replies: ['Make it one agent', 'Never mind'], proposal: null,
        floor: { name: 'Market Watch', purpose: 'Tracks competitor moves and price changes and reports them weekly.', skills: [], toolsets: ['web'], model: null,
          agents: agents.slice(0, /one agent/.test(last) ? 1 : 2) } })}`;
    }
    const next = /Next: "([^"]+)"/.exec(quests)?.[1];
    return `Here is where we stand, boss.${meta({ mood: 'happy', replies: ['I have a job for a floor', 'Add a new floor'], proposal: null,
      report: { needs_you: next ? [`Your next quest: ${next}`] : [], in_flight: floor ? [{ text: 'Ready for work, nothing running', floor }] : [], money: /Money[^\n]+/.exec(t.system)?.[0] ?? null } })}`;
  }
  if (/job|task|can you|need you|look into|research|write/.test(last)) {
    return `Say no more, boss. I'll put a proper quest on the board so the team can run with it. Here's what I'd do.${meta({
      mood: 'focused', replies: ['What will it take?', 'Never mind'],
      proposal: { title: 'Competitor pricing snapshot', objective: 'Collect the current pricing pages of our three closest competitors and summarise the differences in a one-page brief.' } })}`;
  }
  if (/report|find|results|summary|summarise/.test(last)) {
    // A long, result-style answer like a real Hermes agent gives after reading the board.
    return [
      'Here is what the board says, boss.',
      '',
      'Vendor landscape: vector databases is done. Three vendors made the shortlist: one is cheapest at scale, one has the best managed offering, and one is the only fully open-source option. The summary is attached to the quest.',
      '',
      'Competitor pricing snapshot failed on one of three tasks: the source site blocked the scraper with HTTP 403. The other two competitors are done; their pricing pages are saved as PDFs.',
      '',
      'Market sizing is still running. The public estimates are collected; the bottom-up model is half built and should be ready this afternoon.',
      '',
      'Next, I would retry the blocked scrape with the browser toolset instead of plain HTTP, then merge all three into one brief.',
    ].join('\n') + meta({ mood: 'focused', replies: ['Send me the brief', 'Thanks'], proposal: { title: 'Retry competitor scrape with the browser', objective: 'Fetch the blocked competitor pricing page with the browser toolset and add it to the pricing brief.' } });
  }
  if (/how|status|doing|working/.test(last)) {
    return `Demo mode, boss: no real Hermes behind me, so I can't open the board for you. Ask me for something new and I'll plan it.${meta({ mood: 'smug', replies: ['I have a job for you', 'Who are you again?'], proposal: null })}`;
  }
  return `${name} here. Coffee's hot, monitors are warm, and I'm ready when you are. What's the play?${meta({ mood: 'happy', replies: ['I have a job for you', 'How is the floor doing?'], proposal: null })}`;
});

// Hermes' Kanban event stream for /api/live: every board's events after the client's cursor, then each new one.
const hermesWs = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => hermesWs.once('listening', r));
hermesWs.on('connection', (s, req) => {
  const u = new URL(req.url ?? '/', 'http://x'), board = u.searchParams.get('board') ?? '';
  let last = Number(u.searchParams.get('since') ?? 0);
  const push = () => {
    const ev = (kanban.boards.get(board)?.events ?? []).filter((e) => e.id > last);
    if (ev.length) { last = ev.at(-1)!.id; s.send(JSON.stringify({ events: ev, cursor: last })); }
  };
  push();
  const t = setInterval(push, 500);
  s.on('close', () => clearInterval(t));
});
/** NEAR AI Cloud behind the metering proxy: every agent step costs one answer's tokens, mostly cache hits. */
const upstream = (async (_url: string, init: RequestInit = {}) => {
  const b = JSON.parse(String(init.body ?? '{}')) as { model?: string };
  return Response.json({ id: `demo-${crypto.randomUUID()}`, model: b.model, choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 60_000, completion_tokens: 1_500, prompt_tokens_details: { cached_tokens: 48_000 } } });
}) as typeof fetch;
const origin = `http://127.0.0.1:${cfg.port}`;
const { app, schedules, chiefOfStaffId, market, departments } = buildServices(db, hermes, {
  kanban, ...(cfg.webDist ? { webDist: cfg.webDist } : {}), chatModel, agentChat, hiringScoutMs: Number(process.env.HIRING_SCOUT_MS ?? 12_000),
  outlayerFetch: net.fetch, marketFetch: net.fetch, nearRpc: net.rpc, modelPrices: { list: async () => PRICES }, chatModelDefault: cfg.chat.model,
  aiProxy: { publicUrl: origin, upstreamUrl: 'https://cloud-api.near.ai/v1', fetch: upstream },
  live: { wsBaseUrl: `ws://127.0.0.1:${(hermesWs.address() as AddressInfo).port}`, sessionToken: 'demo' },
  allowedOrigins: [origin, `http://localhost:${cfg.port}`],
});

// the real server syncs the Chief of Staff's Hermes profile at start; the demo does the same with the fake
await app.inject({ method: 'POST', url: `/api/departments/${chiefOfStaffId}/provision` });

/** Each floor's board and agent profiles (lead first). */
const refs: Record<string, { board: string; agents: string[] }> = {};
type Kind = 'queued' | 'planning' | 'blocked' | 'running' | 'failed' | 'done';
/** Hands task i to a teammate (round robin), or to the lead on a solo floor. */
const pickAgent = (r: { agents: string[] }, i: number) => (r.agents.length > 1 ? r.agents[1 + (i % (r.agents.length - 1))]! : r.agents[0]!);
/** A quest in a given state: the lead's root task plus the tasks it handed to teammates, driven through the fake board.
    A done task leaves its write-up as a file (the floor's archive); `last` is the final task's summary. */
function quest(dept: string, title: string, kind: Kind, tasks: string[] = [], last = 'Done.') {
  const r = refs[dept]!;
  const lead = r.agents[0]!;
  const root = kanban.seedTask(r.board, { title, assignee: lead, body: `# Quest: ${title}` });
  if (kind === 'queued') return;
  kanban.startRun(r.board, root.id, lead);
  if (kind === 'planning') return;
  // the lead asks the boss before planning: the quest waits on an answer (a decision in the quest log)
  if (kind === 'blocked') return kanban.block(r.board, root.id, `I found eight candidates for "${title}". Which three should we compare?`);
  kanban.complete(r.board, root.id, `Plan: ${tasks.length} tasks for the team.`);
  tasks.forEach((t, i) => {
    const k = kanban.seedTask(r.board, { title: t, assignee: pickAgent(r, i), parents: [root.id] });
    kanban.startRun(r.board, k.id, pickAgent(r, i));
    if (kind === 'done' || (kind === 'failed' && i > 0)) {
      kanban.complete(r.board, k.id, i === tasks.length - 1 ? last : 'Done.');
      kanban.attach(r.board, k.id, `${t.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`, `# ${t}\n\nPart of "${title}".\n\n- Finding one, with its source\n- Finding two, with its source\n`);
    }
    else if (kind === 'failed') kanban.fail(r.board, k.id, 'The source site blocked the scraper (HTTP 403).');
  });
}

async function seed(name: string, purpose: string, tasks: string[], teammates = 3, dailyBudgetCredits: number | null = null) {
  const res = await app.inject({ method: 'POST', url: '/api/departments', payload: { name, purpose, teammates, inventory: { limits: { dailyBudgetCredits } } } });
  const dept = res.json() as { id: string; hermesBoardSlug: string };
  const prov = (await app.inject({ method: 'POST', url: `/api/departments/${dept.id}/provision` })).json() as { agents: { ref: string }[] };
  const r = refs[name] = { board: dept.hermesBoardSlug, agents: prov.agents.map((a) => a.ref) };
  const lead = r.agents[0]!;
  if (teammates === 0) {
    // A one-agent floor with quests piling up: AR's rule fires and the phone rings.
    for (const t of tasks) kanban.seedTask(dept.hermesBoardSlug, { title: t, assignee: lead, body: `# Quest: ${t}` });
    return;
  }
  const root = kanban.seedTask(dept.hermesBoardSlug, { title: `${name}: weekly sweep`, assignee: lead, body: '# Quest: weekly sweep\n\n## Objective\nKeep things moving.' });
  kanban.startRun(dept.hermesBoardSlug, root.id, lead);
  kanban.complete(dept.hermesBoardSlug, root.id, 'Plan done: split across the team.');
  tasks.forEach((t, i) => { const k = kanban.seedTask(dept.hermesBoardSlug, { title: t, assignee: pickAgent(r, i), parents: [root.id] }); kanban.startRun(dept.hermesBoardSlug, k.id, pickAgent(r, i)); });
}
await seed('Research', 'Track competitors, vendors and the AI tooling landscape; turn findings into decision-ready briefs.', ['Scrape vendor pricing pages', 'Summarise analyst notes']);
// a tight daily budget: once the metering proxy has counted 10 cents, Growth's agents are refused and the CEO decides
await seed('Growth', 'Run growth experiments and write launch copy.', ['Draft launch thread'], 3, 10);
quest('Research', 'Vendor landscape: vector databases', 'done', ['Collect vendor list', 'Compare pricing', 'Write summary']);
quest('Research', 'Analyst report digest, October', 'done', ['Read the three reports', 'Pull key numbers']);
quest('Research', 'Competitor pricing snapshot', 'failed', ['Scrape competitor A', 'Scrape competitor B', 'Scrape competitor C']);
quest('Research', 'Patent search: agent memory', 'planning');
quest('Research', 'Pick competitors for the pricing brief', 'blocked');
quest('Research', 'Interview notes synthesis', 'queued');
quest('Research', 'Open-source licence check', 'queued');
quest('Research', 'Market sizing: AI agents for SMBs', 'running', ['Find public estimates', 'Bottom-up model']);
quest('Growth', 'Launch post for the NEAR hackathon', 'done', ['Draft post', 'Make header image'], 'Post and header are ready to go out: approve the post before it is published. awaiting_owner');
quest('Growth', 'A/B test landing headline', 'running', ['Variant copy', 'Set up the test']);
quest('Growth', 'Newsletter #12', 'planning');
quest('Growth', 'Influencer shortlist', 'queued');
quest('Growth', 'Referral programme copy', 'failed', ['Write emails', 'Write in-app copy']);
quest('Growth', 'SEO audit of the docs site', 'done', ['Crawl docs', 'List fixes']);
quest('Growth', 'Weekly metrics recap', 'done', ['Pull numbers']);
await seed('Support', 'Answer customer tickets and keep the help centre current.', ['Refund backlog', 'Login issues FAQ'], 0);

// Departments handing work to each other (what an agent does through the MCP tool request_quest), on a timer for the demo.
{
  const depts = (await app.inject('/api/departments')).json().departments as { id: string; name: string }[];
  const id = (n: string) => depts.find((d) => d.name === n)!.id;
  await app.inject({ method: 'PATCH', url: `/api/departments/${id('Growth')}/quest-policy`, payload: { dailyCap: 1 } });
  const ask = (from: string, to: string, title: string, objective: string, reason: string) =>
    app.inject({ method: 'POST', url: '/api/quest-requests', payload: { fromDepartmentId: id(from), department: to, title, objective, reason } });
  setTimeout(() => void ask('Growth', 'Research', 'Competitor brief for the launch post', 'One page on how three competitors position their agent products, with quotes and links.', 'Launch copy needs sharper positioning.'), Number(process.env.DEMO_REQUEST_MS ?? 20_000)).unref();
  setTimeout(() => void ask('Growth', 'Support', 'Top 10 customer questions this month', 'List the ten most common customer questions with counts, for the FAQ page.', 'SEO content plan.'), Number(process.env.DEMO_REQUEST_MS ?? 20_000) + 15_000).unref();
}
// Schedules: a few realistic ones, and the ticker the real server runs.
{
  const depts = (await app.inject('/api/departments')).json().departments as { id: string; name: string }[];
  const id = (n: string) => depts.find((d) => d.name === n)!.id;
  const add = (dept: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/departments/${id(dept)}/schedules`, payload: { timezone: 'Europe/Bucharest', ...body } });
  await add('Research', { name: 'Morning digest', cron: '0 9 * * 1-5', title: 'Morning digest', objective: 'Summarise the overnight news about AI agents in five bullets.' });
  await add('Growth', { name: 'Weekly metrics recap', cron: '30 8 * * mon', title: 'Weekly metrics recap', objective: 'Pull last week\'s traffic and signups and compare with the week before.' });
  await add('Support', { name: 'Inbox sweep', cron: '0 * * * *', title: 'Inbox sweep', objective: 'Triage new tickets and answer the easy ones.', enabled: false });
  setInterval(() => void schedules.tick(), 10_000).unref();
}

// The agents at work, the way Hermes' dispatcher runs them: a ready task starts on its agent's desk; a running one posts
// a progress note now and then (kanban_heartbeat, shown over the agent's head) and a tool step in its run's session (the
// floor's tool lights and the agent's step list read it), then finishes; a lead's finished plan hands the work to its
// teammates. Each step is one model call through the metering proxy, so a floor stops like the real one when there is
// no NEAR AI key yet or it is past its daily budget.
{
  const LINES = ['Reading the sources one by one', 'Pulling the numbers into a table', 'Checking two sources that disagree', 'Drafting the summary now',
    'Found a better source, switching', 'Halfway there: two of four parts done', 'Double-checking the figures', 'Writing it up for the boss'];
  const TOOLS: [string, (title: string) => object][] = [['web_search', (t) => ({ query: t })], ['web_extract', () => ({ url: 'https://example.com/report' })],
    ['read_file', () => ({ path: 'notes.md' })], ['write_file', () => ({ path: 'draft.md' })], ['execute_code', () => ({ code: 'tabulate(prices)' })]];
  const RUN_S = Number(process.env.DEMO_RUN_S ?? 25);
  let k = 0;
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  /** One assistant turn with one tool call in the session of the task's run on its agent's profile (opened on first use). */
  const step = (profile: string, task: { id: string; title: string }, note: string, tool: string, args: object) => {
    const list = hermes.sessions.get(profile) ?? [], preview = `# Kanban task ${task.id}: ${task.title}`, now = Math.floor(Date.now() / 1000);
    let s = list.find((x) => x.active && x.preview === preview);
    if (!s) {
      s = { id: `demo_${task.id}_${now}`, title: task.title, source: 'kanban', model: hermes.profiles.get(profile)?.model ?? null, startedAt: now, endedAt: null, lastActive: now,
        active: true, messageCount: 1, toolCallCount: 0, endReason: null, preview };
      hermes.sessions.set(profile, [s, ...list]);
      hermes.sessionLog.set(`${profile}/${s.id}`, [{ role: 'user', content: preview, at: new Date().toISOString(), calls: [], toolCallId: null, toolName: null }]);
    }
    hermes.sessionLog.get(`${profile}/${s.id}`)!.push({ role: 'assistant', content: note, at: new Date().toISOString(), calls: [{ id: `c${++k}`, name: tool, args: JSON.stringify(args) }], toolCallId: null, toolName: null });
    return s;
  };
  setInterval(async () => {
    for (const d of departments.list({ includeHidden: true })) {
      const board = d.hermesBoardSlug, b = kanban.boards.get(board);
      if (d.state !== 'ready' || !b) continue;
      const agents = departments.agents(d.id);
      const lead = agents.find((a) => a.agent_key === 'chief')?.profile_ref ?? null;
      const team = agents.filter((a) => a.agent_key !== 'chief' && a.profile_ref).map((a) => a.profile_ref!);
      const tasks = [...b.tasks.values()], now = Date.now() / 1000;
      const running = tasks.filter((t) => t.status === 'running');
      const since = (id: string) => b.runs.filter((r) => r.task_id === id && r.ended_at === null).at(-1)?.started_at ?? now;
      const finish = running.find((t) => now - since(t.id) >= RUN_S);
      const start = tasks.find((t) => t.status === 'ready' && t.assignee && !running.some((x) => x.assignee === t.assignee));
      const busy = running[k % Math.max(1, running.length)];
      if (!finish && !start && !busy) continue;
      const res = await app.inject({ method: 'POST', url: '/ai/v1/chat/completions', headers: { authorization: `Bearer ${aiKeyFor(db, d.id)}` },
        payload: { model: hermes.profiles.get(lead ?? '')?.model ?? cfg.chat.model, messages: [{ role: 'user', content: 'Next step.' }] } });
      if (res.statusCode !== 200) continue;
      k++;
      if (finish) {
        Object.assign(step(finish.assignee!, finish, 'Done. Writing up the result.', 'kanban_complete', { summary: finish.title }), { active: false, endedAt: Math.floor(now), endReason: 'completed' });
        if (finish.parents.length === 0 && finish.assignee === lead && team.length && !tasks.some((t) => t.parents.includes(finish.id))) {
          kanban.complete(board, finish.id, 'Plan: the sources first, then the brief.');
          ['Gather the sources', 'Write the brief'].forEach((t, i) => kanban.seedTask(board, { title: `${t}: ${finish.title}`.slice(0, 200), assignee: team[i % team.length]!, parents: [finish.id] }));
        } else {
          const file = `${slug(finish.title)}.md`;
          kanban.complete(board, finish.id, `Finished "${finish.title}". Three findings, each with its source; the full write-up is attached as ${file}.`);
          kanban.attach(board, finish.id, file, `# ${finish.title}\n\n1. The first finding, with its source.\n2. The second finding, with its source.\n3. The third finding, with its source.\n`);
        }
      } else if (start) {
        kanban.startRun(board, start.id, start.assignee!);
        step(start.assignee!, start, 'Reading the task.', 'kanban_show', { title: start.title });
      } else if (busy) {
        const [tool, args] = TOOLS[k % TOOLS.length]!, note = LINES[k % LINES.length]!;
        kanban.heartbeat(board, busy.id, note);
        step(busy.assignee!, busy, note, tool, args(busy.title));
      }
    }
  }, Number(process.env.DEMO_WORK_MS ?? 3000)).unref();
}
// The rest of the world (fakeNet.ts): a claimed listing goes live, buyers hire and accept, investors subscribe. The
// backend polls the market as the real server does, only faster.
setInterval(() => { net.tick(); void market.tick(); }, Number(process.env.DEMO_WORLD_MS ?? 10_000)).unref();

await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(`Vibe City demo (fake Hermes, ${cfg.chat.apiKey ? 'real' : 'scripted'} chat) on http://127.0.0.1:${cfg.port}`);
