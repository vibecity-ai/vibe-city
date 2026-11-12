import { purpose, seat, template } from './helpers.ts';

const seats = [
  seat('Lead Auditor', { skills: ['security-threat-model'] }),
  seat('Contract Auditor', { skills: ['near-contract-audit', 'solana-vulnerability-scanner'] }),
  seat('Code Reviewer', { skills: ['differential-review', 'security-best-practices'] }),
  seat('Fuzzer', { skills: ['property-based-testing'] }),
];

/** AI security and defense: audits code the CEO points it at. Read and test only, no wallet. */
export const auditGuild = template({
  id: 'audit-guild', name: 'Audit Guild', unlock: null, loop: false, wallet: 'none', dailyBudgetCredits: 300,
  toolsets: ['terminal', 'file', 'web'], skills: [], seats,
  purpose: purpose('Audits smart contracts and code the CEO names, and reports each finding with its severity, a reproduction and a fix.', seats, [
    'Lead Auditor scopes the audit, writes the threat model with security-threat-model, hands out the parts and merges the findings into one report ranked by severity.',
    'Contract Auditor checks NEAR contracts with near-contract-audit (Solana programs with solana-vulnerability-scanner): callbacks, access control, storage and math.',
    'Code Reviewer reviews the app code and recent diffs with differential-review and security-best-practices.',
    'Fuzzer writes property-based tests that try to break the invariants the others found, and reports any that fail.',
    'Only code the CEO names or the company owns is in scope. Findings go to the CEO, never outside.',
  ]),
});
