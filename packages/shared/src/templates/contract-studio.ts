import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Lead Architect', { skills: ['github'] }),
  seat('Contract Engineer', { skills: ['near-smart-contracts', 'near-cli-rs'] }),
  seat('dApp Engineer', { skills: ['near-dapp', 'near-kit'] }),
  seat('Test Engineer', { skills: ['property-based-testing'] }),
];

/** Builds on NEAR: the floor most hackathon tracks start from (a contract plus the app in front of it). */
export const contractStudio = template({
  id: 'contract-studio', name: 'Contract Studio', unlock: null, loop: false, wallet: 'none', dailyBudgetCredits: 500,
  toolsets: ['terminal', 'file', 'code_execution', 'web'], skills: [], seats,
  purpose: purpose('Builds, tests and deploys NEAR smart contracts in Rust and the web app in front of them, on testnet unless the CEO says otherwise.', seats, [
    'Lead Architect turns each objective into a contract, a frontend and tests, hands them out, and reviews the result before reporting.',
    'Contract Engineer writes the contract with near-smart-contracts and builds and deploys it to a testnet account it creates with near-cli-rs.',
    'dApp Engineer builds the frontend with near-dapp and near-kit: wallet sign-in, view calls and change calls against the deployed contract.',
    'Test Engineer writes unit and property-based tests for the contract and reports what fails.',
    'This floor holds no company wallet key: it never deploys to mainnet or spends real funds.',
  ]),
});
