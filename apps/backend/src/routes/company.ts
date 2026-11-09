/* Company settings (brief 00 stub; the NEAR AI key and the Chief of Staff's model come from the first quest; the market
   token is written by routes/market.ts).
   One row in company_settings. Secrets live under `secrets` and never leave this module. */
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { CompanySettingsPatchSchema, CompanySettingsSchema, type CompanySettings } from '@vibe-city/shared';
import { InvalidInputError } from '../domain/errors.ts';
import { ModelFailedError } from '../model/chatModel.ts';
import { gameState } from './game.ts';
import type { AppServices } from '../app.ts';

type Stored = Partial<Omit<CompanySettings, 'nearAiApiKeySet' | 'githubConnected'>> & { secrets?: Record<string, unknown> };

function stored(db: DatabaseSync): Stored {
  const r = db.prepare('SELECT settings_json FROM company_settings WHERE id = 1').get() as { settings_json: string } | undefined;
  return r ? (JSON.parse(r.settings_json) as Stored) : {};
}

/** The settings view: never contains a secret, only whether one is set. */
export function readSettings(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): CompanySettings {
  const s = stored(db), secrets = s.secrets ?? {};
  return CompanySettingsSchema.parse({
    nearAiApiKeySet: !!(secrets.nearAiApiKey || env.NEAR_AI_API_KEY),
    nearAiCreditsLoadedCents: s.nearAiCreditsLoadedCents ?? null,
    outlayerWalletId: s.outlayerWalletId ?? null,
    outlayerAccountId: s.outlayerAccountId ?? null,
    marketAgentHandle: s.marketAgentHandle ?? null,
    marketVerifiedAt: s.marketVerifiedAt ?? null,
    // the Software Department's token: stored through settings (brief 04), or GITHUB_TOKEN in the backend env (brief 01)
    githubConnected: !!(secrets.githubToken || env.GITHUB_TOKEN),
    githubLogin: s.githubLogin ?? null,
    hyperliquidConnectedAt: s.hyperliquidConnectedAt ?? null,
    polymarketConnectedAt: s.polymarketConnectedAt ?? null,
    chiefOfStaffModel: s.chiefOfStaffModel ?? null,
  });
}

/** Merge plain (non-secret) fields into the stored settings. */
export function writeSettings(db: DatabaseSync, patch: Partial<Stored>): void {
  const next = { ...stored(db), ...patch };
  db.prepare('INSERT INTO company_settings (id, settings_json) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET settings_json = excluded.settings_json')
    .run(JSON.stringify(next));
}

/** A write-only secret (GitHub token, OutLayer wallet key). Server-side only: never in a response. */
export function secret(db: DatabaseSync, name: string): string | null {
  const v = stored(db).secrets?.[name];
  return typeof v === 'string' && v ? v : null;
}
export function setSecrets(db: DatabaseSync, patch: Record<string, string>): void {
  writeSettings(db, { secrets: { ...stored(db).secrets, ...patch } });
}

/** The NEAR AI Cloud key: the one pasted in the first quest, else the backend env's (fallback). Server-side only. */
export function nearAiKey(db: DatabaseSync, fallback: string | null | undefined = process.env.NEAR_AI_API_KEY): string | null {
  return secret(db, 'nearAiApiKey') ?? (fallback || null);
}

/** The token the Software Department's agents use as GH_TOKEN: the one pasted in the UI, else GITHUB_TOKEN from the env. */
export function githubToken(db: DatabaseSync, env: NodeJS.ProcessEnv = process.env): string | null {
  return secret(db, 'githubToken') ?? (env.GITHUB_TOKEN || null);
}

export function register(app: FastifyInstance, deps: AppServices) {
  app.get('/api/company/settings', async () => readSettings(deps.db));
  // Write-only secrets and the Chief of Staff's model. The first quest sends the NEAR AI key and the model together:
  // both are tried with one tiny NEAR AI call before anything is saved, so a typo never locks the company out.
  app.patch('/api/company/settings', async (req) => {
    const patch = CompanySettingsPatchSchema.parse(req.body);
    const other = Object.keys(patch).filter((k) => !['githubToken', 'nearAiApiKey', 'chiefOfStaffModel'].includes(k));
    if (other.length) throw new InvalidInputError(`not settable yet: ${other.join(', ')}`);
    if (patch.githubToken) {
      // a token is one line without spaces; it ends up as GH_TOKEN in the agents' .env
      if (/\s/.test(patch.githubToken)) throw new InvalidInputError('That does not look like a GitHub token.');
      setSecrets(deps.db, { githubToken: patch.githubToken });
    }
    if (patch.nearAiApiKey !== undefined || patch.chiefOfStaffModel !== undefined) {
      if (patch.nearAiApiKey && /\s/.test(patch.nearAiApiKey)) throw new InvalidInputError('That does not look like a NEAR AI API key.');
      const key = patch.nearAiApiKey ?? nearAiKey(deps.db);
      if (!key) throw new InvalidInputError('Add your NEAR AI API key first.');
      const model = patch.chiefOfStaffModel ?? readSettings(deps.db).chiefOfStaffModel ?? deps.chatModelDefault;
      if (patch.chiefOfStaffModel && deps.modelPrices) {
        const offered = await deps.modelPrices.list().catch(() => null);
        if (offered?.size && !offered.has(patch.chiefOfStaffModel)) throw new InvalidInputError(`NEAR AI Cloud does not offer ${patch.chiefOfStaffModel}.`);
      }
      try { await deps.chatModel.check?.(key, model); } catch (e) {
        if (e instanceof ModelFailedError) throw new InvalidInputError(e.message);
        throw e;
      }
      if (patch.nearAiApiKey) setSecrets(deps.db, { nearAiApiKey: patch.nearAiApiKey });
      if (patch.chiefOfStaffModel) writeSettings(deps.db, { chiefOfStaffModel: patch.chiefOfStaffModel });
    }
    // agents get the new key and token in their profile .env; the quests read settings through the 5 s game cache
    if (patch.githubToken || patch.nearAiApiKey) await deps.pushDepartmentEnv();
    await gameState(deps, true);
    return readSettings(deps.db);
  });
}
