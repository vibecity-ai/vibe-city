import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Head of Research'),
  seat('Data Analyst', { toolsets: ['web'], skills: ['defillama', 'coingecko'] }),
  seat('Regime Analyst', { skills: ['crypto-regime-analyzer'] }),
];

/** Investment theses from on-chain and market data: read only, no wallet. */
export const thesisLab = template({
  id: 'thesis-lab', name: 'Thesis Lab', unlock: null, loop: true, wallet: 'none', dailyBudgetCredits: 300,
  toolsets: ['web', 'terminal', 'code_execution'], skills: [], seats,
  purpose: purpose('Writes data-backed investment theses on NEAR and crypto markets from on-chain and market data, each number with the query or call that produced it so anyone can re-run it.', seats, [
    'Head of Research picks the question, hands out the data work, and writes the thesis: the claim, the evidence, the risks and what would prove it wrong.',
    'Data Analyst pulls TVL, fees, volumes and prices with defillama and coingecko and keeps every call it made next to the number.',
    'Regime Analyst reads the market regime with crypto-regime-analyzer and says what it means for the thesis.',
    'It reads data only: it never trades or moves funds.',
  ]),
});
