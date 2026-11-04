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
  const name = /You are ([^,]+),/.exec(turns[0]!.content)?.[1] ?? 'me';
  if (/job|task|can you|need you|look into|research|write/.test(last)) {
    return JSON.stringify({
      say: `Say no more, boss. I'll put a proper quest on the board so the team can run with it. Here's what I'd do.`,
      mood: 'focused', replies: ['Ship it', 'Make it smaller', 'Never mind'],
      proposal: { kind: 'quest', title: 'Competitor pricing snapshot', objective: 'Collect the current pricing pages of our three closest competitors and summarise the differences in a one-page brief.' },
    });
  }
  if (/how|status|doing|working/.test(last)) {
    return JSON.stringify({ say: `Board's in front of you, boss. I only know what's on it: nothing invented, nothing hidden. Ask me for something new and I'll plan it.`, mood: 'smug', replies: ['I have a job for you', 'Who are you again?'], proposal: null });
  }
  return JSON.stringify({ say: `${name} here. Coffee's hot, monitors are warm, and I'm ready when you are. What's the play?`, mood: 'happy', replies: ['I have a job for you', 'How is the floor doing?'], proposal: null });
});
const chatModel = cfg.chat.apiKey ? new OpenAiCompatModel(cfg.chat) : scripted;

const { app, schedules } = buildServices(db, hermes, { kanban, ...(cfg.webDist ? { webDist: cfg.webDist } : {}), chatModel, hiringScoutMs: Number(process.env.HIRING_SCOUT_MS ?? 12_000) });

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
const boards = new Set(Object.values(refs).map((r) => r.board));
// Real Hermes creates a board when a department is provisioned; the fake needs a nudge for floors added in the demo.
setInterval(async () => {
  const list = (await app.inject('/api/departments')).json() as { departments: { hermesBoardSlug: string; state: string }[] };
  for (const d of list.departments) if (d.state === 'ready' && !boards.has(d.hermesBoardSlug)) { boards.add(d.hermesBoardSlug); kanban.addBoard(d.hermesBoardSlug); }
}, 1500).unref();

await app.listen({ host: '127.0.0.1', port: cfg.port });
console.log(`Vibe City demo (fake Hermes, ${cfg.chat.apiKey ? 'real' : 'scripted'} chat) on http://127.0.0.1:${cfg.port}`);
