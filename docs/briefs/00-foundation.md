# 00 Foundation: schemas, migrations, route modules

**Goal.** Land every shared type, table and route stub the other briefs need, so they can work in parallel without
touching `schemas.ts`, `db.ts` or `app.ts` again. No behavior; everything returns empty or `not configured`.

## Deliverables

### `packages/shared/src/schemas.ts`

Add, all `.strict()`:

- `TemplateSchema`: `{ id, name, purpose, tier: 1|2|3, loop: boolean, inventory: InventorySchema, seats:
  Array<{ title, model: ModelChoiceSchema.nullable(), skills: string[], toolsets: string[] }>, skills: string[]
  (OutLayer/NEAR skill ids), wallet: 'none' | 'sub-key', dailyBudgetCredits: number }`; `TemplateListSchema`.
- `DepartmentCreateSchema`: add optional `template: string`.
- `InventorySchema.limits`: add `dailyBudgetCredits: z.number().int().min(0).nullable().default(null)`
  (1 credit = 1 US cent of model usage; enforced by brief 04).
- `CompanySettingsSchema` and `CompanySettingsPatchSchema`: `{ nearAiApiKeySet: boolean (view only),
  nearAiCreditsLoadedCents: number | null, outlayerWalletId: string | null, outlayerAccountId: string | null,
  marketAgentHandle: string | null }`. The PATCH accepts `nearAiApiKey`, `nearAiCreditsLoadedCents`,
  `marketAgentToken` (write-only; never in a response).
- `WalletStateSchema`: `{ registered: boolean, accountId: string | null, handoffUrl: string | null, balances:
  Array<{ token, amount, source: 'wallet' | 'intents' | 'confidential' }>, shielded: boolean, error: string | null }`.
- `AiUsageSummarySchema`: `{ byDepartment: Array<{ departmentId, todayCents, sevenDayCents, budgetCents | null,
  overBudget: boolean }>, companyTodayCents, companySevenDayAvgCents }`.
- `CeoQuestSchema`: `{ id, title, done: boolean, hint: string, unlocks: string | null }`; `DecisionSchema`:
  `{ id, kind: 'approval' | 'owner_confirm' | 'answer' | 'budget', departmentId, title, href }`;
  `RunwaySchema`: `{ creditsRemainingCents | null, dailyBurnCents, days: number | null, earnedCents, estimated: true }`;
  `GameStateSchema`: `{ quests, decisions, runway, ipoUnlocked: boolean }`.
- `IpoStateSchema`: `{ daoAccountId | null, tokenAccountId | null, txHashes: string[], state: 'locked' |
  'ready' | 'done' | 'error', error | null }`.

### `apps/backend/src/db/db.ts`

Append one migration adding:

- `company_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL)`
- `ai_usage (id INTEGER PRIMARY KEY, department_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER,
  output_tokens INTEGER, cost_nano_usd INTEGER NOT NULL, request_id TEXT, at TEXT NOT NULL)` + index on
  `(department_id, at)`
- `department_wallet (department_id TEXT PRIMARY KEY, sub_key_ref TEXT NOT NULL, created_at TEXT NOT NULL)`
- `ipo (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)`
- `department.template_id TEXT NULL` (ALTER TABLE)

### Route modules

Create `apps/backend/src/routes/{templates,company,wallet,ai,game,ipo}.ts`, each exporting
`register(app: FastifyInstance, deps: AppServices)` and registering its routes with stub handlers that parse their
schemas and return empty views. Wire them in `app.ts` with one `register(...)` line each. Existing routes stay in
`app.ts`; do not move them.

### FakeHermes

Add `setProfileEnv` to `testing/fakeHermes.ts` if missing, recording calls per profile so briefs 03 and 04 can
assert what was written.

## Files you own

`packages/shared/src/schemas.ts`, `packages/shared/src/index.ts`, `apps/backend/src/db/db.ts`,
`apps/backend/src/routes/*.ts` (new), one import block in `apps/backend/src/app.ts`, `apps/backend/src/testing/fakeHermes.ts`.

## Do not touch

Anything in `domain/`, `hermes/realRuntime.ts`, `apps/web`.

## Acceptance

- `db.test.ts`: migration applies to a fresh DB and to a DB at the previous version.
- `app.test.ts`: each new route answers 200 with an empty view that parses with its schema.
- `npm run typecheck && npm test && npm run build` green. Land this in one PR within a few hours; the other briefs
  rebase on it.
