/* How a NEAR AI model looks wherever one is picked: its vendor's logo (the icon NEAR AI lists, else a monogram) and
   its privacy tag, named as on near.ai/models: "Private TEE" when NEAR AI runs it in its own attested TEE, otherwise
   "Incognito". A model NEAR AI does not list gets no tag: its privacy is unknown. All of it comes from NEAR AI's price
   list (GET /api/assistant/models), read once per page. */
import { useEffect, useState } from 'react';
import type { ChiefOfStaffModels } from '@vibe-city/shared';
import { api } from '../../api';

export type ModelInfo = ChiefOfStaffModels['models'][number];

export const PRIVACY = {
  private: { label: 'Private TEE', cls: 'private', note: 'Private TEE: runs sealed in NEAR AI’s own TEE (attested Intel TDX and NVIDIA confidential GPUs), so prompts stay hidden even from NEAR AI.' },
  confidential: { label: 'Incognito', cls: 'incognito', note: 'Incognito: runs in an attested TEE at a NEAR AI partner, verified by NEAR AI, so prompts stay hidden from the host.' },
  routed: { label: 'Incognito', cls: 'incognito', note: 'Incognito: NEAR AI relays it to the model’s vendor with identifying data stripped. Not sealed in a TEE: the vendor can read the prompts.' },
} as const;

/** The privacy of a model NEAR AI lists. */
export const privacyOf = (info: ModelInfo) => PRIVACY[info.privacy ?? 'routed'];

let cache: Promise<Map<string, ModelInfo>> | null = null;
const load = () => (cache ??= api.assistantModels()
  .then((m) => new Map(m.models.map((x) => [x.id, x])))
  .catch(() => { cache = null; return new Map<string, ModelInfo>(); }));

/** NEAR AI's models by id (empty until loaded, or when the price list is down). */
export function useModelInfo(): Map<string, ModelInfo> {
  const [m, setM] = useState<Map<string, ModelInfo>>(() => new Map());
  useEffect(() => { let on = true; void load().then((x) => { if (on) setM(x); }); return () => { on = false; }; }, []);
  return m;
}

export function ModelLogo({ id, icon }: { id: string; icon?: string | null }) {
  const [broken, setBroken] = useState(false);
  return icon && !broken
    ? <img className="mlogo" src={icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <i className="mlogo" aria-hidden="true">{(id.split('/')[0] ?? id).slice(0, 1).toUpperCase()}</i>;
}

export function PrivacyTag({ info }: { info?: ModelInfo | undefined }) {
  if (!info) return null;
  const p = privacyOf(info);
  return <em className={`mpriv ${p.cls}`} title={p.note}>{p.label}</em>;
}

/** NEAR AI's list price in USD per 1M tokens. */
export const per1M = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0)}`;

/** The logo and tag a PixelSelect option shows for a model. */
export const modelOption = (id: string, info?: ModelInfo) => ({ icon: <ModelLogo id={id} icon={info?.icon} />, tag: <PrivacyTag info={info} /> });

/** A model id with its logo, privacy tag and real price, where a model is shown before it is chosen (a hire's card, a floor draft). */
export function ModelName({ id }: { id: string }) {
  const info = useModelInfo().get(id);
  return <span className="mname"><ModelLogo id={id} icon={info?.icon} /><span className="mono">{id}</span><PrivacyTag info={info} />{info && <small className="mprice">{per1M(info.inPerM)} in · {per1M(info.outPerM)} out per 1M tokens</small>}</span>;
}
