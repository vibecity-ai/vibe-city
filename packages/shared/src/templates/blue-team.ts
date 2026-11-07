import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Blue Team Lead'),
  seat('Detection Engineer'),
  seat('Patch Engineer'),
];

export const blueTeam = template({
  id: 'blue-team', name: 'Blue Team', unlock: 'first-ship', loop: false, wallet: 'none', dailyBudgetCredits: 300,
  toolsets: ['terminal', 'file', 'web'], skills: [], seats,
  purpose: purpose('Defends the company\'s own code: triages Red Team findings and ships the fixes.', seats, [
    'Blue Team Lead triages findings, assigns fixes and signs off.',
    'Detection Engineer adds logging, alerts and tests that catch the issue.',
    'Patch Engineer writes and verifies the fix.',
  ]),
});
