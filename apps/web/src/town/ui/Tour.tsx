/* The first-run tour: five short steps that point at the lift, the quest, the job keys, the Ops board and the phone,
   once per browser (remembered in localStorage), after the company has loaded. Steps whose target is not on screen
   are skipped, so the tour fits the tower, a floor and phones alike. Uses driver.js for the spotlight. */
import { useEffect } from 'react';
import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useStore } from '../store';

const KEY = 'vc-tour';
const seen = () => { try { return localStorage.getItem(KEY) === 'done'; } catch { return true; } };
const remember = () => { try { localStorage.setItem(KEY, 'done'); } catch { /* private window: show it again next time */ } };

const STEPS: DriveStep[] = [
  { element: '.rail', popover: { title: 'Your tower', description: 'Every floor is a team of AI agents working for you. Take the lift, or click a floor, to walk in. PH is your office.' } },
  { element: '.ceo-quest', popover: { title: 'Your next quest', description: 'Quests open up the company one step at a time. The pink button is always the next thing to do.' } },
  { element: '.ceo-keys', popover: { title: 'Give out work', description: 'New job hands work to a floor: its lead plans it and splits it among the team. Staff calls your Chief of Staff to hire.' } },
  { element: '.topkey.ops', popover: { title: 'The Ops board', description: 'Every job in the company, from Order in to Served. Jobs that need you are counted here.' } },
  { element: '#hud-phone', popover: { title: 'Your phone', description: 'When your Chief of Staff needs you, or a floor finishes a job and its lead wants to report, the phone rings up here. It rings three times, then waits.' } },
];

const visible = (sel: string) => { const el = document.querySelector<HTMLElement>(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

export function Tour() {
  const loaded = useStore((s) => s.loaded);
  const game = useStore((s) => s.game);
  useEffect(() => {
    if (!loaded || !game || seen()) return;
    const id = window.setTimeout(() => {
      const steps = STEPS.filter((s) => typeof s.element === 'string' && visible(s.element));
      if (steps.length < 2) return;
      const d = driver({
        steps, showProgress: true, progressText: '{{current}} of {{total}}', popoverClass: 'vc-tour',
        nextBtnText: 'Next', prevBtnText: 'Back', doneBtnText: 'Let’s go', overlayOpacity: 0.62, stagePadding: 6, stageRadius: 10,
        onDestroyed: remember,
      });
      d.drive();
    }, 1200);
    return () => window.clearTimeout(id);
  }, [loaded, !!game]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
