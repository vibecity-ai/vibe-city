/* Offline demo: the real backend and web app, with in-memory fakes for Hermes, Kanban and the chat model.
   For UI work without Docker or API keys. Nothing here talks to a real service.

     npm run build -w @vibe-city/web
     WEB_DIST=../web/dist PORT=4199 npm run demo -w @vibe-city/backend   (then open http://127.0.0.1:4199)

   Set NEAR_AI_API_KEY to chat with the real model instead of the scripted one. */
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
  // The executive assistant drafting a new floor.
  if (sys.includes('Executive assistant')) {
    const kinds: Record<string, [string, string, string[]]> = {
      research: ['Research Lab', 'Digs into papers and markets and writes short, sourced briefs.', ['arxiv', 'pdf']],
      sales: ['Sales', 'Finds leads, drafts outreach and keeps the pipeline tidy.', ['github']],
      support: ['Customer Care', 'Answers tickets and keeps the help centre current.', ['pdf']],
      finance: ['Finance', 'Tracks spend and credits, reconciles invoices and flags anything odd.', ['pdf', 'spreadsheet-pro']],
      legal: ['Legal', 'Reviews contracts and terms and flags risky clauses.', ['pdf']],
      trading: ['Trading Desk', 'Paper-trades on market data and reports the P&L daily.', ['arxiv']],
    };
    const key = Object.keys(kinds).find((k) => last.includes(k));
    if (!key) return JSON.stringify({ say: 'Love it. One question: is this floor about research, sales, support, finance, legal or trading?', mood: 'focused', replies: ['Finance', 'Research'], draft: null });
    const [name, purpose, skills] = kinds[key]!;
    return JSON.stringify({ say: `${name} it is. Small team to start: a lead and two teammates. Here's the blueprint.`, mood: 'happy', replies: ['Make it cheaper', 'Add web search'],
      draft: { name, purpose, skills, toolsets: ['web', 'file'], model: 'near-ai/model-a', teammates: 2 } });
  }
  // The AR intake call.
  if (sys.includes('Head of Agent Resources')) {
    const said = turns.filter((t) => t.role === 'user').map((t) => t.content.toLowerCase()).join(' ');
    if (/not now/.test(last)) return JSON.stringify({ say: "Your call, boss. I'll keep the file open. Ring me when the floor starts smoking.", mood: 'annoyed', replies: ['Fine, find someone'], brief: null });
    if (!/\d/.test(said)) return JSON.stringify({ say: "Good. Support needs someone who can work tickets and keep the queue moving. What's the daily budget?", mood: 'focused', replies: ['200 credits a day', '500 a day, get someone good'], brief: null });
    const budget = Number(/(\d+)/.exec(said)![1]);
    return JSON.stringify({ say: `Got it. Ticket handler for Support, ${budget} credits a day. Here's the brief. Say the word and I'm out the door.`, mood: 'happy', replies: ['Change the budget'],
      brief: { department: 'Support', focus: 'Works support tickets and keeps the queue moving', skills: ['github', 'pdf'], budgetPerDay: budget, notes: '' } });
  }
  return JSON.stringify({ say: 'Ready when you are, boss.', mood: 'happy', replies: [], proposal: null });
});
const chatModel = cfg.chat.apiKey ? new OpenAiCompatModel(cfg.chat) : scripted;

