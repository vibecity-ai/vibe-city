/* Setting up the Chief of Staff: the NEAR AI Cloud key every agent thinks with, and the model the Chief of Staff (the
   assistant and AR) answers with. The first quest shows it inline; the Executive Office keeps it for changing the model
   later. The key is write-only: once saved the card only says so and offers to replace it. Saving tries the key and
   the model with one tiny NEAR AI call first (the server does), so a typo is caught here and saves nothing. */
import { useEffect, useState } from 'react';
import type { ChiefOfStaffModels, CompanySettings } from '@vibe-city/shared';
import { useStore } from '../store';
import { api, ApiError } from '../../api';
import { Icon, PixelSelect } from './kit';
import { ModelLogo, PRIVACY, PrivacyTag, modelOption } from './ModelBadge';

const KEYS_URL = 'https://cloud.near.ai';
const per1M = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`;

export function ChiefOfStaffSetup({ onDone }: { onDone?: () => void }) {
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [models, setModels] = useState<ChiefOfStaffModels | null>(null);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = () => Promise.all([api.companySettings(), api.assistantModels()]).then(([s, m]) => {
    setSettings(s); setModels(m);
    // until one is chosen, preselect the server default when NEAR AI offers it, else the cheapest
    setModel(m.chosen || m.models.some((x) => x.id === m.current) || !m.models.length ? m.current : m.models[0]!.id);
  }).catch((e) => setErr(e instanceof ApiError ? e.message : 'Could not read the settings.'));
  useEffect(() => { void load(); }, []);

  if (!settings || !models) return <p className="muted small" role="status">{err ?? 'Reading the settings…'}</p>;
  const keySet = settings.nearAiApiKeySet && !replacing;
  const ready = settings.nearAiApiKeySet && settings.chiefOfStaffModel !== null;
  const changed = !!key.trim() || model !== settings.chiefOfStaffModel;
  const pick = models.models.find((m) => m.id === model);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.setCompanySettings({ ...(key.trim() ? { nearAiApiKey: key.trim() } : {}), chiefOfStaffModel: model });
      const game = await api.game();
      useStore.setState({ game });
      useStore.getState().toast(ready ? `Your Chief of Staff now thinks with ${model}.` : 'Your Chief of Staff is ready. You can hire your first floor.');
      setKey(''); setReplacing(false);
      await load();
      onDone?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not work.');
    } finally { setBusy(false); }
  };

  return (
    <form className="cos-setup" onSubmit={(e) => { e.preventDefault(); if (!busy && changed && (keySet || key.trim())) void save(); }}>
      <div className="cos-field">
        <span className="cos-label">NEAR AI Cloud API key</span>
        {keySet ? (
          <span className="cos-keyset"><Icon n="check" size={12} />Saved on the server<button type="button" className="link" onClick={() => setReplacing(true)}>Replace</button></span>
        ) : (
          <>
            <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key"
              aria-label="NEAR AI Cloud API key" value={key} onChange={(e) => setKey(e.target.value)} />
            <span className="cos-help">
              Create one at <a href={KEYS_URL} target="_blank" rel="noreferrer">cloud.near.ai</a> under API keys, with credits on the account.
              It stays on the Vibe City server, goes to every agent you hire, and is never shown again.
            </span>
          </>
        )}
      </div>
      <div className="cos-field">
        <span className="cos-label">The model your Chief of Staff thinks with</span>
        {models.models.length ? (
          <PixelSelect aria-label="Chief of Staff model" mono value={model} onChange={setModel}
            options={models.models.map((m) => ({ value: m.id, label: m.id, note: `${per1M(m.inPerM)} in · ${per1M(m.outPerM)} out`, ...modelOption(m.id, m) }))} />
        ) : (
          <input className="input mono" aria-label="Chief of Staff model" value={model} onChange={(e) => setModel(e.target.value.trim())} />
        )}
        <span className="cos-help">
          {pick ? `${per1M(pick.inPerM)} per 1M tokens in, ${per1M(pick.outPerM)} out. A conversation uses a few thousand tokens.` : 'NEAR AI’s price list is not available right now; any model id NEAR AI offers works.'}
          {pick?.privacy && ` ${PRIVACY[pick.privacy].note}`}
          {' '}Cheaper models answer fast; bigger ones plan floors better. Your agents keep their own models.
        </span>
      </div>
      {err && <p className="cos-err" role="alert">{err}</p>}
      <div className="cos-act">
        <button className="btn primary small" type="submit" disabled={busy || !changed || !(keySet || key.trim()) || !model}>
          {busy ? 'Trying it with NEAR AI…' : ready ? 'Save' : 'Save and continue'}
        </button>
        {replacing && <button type="button" className="btn small" onClick={() => { setReplacing(false); setKey(''); }}>Keep the saved key</button>}
      </div>
    </form>
  );
}

/** Executive Office: who the Chief of Staff is running on, with the setup one click away. */
export function ChiefOfStaffCard() {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ChiefOfStaffModels | null>(null);
  const game = useStore((s) => s.game);
  useEffect(() => { api.assistantModels().then(setModels).catch(() => undefined); }, [game]);
  return (
    <section className="pane-sec" aria-labelledby="cos-h">
      <h3 className="sec-t" id="cos-h">Chief of Staff</h3>
      <div className="cos-card">
        <div className="cos-row">
          <span className="cos-now"><small>Thinks with</small><span className="mname">{models && <ModelLogo id={models.current} icon={models.models.find((m) => m.id === models.current)?.icon} />}<b className="mono">{models ? models.current : '…'}</b>{models && <PrivacyTag privacy={models.models.find((m) => m.id === models.current)?.privacy} />}</span>{models && !models.chosen && <i>default</i>}</span>
          <button className="btn small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'Close' : 'Change'}</button>
        </div>
        {open && <ChiefOfStaffSetup onDone={() => { setOpen(false); void api.assistantModels().then(setModels); }} />}
      </div>
    </section>
  );
}
