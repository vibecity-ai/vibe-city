# 01 Templates and the hire flow

**Goal.** "Hire a department" from a list of six templates instead of filling a blank form. A template is
configuration only: inventory, purpose, teammate seats, the skills the agents may load, whether the floor gets a
wallet sub-key, and its unlock tier.

## The templates (`packages/shared/src/templates/*.ts`)

| id | name | tier | loop | seats | skills (loaded by agents, not written by us) | wallet |
|---|---|---|---|---|---|---|
| `trading-desk` | Trading Desk | 1 | yes | lead | `agent-custody`, `hyperliquid-connector` from skills.outlayer.ai | sub-key |
| `software` | Software Department | 2 | no | lead + Coder, QA & Testing, DevOps | `github-connector` | none |
| `social-media` | Social Media | 2 | yes | lead | X posting, image generation (ours, later) | none |
| `prediction-desk` | Prediction Desk | 2 | yes | lead | `agent-custody`, `polymarket-connector` | sub-key |
| `red-team` | Red Team | 3 | no | lead | security skills scoped to our own repos | none |
| `blue-team` | Blue Team | 3 | no | lead | detect and patch | none |

Each template file exports a `Template` (schema from brief 00) with: `inventory.allowedToolsets` (Trading: web,
terminal; Software: terminal, file, code_execution, web; Social: web; Prediction: web; Red: terminal, web,
browser; Blue: terminal, file, web), `inventory.model` (Red Team: `deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated`
on provider `near-ai`; others null = department default), `inventory.limits.dailyBudgetCredits` (Trading 500,
Software 1000, Social 200, Prediction 300, Red 300, Blue 300), and a `purpose` paragraph that becomes the SOUL.md
block. Seats carry a `title` that the city shows on the desk.

Skills are referenced by id only. Provisioning already installs skills by id; if a skill id is unknown to Hermes
the capability report says `unverified`, which is correct.

## Backend

- `GET /api/templates` returns the list with `locked: boolean` per template, computed by brief 05's game state;
  until that lands, everything is unlocked.
- `POST /api/departments { template }`: `departmentService.create` copies the template's inventory and purpose,
  creates the seats as `department_agent` rows with their titles, models and skills (the hiring service already
  does this for one hire; reuse its seat-creation code), stores `template_id`. Then the normal provision flow.
- A template with `loop: true` creates one disabled schedule (`ScheduleService.create`) named after the template
  with a placeholder objective; the user enables it from the department panel.

## Web

- Replace the create-department form's first step with a template grid (name, purpose, seats, tier badge,
  "locked until <quest>" when locked). Selecting one pre-fills the existing form so the user can still edit.
- Desk labels show seat titles. No other UI changes.

## Files you own

`packages/shared/src/templates/*`, `apps/backend/src/routes/templates.ts`, `apps/backend/src/domain/departmentService.ts`
(create path only), `apps/web/src/town/ui/HirePanel.tsx` (new), the create-form call sites in `Panels.tsx`.

## Do not touch

`provisioningService.ts`, `hiringService.ts` beyond extracting the seat-creation helper, `schemas.ts` (brief 00 owns it).

## Acceptance

- `templates.test.ts`: every template parses with `TemplateSchema`; creating a department from `software` yields
  four `department_agent` rows with the right titles; creating from `trading-desk` yields one disabled schedule.
- Web test in `derive.test.ts`: seat titles appear on desks.
