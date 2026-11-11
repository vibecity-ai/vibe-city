/* The first-run tour: short steps that point at the lift, the quest, the job keys, the Ops board and the phone, then
   a last step that names the company. Once per browser (remembered in localStorage), as soon as the company has loaded.
   Steps whose target is not on screen are skipped, so the tour fits the tower, a floor and phones alike. On later loads
   keyboard focus lands on the next quest's action. Uses driver.js for the spotlight. */
import { useEffect } from 'react';
import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { useStore } from '../store';
import { renameCompany } from '../data/live';

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

/** The last step: an input on the popover, saved through the same rename as the top bar (server validates). */
function nameStep(): DriveStep {
  let input: HTMLInputElement | null = null;
  let err: HTMLElement | null = null;
  let btn: HTMLButtonElement | null = null;
  return {
    popover: {
      title: 'Name your company', description: 'It goes on the rooftop sign. You can change it later from the top bar.', doneBtnText: 'Open for business',
      onPopoverRender: (p) => {
        btn = p.nextButton;
        input = document.createElement('input');
        input.className = 'vc-tour-name'; input.maxLength = 24; input.setAttribute('aria-label', 'Company name');
        input.value = useStore.getState().company?.name ?? '';
        err = document.createElement('p'); err.className = 'vc-tour-err'; err.setAttribute('role', 'alert');
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); p.nextButton.click(); } });
        input.addEventListener('input', () => { if (err) err.textContent = ''; });
        p.description.after(input, err);
        setTimeout(() => { input?.focus(); input?.select(); }, 0);
      },
      onNextClick: async (_el, _step, { driver: d }) => {
        const v = input?.value.trim() ?? '';
        if (v && v !== useStore.getState().company?.name) {
          if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
          const e = await renameCompany(v);
          if (e) { if (btn) { btn.disabled = false; btn.textContent = 'Open for business'; } if (err) err.textContent = e; input?.focus(); return; }
        }
        d.destroy();
      },
    },
  };
}

const visible = (sel: string) => { const el = document.querySelector<HTMLElement>(sel); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

export function Tour() {
  const loaded = useStore((s) => s.loaded);
  const game = useStore((s) => s.game);
  useEffect(() => {
    if (!loaded || !game) return;
    // ponytail: one frame-ish wait so the tower DOM has laid out; raise it if steps get skipped on slow devices
    const id = window.setTimeout(() => {
      if (seen()) { document.querySelector<HTMLElement>('.ceo-act button')?.focus({ preventScroll: true }); return; }
      const steps = [...STEPS.filter((s) => typeof s.element === 'string' && visible(s.element)), nameStep()];
      const d = driver({
        steps, showProgress: true, progressText: '{{current}} of {{total}}', popoverClass: 'vc-tour',
        nextBtnText: 'Next', prevBtnText: 'Back', overlayOpacity: 0.62, stagePadding: 6, stageRadius: 10,
        onDestroyed: remember,
      });
      d.drive();
    }, 300);
    return () => window.clearTimeout(id);
  }, [loaded, !!game]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
