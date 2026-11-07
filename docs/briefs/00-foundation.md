# 00 Foundation: schemas, migrations, route modules

**Goal.** Land every shared type, table and route stub the other briefs need, so they can work in parallel without
touching `schemas.ts`, `db.ts` or `app.ts` again. No behavior; everything returns empty or `not configured`.

## Deliverables

### `packages/shared/src/schemas.ts`

Add, all `.strict()`:

- `TemplateSchema`: `{ id, name, purpose, unlock: string | null (the CEO quest id that unlocks this template;
  null = available as soon as hiring is on), loop: boolean, inventory: InventorySchema, seats:
  Array<{ title, model: ModelChoiceSchema.nullable(), skills: string[], toolsets: string[] }>, skills: string[]
  (OutLayer/NEAR skill ids), wallet: 'none' | 'company', dailyBudgetCredits: number }`; `TemplateListSchema` =
  array of `TemplateSchema.extend({ locked: boolean, unlocks: string | null })` (brief 05 fills them; the stub
  returns `locked: false, unlocks: null`).
- `DepartmentCreateSchema`: add optional `template: string`.
- `InventorySchema.limits`: add `dailyBudgetCredits: z.number().int().min(0).nullable().default(null)`
  (1 credit = 1 US cent of model usage; enforced by brief 04).
- `CompanySettingsSchema` and `CompanySettingsPatchSchema`: `{ nearAiApiKeySet: boolean (view only),
  nearAiCreditsLoadedCents: number | null, outlayerWalletId: string | null, outlayerAccountId: string | null,
  marketAgentHandle: string | null, marketVerifiedAt: string | null (brief 02 sets it when the market accepts
  the token), githubConnected: boolean (view only; true once a GitHub token is stored), githubLogin: string | null
  (the connected account's login, for display), policyConfirmedAt: string | null (set by brief 05's confirm-policy
  route) }`.
  The PATCH accepts `nearAiApiKey`, `nearAiCreditsLoadedCents`, `marketAgentHandle`, `marketAgentToken`,
  `githubToken` (write-only; stored hashed-or-encrypted, never in a response)
  (write-only; never in a response). Secrets (`nearAiApiKey`, `marketAgentToken`, the OutLayer `wk_` and
  payment key, the `aiKeys` hash map of brief 04) live in the same `settings_json` row under a `secrets` key
  that the service strips before anything is parsed with the view schema; a test asserts `GET` never contains
  `wk_`, `aat_` or the NEAR AI key.
- `WalletStateSchema`: `{ registered: boolean, accountId: string | null, handoffUrl: string | null, binding:
  { accountId: string | null, status: 'none' | 'pending' | 'active' }, balances: Array<{ token, amount, source:
  'wallet' | 'intents' | 'confidential' | 'bound' }>, shielded: boolean, error: string | null }`;
  `WalletBindSchema`: `{ accountId }` (reuse `NEAR_ACCOUNT_RE`); `WalletBindReplySchema`: `{ connectUrl }`.
- `ListingDraftSchema`: `{ name, tagline, description, priceUsdc: number, slaHours: number, deliverables:
  string[] }` (the Chief of Staff's Agent Market listing draft, brief 02).
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
- `ipo (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL)`
- `department.template_id TEXT NULL` (ALTER TABLE)

### Route modules

Create `apps/backend/src/routes/{templates,company,wallet,ai,game,ipo}.ts`, each exporting
`register(app: FastifyInstance, deps: AppServices)` and registering its routes with stub handlers that parse their
schemas and return empty views. Wire them in `app.ts` with one `register(...)` line each. Existing routes stay in
`app.ts`; do not move them.

### FakeHermes

`setProfileEnv` exists in `testing/fakeHermes.ts`; make sure it records the vars per profile (not only the call)
so briefs 03 and 04 can assert what was written.

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
