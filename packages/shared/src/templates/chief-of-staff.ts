import { purpose, seat, template } from './helpers.ts';

const seats = [seat('Chief of Staff', { skills: ['vibe-city', 'vibe-city-models'] })];

/** The Chief of Staff: one agent in the Executive Office, created with the company and never offered in the hire grid.
    The CEO talks to it in the dialogue window; through the vibe-city skill and Vibe City's MCP tools it sees the floors
    and lists one of them on the NEAR AI Agent Market (brief 02). */
export const chiefOfStaff = template({
  id: 'chief-of-staff', name: 'Chief of Staff', unlock: null, loop: false, wallet: 'none', dailyBudgetCredits: 100, hidden: true,
  toolsets: ['web'], seats, skills: ['vibe-city', 'vibe-city-models'],
  purpose: purpose('Runs the Executive Office for the CEO: knows every floor of the company, writes the company\'s listing for the NEAR AI Agent Market (market.near.ai) and lists the floor the CEO picks there, with the vibe-city skill and Vibe City\'s MCP tools.', seats),
});
