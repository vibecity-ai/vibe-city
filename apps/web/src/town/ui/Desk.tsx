/* The desk (docs: Vibe City — Brand & UI Study, "One place for tools"). The city is on the left and the desk is on
   the right; every tool the CEO opens lands on the desk, stacked over the panel that opened it, with a breadcrumb
   and a Back key. Nothing covers the city, so the world keeps moving while you work. Popups are kept for decisions
   (archive) only. A sheet asks for the wide desk when its tool needs room (library, hiring, quest log). */
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from '../store';

/** Sheets open right now, oldest first: Escape and Back act on the top one only. */
const stack: string[] = [];
/** Sheets share one desk cell, so which one is seen is a matter of z-order: the one opened (or switched to another
    tool) last lies on top, whatever its place in the markup. */
let raised = 0;

export function DeskSheet({ title, wide, onClose, esc = true, className = '', children }: {
  title: string; wide?: boolean; onClose: () => void; esc?: boolean; className?: string; children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const root = useStore((s) => s.ui.panel === 'board' ? 'Ops board' : s.ui.floorId ? (s.depts.find((d) => d.id === s.ui.floorId)?.name ?? 'Floor') : 'Executive office');
  const [z, setZ] = useState(() => ++raised);
  const firstTitle = useRef(title);
  // a sheet that switches to another tool (the safe after the org chart) comes to the top again
  useEffect(() => {
    if (title === firstTitle.current) return;
    firstTitle.current = title;
    setZ(++raised);
    const at = stack.indexOf(id);
    if (at >= 0) { stack.splice(at, 1); stack.push(id); }
  }, [title, id]);

  useEffect(() => {
    stack.push(id);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[autofocus], .desk-back')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !esc || stack[stack.length - 1] !== id || document.querySelector('.dlg')) return; // a conversation closes first
      e.preventDefault(); e.stopPropagation(); close.current(); // the stage's Escape (leave floor) must not also fire
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      stack.splice(stack.indexOf(id), 1);
      if (prev?.isConnected && !prev.closest('.desk-sheet')) prev.focus({ preventScroll: true });
    };
  }, [id, esc]);

  return (
    <section ref={ref} className={`desk-sheet${wide ? ' wide' : ''} ${className}`} aria-label={title} style={{ '--z': z } as CSSProperties}>
      <nav className="desk-bar" aria-label="Where you are">
        <button type="button" className="desk-back" onClick={() => close.current()}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M8.5 3 4.5 7l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>Back
        </button>
        <ol className="desk-crumbs"><li>{root}</li><li aria-current="page">{title}</li></ol>
        {esc && <kbd className="desk-esc">Esc</kbd>}
      </nav>
      <div className="desk-body">{children}</div>
    </section>
  );
}
