/* How a NEAR AI model looks wherever one is picked: its vendor's logo (the icon NEAR AI lists, else a monogram) and
   whether it runs sealed in a TEE. "Private": NEAR AI runs it in its own attested TEE. "Confidential": an attested
   partner TEE that NEAR AI verifies. Models routed to their vendor get no tag. All of it comes from NEAR AI's price
   list (GET /api/assistant/models), read once per page. */
import { useEffect, useState } from 'react';
import type { ChiefOfStaffModels } from '@vibe-city/shared';
import { api } from '../../api';

export type ModelInfo = ChiefOfStaffModels['models'][number];

export const PRIVACY = {
  private: { label: 'Private', note: 'Private: runs sealed in NEAR AI’s own TEE (attested Intel TDX and NVIDIA confidential GPUs), so prompts stay hidden even from NEAR AI.' },
  confidential: { label: 'Confidential', note: 'Confidential: runs sealed in an attested TEE at a NEAR AI partner, verified by NEAR AI, so prompts stay hidden from the host.' },
} as const;

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

export function PrivacyTag({ privacy }: { privacy?: ModelInfo['privacy'] | undefined }) {
  if (!privacy) return null;
  return <em className={`mpriv ${privacy}`} title={PRIVACY[privacy].note}>{PRIVACY[privacy].label}</em>;
}

/** The logo and tag a PixelSelect option shows for a model. */
export const modelOption = (id: string, info?: ModelInfo) => ({ icon: <ModelLogo id={id} icon={info?.icon} />, tag: <PrivacyTag privacy={info?.privacy} /> });

/** A model id with its logo and privacy tag, where a model is shown before it is chosen (a hire's card, a floor draft). */
export function ModelName({ id }: { id: string }) {
  const info = useModelInfo().get(id);
  return <span className="mname"><ModelLogo id={id} icon={info?.icon} /><span className="mono">{id}</span><PrivacyTag privacy={info?.privacy} /></span>;
}
