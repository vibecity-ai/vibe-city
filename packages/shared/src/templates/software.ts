import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Engineering Manager', { skills: ['security-threat-model', 'thermo-nuclear-code-quality-review', 'make-pr-easy-to-review', 'fix-merge-conflicts', 'ponytail-audit', 'ponytail-debt'] }),
  seat('Coder', { skills: ['new-branch-and-pr', 'review-and-ship', 'gh-address-comments', 'deslop', 'spike', 'simplify-code', 'node-inspect-debugger', 'vercel-react-best-practices', 'solana-dev', 'near-smart-contracts'] }),
  seat('QA & Testing', { skills: ['check-compiler-errors', 'property-based-testing', 'differential-review', 'security-best-practices', 'rest-graphql-debug', 'dogfood', 'solana-vulnerability-scanner', 'near-contract-audit', 'ponytail-review'] }),
  seat('DevOps', { skills: ['loop-on-ci', 'gh-fix-ci', 'docker-management'] }),
];

export const software = template({
  id: 'software', name: 'Software Department', unlock: 'connect-github', loop: false, wallet: 'none', dailyBudgetCredits: 1000,
  toolsets: ['terminal', 'file', 'code_execution', 'web'], seats,
  skills: ['github', 'requesting-code-review', 'test-driven-development', 'systematic-debugging', 'codebase-inspection', 'ponytail', 'verify-this'],
  purpose: purpose('Builds and maintains the company\'s code with git and gh from the terminal (GH_TOKEN is in your environment).', seats, [
    'Engineering Manager turns a quest into issues, assigns them and merges when QA passes.',
    'Coder implements on a branch, opens the pull request with gh, and writes [pr url=<the pull request URL>] in its task result.',
    'QA & Testing runs the suite, writes missing tests and reviews the pull request.',
    'DevOps owns CI, Docker and deploy scripts.',
  ]),
});
