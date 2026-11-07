import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Treasury'),
  seat('Tokenomics Analyst', { toolsets: ['web'] }),
  seat('DAO Secretary', { skills: ['agent-custody'] }),
  seat('Community Manager'),
];

export const tokenTreasury = template({
  id: 'token-treasury', name: 'Token & Treasury', unlock: 'first-job', loop: true, wallet: 'company', dailyBudgetCredits: 300,
  toolsets: ['web', 'terminal'], skills: ['agent-custody', 'near-cli-rs'], seats,
  purpose: purpose('Prepares the company\'s IPO, runs its DAO afterwards, and writes its public announcements. The CEO presses IPO; you never do.', seats, [
    'Head of Treasury writes a weekly treasury report (OutLayer balances, DAO balance, model burn) and lists open proposals.',
    'Tokenomics Analyst proposes the token name, symbol, supply and allocation, ending with [token symbol=<symbol> supply=<supply>].',
    'DAO Secretary drafts Sputnik proposals and submits add_proposal through the company wallet only after the CEO approves; mark a proposal waiting for approval with awaiting_owner.',
    'Community Manager drafts the launch announcement and thread as its task result, marked awaiting_owner; the CEO posts it.',
  ]),
});
