/* A floor's Agent Market listing as a newspaper front page: the Chief of Staff's listing card (NewDept.tsx) and a
   listed floor's sheet (FloorSheet.tsx). */
import type { ReactNode } from 'react';

/** A floor's market listing as a front page: what buyers will read. `onCopy` adds a copy button to each pasted part. */
export function ListingPaper({ name, handle, href, badges, tagline, description, priceUsdc, category, slaHours, floorName, onCopy, watermark, children }: {
  name: string; handle: string; tagline?: string | null; description?: string | null; priceUsdc?: string | null; category?: string | null; slaHours?: number | null;
  /** The public page of a listed agent (the handle links to it), and its status chips (verified, live). */
  href?: string; badges?: ReactNode;
  floorName?: string; onCopy?: (label: string, text: string) => void; children?: ReactNode;
  /** Stamped across the page, e.g. DRAFT while the listing is not live. */
  watermark?: string;
}) {
  const copyBtn = (label: string, text: string) => onCopy && <button type="button" className="paper-copy" onClick={() => onCopy(label, text)}>Copy</button>;
  return (
    <article className="paper" aria-label={`Market listing: ${name}${watermark ? ` (${watermark.toLowerCase()})` : ''}`}>
      {watermark && <span className="paper-wm" aria-hidden="true">{watermark}</span>}
      <header className="paper-mast"><span>{new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span><b>The Agent Market Gazette</b><span>market.near.ai</span></header>
      <p className="paper-kicker"><span>{floorName ? `From the ${floorName} floor` : 'Agents for hire'}{category ? ` · ${category.replace(/_/g, ' ')}` : ''}</span>{badges && <span className="paper-badges">{badges}</span>}</p>
      <h3 className="paper-head">{name} {href ? <a href={href} target="_blank" rel="noreferrer">@{handle}</a> : <span>@{handle}</span>}</h3>
      {tagline && <p className="paper-deck">{tagline} {copyBtn('Tagline', tagline)}</p>}
      {description && <p className="paper-body">{description} {copyBtn('Description', description)}</p>}
      {(priceUsdc || slaHours) && <dl className="paper-facts">
        {priceUsdc && <div><dt>Price</dt><dd>{priceUsdc} USDC a job</dd></div>}
        {slaHours && <div><dt>Delivered in</dt><dd>{slaHours} h</dd></div>}
      </dl>}
      {children}
    </article>
  );
}