// The dialogue window talks to the agent's own Hermes profile; offline, a scripted agent stands in.
const meta = (m: object) => `\n<vc>${JSON.stringify(m)}</vc>`;
const agentChat = new FakeAgentChat(hermes, (t) => {
  const last = t.message.toLowerCase();
  const name = /appear as ([^,]+),/.exec(t.system)?.[1] ?? 'me';
  if (/job|task|can you|need you|look into|research|write/.test(last)) {
    return `Say no more, boss. I'll put a proper quest on the board so the team can run with it. Here's what I'd do.${meta({
      mood: 'focused', replies: ['Ship it', 'Make it smaller', 'Never mind'],
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
    ].join('\n') + meta({ mood: 'focused', replies: ['Retry the scrape', 'Send me the brief', 'Thanks'], proposal: { title: 'Retry competitor scrape with the browser', objective: 'Fetch the blocked competitor pricing page with the browser toolset and add it to the pricing brief.' } });
  }
  if (/how|status|doing|working/.test(last)) {
    return `Demo mode, boss: no real Hermes behind me, so I can't open the board for you. Ask me for something new and I'll plan it.${meta({ mood: 'smug', replies: ['I have a job for you', 'Who are you again?'], proposal: null })}`;
  }
  return `${name} here. Coffee's hot, monitors are warm, and I'm ready when you are. What's the play?${meta({ mood: 'happy', replies: ['I have a job for you', 'How is the floor doing?'], proposal: null })}`;
});

// The safe, offline: a pretend chain with one founder wallet and a Sputnik DAO (nothing here touches real NEAR).
const Y = 10n ** 24n;
const demoChain = {
  async balance(id: string) { const b: Record<string, bigint> = { 'vibeboss.near': 42n * Y + 7n * Y / 10n, 'vibecity.sputnik-dao.near': 1250n * Y }; if (!(id in b)) throw new Error('This account does not exist on this network.'); return b[id]!.toString(); },
  async view(contract: string, method: string) {
    if (contract !== 'vibecity.sputnik-dao.near') throw new Error('This account has no contract (is it a Sputnik DAO?).');
    if (method === 'get_policy') return { proposal_bond: (Y / 10n).toString(), roles: [{ name: 'council', kind: { Group: ['vibeboss.near', 'cofounder.near', 'advisor.near'] } }] };
    if (method === 'get_last_proposal_id') return 3;
    return [
      { id: 0, proposer: 'vibeboss.near', description: 'Seed the treasury runway', kind: 'Vote', status: 'Approved', vote_counts: { council: [3, 0, 0] }, submission_time: '1793500000000000000' },
      { id: 1, proposer: 'cofounder.near', description: 'Pay for the pixel-art commission', kind: { Transfer: { token_id: '', receiver_id: 'pixelartist.near', amount: (120n * Y).toString() } }, status: 'Approved', vote_counts: { council: [2, 1, 0] }, submission_time: '1793700000000000000' },
      { id: 2, proposer: 'vibeboss.near', description: 'NEAR AI Cloud credits for November', kind: { Transfer: { token_id: '', receiver_id: 'credits.vibecity.near', amount: (60n * Y).toString() } }, status: 'InProgress', vote_counts: { council: [1, 0, 0] }, submission_time: '1793950000000000000' },
    ];
  },
};
const demoCredits = { configured: true, read: async () => ({ remaining: '$87.66', spent: '$12.34', requests: 4120, tokens: 9_400_000, lastUsageAt: new Date().toISOString() }) };

const { app, schedules } = buildServices(db, hermes, { money: { credits: demoCredits, reader: () => ({ url: 'demo (offline, pretend chain)', rpc: demoChain as never }) }, kanban, ...(cfg.webDist ? { webDist: cfg.webDist } : {}), chatModel, agentChat, hiringScoutMs: Number(process.env.HIRING_SCOUT_MS ?? 12_000) });

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
  kanban.addBoard(dept.hermesBoardSlug);
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
await app.inject({ method: 'PATCH', url: '/api/money/settings', payload: { daoAccountId: 'vibecity.sputnik-dao.near', trezuUrl: 'https://trezu.app' } });
await app.inject({ method: 'POST', url: '/api/money/wallets', payload: { accountId: 'vibeboss.near' } });
const boards = new Set(Object.values(refs).map((r) => r.board));
// Real Hermes creates a board when a department is provisioned; the fake needs a nudge for floors added in the demo.
setInterval(async () => {
  const list = (await app.inject('/api/departments')).json() as { departments: { hermesBoardSlug: string; state: string }[] };
  for (const d of list.departments) if (d.state === 'ready' && !boards.has(d.hermesBoardSlug)) { boards.add(d.hermesBoardSlug); kanban.addBoard(d.hermesBoardSlug); }
}, 1500).unref();

await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(`Vibe City demo (fake Hermes, ${cfg.chat.apiKey ? 'real' : 'scripted'} chat) on http://127.0.0.1:${cfg.port}`);
