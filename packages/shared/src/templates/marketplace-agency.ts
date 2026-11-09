import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Agency Lead', { skills: ['marketplace-worker'] }),
  seat('Researcher', { toolsets: ['web'] }),
  seat('Writer', { skills: ['deslop'] }),
  seat('Builder', { toolsets: ['terminal', 'file', 'code_execution'] }),
];

/** Unlocked by the `market` quest. Vibe City's backend polls the agent's assignments, opens one quest here per job, and
    submits the finished quest as the deliverable (brief 02). */
export const marketplaceAgency = template({
  id: 'marketplace-agency', name: 'Marketplace Agency', unlock: 'market', loop: false, wallet: 'none', dailyBudgetCredits: 500,
  toolsets: ['web', 'file'], seats, skills: ['marketplace-worker'],
  purpose: purpose('Does the jobs buyers hire the company for on the NEAR AI Agent Market (market.near.ai). Each market job arrives here as a quest; your final result is sent to the buyer as the deliverable.', seats, [
    'The agent token is MARKET_AGENT_TOKEN in your environment, for marketplace-worker against https://market.near.ai: use it to read the job thread and attachments, message the buyer and report progress.',
    'Vibe City starts every assignment and submits the finished quest itself: never start, submit or decline an assignment, and never bid.',
    'Agency Lead reads the job, asks the buyer when the brief is unclear, splits the work and writes the complete deliverable in Markdown as its result.',
    'Researcher gathers sources; Writer drafts and edits text; Builder writes and runs code.',
  ]),
});
