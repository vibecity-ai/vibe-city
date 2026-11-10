import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { City } from './world/City';
import { startLive } from './data/live';
import { StageOverlay } from './ui/Stage';
import { DialogueWindow } from './ui/Dialogue';
import { HiringLayer } from './ui/Hiring';
import { NewDeptWindow } from './ui/NewDept';
import { MarketListingWindow } from './ui/MarketListing';
import { RequestsPoll } from './ui/Requests';
import { ExecRoomModal } from './ui/ExecRoom';
import { QuestLogWindow } from './ui/QuestLog';
import { FloorSheetWindow } from './ui/FloorSheet';
import { SkillLibraryWindow } from './ui/Skills';
import { TopBar, ExecPanel, DeptPanel, SettingsSheet, QuestBoard, QuestDetail, CreateDeptModal, ArchiveModal, AgentPanel } from './ui/Panels';

export default function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [city, setCity] = useState<City | null>(null);
  const panel = useStore((s) => s.ui.panel);
  const view = useStore((s) => s.ui.view);
  useEffect(() => startLive(), []);
  const floorId = useStore((s) => s.ui.floorId);

  useEffect(() => {
    if (!canvas.current) return;
    const c = new City(canvas.current);
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(canvas.current.parentElement!);
    c.resize(); c.start(); setCity(c);
    return () => { ro.disconnect(); c.stop(); };
  }, []);

  // phones: after navigating, bring the part that changed into view (the office, or the sheet)
  useEffect(() => {
    if (!matchMedia('(max-width: 900px) and (min-height: 521px)').matches) return;
    const sheet = panel === 'settings' || panel === 'board' || panel === 'quest';
    const id = window.setTimeout(() => {
      if (sheet) { const el = document.querySelector('.panel') as HTMLElement | null; if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 56 }); }
      else window.scrollTo({ top: 0 });
    }, 30);
    return () => window.clearTimeout(id);
  }, [view, floorId, panel]);

  // keyboard/screen-reader users land on the new panel's heading after navigating (not on first load)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const id = window.setTimeout(() => document.querySelector<HTMLElement>('.panel h1[tabindex="-1"]')?.focus({ preventScroll: true }), 40);
    return () => window.clearTimeout(id);
  }, [panel, floorId]);

  return (
    <div className="app">
      <TopBar />
      <main className={`main view-${view}${panel === 'board' ? ' wide' : ''}`}>
        <section className="stage">
          <canvas ref={canvas} aria-label="Vibe City tower: each floor is a department of AI agents" />
          <StageOverlay city={city} />
        </section>
        <aside className="panel" key={panel === 'dept' || panel === 'exec' ? panel + (floorId ?? '') : panel}>
          {panel === 'exec' && <ExecPanel />}
          {panel === 'dept' && <DeptPanel />}
          {panel === 'settings' && <SettingsSheet />}
          {panel === 'board' && <QuestBoard />}
          {panel === 'quest' && <QuestDetail />}
          {panel === 'agent' && <AgentPanel />}
        </aside>
        {/* the desk: every tool opens here, stacked over the panel (ui/Desk.tsx); later ones lie on top */}
        <div className="desk-layer">
          <ExecRoomModal />
          <FloorSheetWindow />
          <QuestLogWindow />
          <CreateDeptModal />
          <NewDeptWindow />
          <MarketListingWindow />
          <HiringLayer />
          <SkillLibraryWindow />
        </div>
      </main>
      {/* a conversation is a scene over the whole city, not a tool on the desk */}
      <DialogueWindow />
      <ArchiveModal />
      <RequestsPoll />
    </div>
  );
}
