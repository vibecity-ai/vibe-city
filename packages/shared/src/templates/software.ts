import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Engineering Manager'),
  seat('Coder'),
  seat('QA & Testing'),
  seat('DevOps'),
];

export const software = template({
  id: 'software', name: 'Software Department', unlock: 'connect-github', loop: false, wallet: 'none', dailyBudgetCredits: 1000,
  toolsets: ['terminal', 'file', 'code_execution', 'web'], skills: [], seats,
  purpose: purpose('Builds and maintains the company\'s code with git and gh from the terminal (GH_TOKEN is in your environment).', seats, [
    'Engineering Manager turns a quest into issues, assigns them and merges when QA passes.',
    'Coder implements on a branch, opens the pull request with gh, and writes [pr url=<the pull request URL>] in its task result.',
    'QA & Testing runs the suite, writes missing tests and reviews the pull request.',
    'DevOps owns CI, Docker and deploy scripts.',
  ]),
});
