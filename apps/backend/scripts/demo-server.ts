/* Offline demo: the real backend and web app, with in-memory fakes for Hermes, Kanban and the chat model.
   For UI work without Docker or API keys. Nothing here talks to a real service.

     npm run build -w @vibe-city/web
     WEB_DIST=../web/dist PORT=4199 npm run demo -w @vibe-city/backend   (then open http://127.0.0.1:4199)

   Set NEAR_AI_API_KEY to chat with the real model instead of the scripted one. */
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { openDb } from '../src/db/db.ts';
import { buildServices } from '../src/app.ts';
import { FakeHermes } from '../src/testing/fakeHermes.ts';
import { FakeKanban } from '../src/testing/fakeKanban.ts';
import { FakeChatModel, OpenAiCompatModel } from '../src/model/chatModel.ts';
import { FakeAgentChat } from '../src/testing/fakeAgentChat.ts';
import { loadConfig } from '../src/config.ts';

const cfg = loadConfig();
const db = openDb(':memory:');
const hermes = new FakeHermes();
const kanban = new FakeKanban();
kanban.realClock = true;
// Real Hermes gives a floor its Kanban board when the floor is provisioned; the fake board appears at the same moment.
const createBoard = hermes.createBoard.bind(hermes);
hermes.createBoard = async (slug, name) => { await createBoard(slug, name); if (!kanban.boards.has(slug)) kanban.addBoard(slug); };

const scripted = new FakeChatModel((turns) => {
  const last = turns.at(-1)?.content.toLowerCase() ?? '';
  const sys = turns[0]!.content;
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

// Hermes' Kanban event stream (/api/plugins/kanban/events), played from the fake boards, so /api/live is live here too.
const events = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(events, 'listening');
events.on('connection', (s, req) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const board = u.searchParams.get('board') ?? '';
  let since = Number(u.searchParams.get('since') ?? 0);
  const push = () => {
    const fresh = kanban.boards.get(board)?.events.filter((e) => e.id > since) ?? [];
    if (!fresh.length) return;
    since = fresh.at(-1)!.id;
    s.send(JSON.stringify({ events: fresh, cursor: since }));
  };
  const timer = setInterval(push, 1000);
  s.on('close', () => clearInterval(timer));
  push();
});
const live = { wsBaseUrl: `ws://127.0.0.1:${(events.address() as { port: number }).port}`, sessionToken: 'demo' };
const allowedOrigins = cfg.allowedOrigins ?? [`http://127.0.0.1:${cfg.port}`, `http://localhost:${cfg.port}`];

const { app, schedules, chiefOfStaffId } = buildServices(db, hermes, { kanban, live, allowedOrigins, ...(cfg.webDist ? { webDist: cfg.webDist } : {}), chatModel, agentChat, hiringScoutMs: Number(process.env.HIRING_SCOUT_MS ?? 12_000) });

// the real server syncs the Chief of Staff's Hermes profile at start; the demo does the same with the fake
await app.inject({ method: 'POST', url: `/api/departments/${chiefOfStaffId}/provision` });

/** Each floor's board and agent profiles (lead first). */
const refs: Record<string, { board: string; agents: string[] }> = {};
type Kind = 'queued' | 'planning' | 'running' | 'failed' | 'done';
/** Hands task i to a teammate (round robin), or to the lead on a solo floor. */
const pickAgent = (r: { agents: string[] }, i: number) => (r.agents.length > 1 ? r.agents[1 + (i % (r.agents.length - 1))]! : r.agents[0]!);
/** A quest in a given state: the lead's root task plus the tasks it handed to teammates, driven through the fake board. */
function quest(dept: string, title: string, kind: Kind, tasks: string[] = []) {
  const r = refs[dept]!;
  const lead = r.agents[0]!;
  const root = kanban.seedTask(r.board, { title, assignee: lead, body: `# Quest: ${title}` });
  if (kind === 'queued') return;
  kanban.startRun(r.board, root.id, lead);
  if (kind === 'planning') return;
  kanban.complete(r.board, root.id, `Plan: ${tasks.length} tasks for the team.`);
  tasks.forEach((t, i) => {
    const k = kanban.seedTask(r.board, { title: t, assignee: pickAgent(r, i), parents: [root.id] });
    kanban.startRun(r.board, k.id, pickAgent(r, i));
    if (kind === 'done' || (kind === 'failed' && i > 0)) kanban.complete(r.board, k.id, 'Done.');
    else if (kind === 'failed') kanban.fail(r.board, k.id, 'The source site blocked the scraper (HTTP 403).');
  });
}

async function seed(name: string, purpose: string, tasks: string[], teammates = 3) {
  const res = await app.inject({ method: 'POST', url: '/api/departments', payload: { name, purpose, teammates } });
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
await seed('Growth', 'Run growth experiments and write launch copy.', ['Draft launch thread']);
quest('Research', 'Vendor landscape: vector databases', 'done', ['Collect vendor list', 'Compare pricing', 'Write summary']);
quest('Research', 'Analyst report digest, October', 'done', ['Read the three reports', 'Pull key numbers']);
quest('Research', 'Competitor pricing snapshot', 'failed', ['Scrape competitor A', 'Scrape competitor B', 'Scrape competitor C']);
quest('Research', 'Patent search: agent memory', 'planning');
quest('Research', 'Interview notes synthesis', 'queued');
quest('Research', 'Open-source licence check', 'queued');
quest('Research', 'Market sizing: AI agents for SMBs', 'running', ['Find public estimates', 'Bottom-up model']);
quest('Growth', 'Launch post for the NEAR hackathon', 'done', ['Draft post', 'Make header image']);
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

// Agents at work post a one-line progress note now and then (kanban_heartbeat): the office shows it over their heads.
{
  const LINES = ['Reading the sources one by one', 'Pulling the numbers into a table', 'Checking two sources that disagree', 'Drafting the summary now',
    'Found a better source, switching', 'Halfway there: two of four parts done', 'Double-checking the figures', 'Writing it up for the boss'];
  let k = 0;
  setInterval(async () => {
    const running = (await Promise.all([...kanban.boards.keys()].map(async (b) => (await kanban.listBoardTasks(b)).filter((t) => t.status === 'running').map((t) => ({ b, id: t.id }))))).flat();
    const pick = running[k++ % Math.max(1, running.length)];
    if (pick) kanban.heartbeat(pick.b, pick.id, LINES[k % LINES.length]);
  }, Number(process.env.DEMO_NOTE_MS ?? 7000)).unref();
}

await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(`Vibe City demo (fake Hermes, ${cfg.chat.apiKey ? 'real' : 'scripted'} chat) on http://127.0.0.1:${cfg.port}`);
