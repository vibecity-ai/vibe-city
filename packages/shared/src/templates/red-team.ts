import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Red Team Lead', { abliterated: true }),
  seat('Recon Analyst', { toolsets: ['web', 'browser'], abliterated: true }),
  seat('Hardening Engineer', { toolsets: ['terminal'], abliterated: true }),
];

export const redTeam = template({
  id: 'red-team', name: 'Red Team', unlock: 'first-ship', loop: false, wallet: 'none', dailyBudgetCredits: 300,
  toolsets: ['terminal', 'web', 'browser'], skills: [], seats,
  purpose: purpose('Finds weaknesses in the company\'s own code and infrastructure only: the repositories the Software Department ships. Anything else is out of scope. Findings go to the Blue Team, never outside the company.', seats, [
    'Red Team Lead scopes each engagement to our own assets, collects findings and writes the report.',
    'Recon Analyst maps our own surface from public information.',
    'Hardening Engineer reproduces a finding against our code so the fix can be verified.',
  ]),
});
