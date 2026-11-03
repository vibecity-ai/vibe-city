# API-to-UI coverage (city UI)

Every backend route in `apps/backend/src/app.ts` and where the city UI (`/`) uses it. Code references are to `apps/web/src/town/ui/Panels.tsx` (UI) and `apps/web/src/town/data/live.ts` (data) unless noted. Every response is parsed with a strict schema from `packages/shared` (`apps/web/src/api.ts`); a malformed response becomes an `invalid_response` error, never partial data.

Legend for the state columns: **L** loading, **E** empty, **X** error, **C** mutation confirmation/feedback, **T** tests.

## Company and departments

| Route | UI surface | L | E | X | C | T |
|---|---|---|---|---|---|---|
| `GET /api/company` | Top bar company plate; Executive Office heading (`refreshAll`) | "Connecting to the backend…" / stage "Loading the tower" | n/a (always exists) | Backend LED red, "Out of date" badge, last data kept | — | `live.test.ts` (backend loss) |
| `GET /api/departments` | Tower floors, Executive Office lists, floor rail | as above | "No departments yet" | last list kept, stale badge | — | `live.test.ts` |
| `GET /api/departments?includeArchived=true` | Executive Office → **Archived** tab (`ArchivedList`, `loadArchived`) | "Loading…" | "No archived departments." | banner + Retry, last list kept | read-only note | `api.test.ts` |
| `POST /api/departments` | Executive Office → Add department (`CreateDeptModal`) | "Creating…", button disabled | — | error toast | toast + floor opens; full refresh (order changes) | backend `app.test.ts` |
| `GET /api/departments/:id` | Used after every department mutation (`refreshOne`) to refresh only that floor | — | — | 404 → full refresh | — | `api.test.ts`, `live.test.ts` (settings save) |
| `PATCH /api/departments/:id` (name, purpose, workspace) | Department → **Settings** → Details (`SettingsForm`) | "Saving…", disabled | "Save changes" disabled when nothing changed | per-field errors from `issues`/message; last good state untouched | toast; warns when the department returns to *Not provisioned*; `refreshOne` | `views.test.ts`, `live.test.ts` |
| `PATCH /api/departments/:id` (`chiefProfileRef`, `workerProfileRef`, `confirmModifyProfiles`) | Setup panel (unprovisioned floor) → "Use existing Hermes profiles" + explicit consent checkbox (`SetupPanel`) | "Provisioning…" | — | toast, provisioning error banner | consent required before submit | backend `provisioning.test.ts` |
| `DELETE /api/departments/:id` | Settings → Archive department… → `ArchiveModal` (type the name to confirm) | "Archiving…" | — | error under the confirm field | consequences listed (leaves tower, row kept, Hermes kept, not deletion, no restore); toast uses `hermesResourcesRetained`; floor closes, full refresh, socket/timers/polls closed | `api.test.ts`, `views.test.ts`, `live.test.ts`, backend `floors.test.ts` |
| `GET /api/departments/:id/inventory` | Inventory sheet, Department → Inventory tab, Setup panel summary | "Loading inventory…" | "None set" per list | last value kept | — | `live.test.ts` |
| `PATCH /api/departments/:id/inventory` | Inventory sheet: worker desks (`maxConcurrentWorkers`, one desk per worker on the floor), task runtime, MCP tools (`InventorySheet`). Agent view: skills, models, worker toolsets, shared context refs (`AgentPanel`) | "Saving…", inputs disabled | "None" | toast | toast says whether provisioning is needed again; "Needs provisioning again" banner | `views.test.ts`, `live.test.ts` |

## Hermes runtime and provisioning

| Route | UI surface | L | E | X | C | T |
|---|---|---|---|---|---|---|
| `GET /api/runtime/health` | Top bar LEDs (Backend/Hermes/Gateway) + screen-reader announcement; stage alert; gates for New quest/provision/cancel | — | — | LED red, stage alert "Can't reach Hermes" | — | `live.test.ts` |
| `POST /api/runtime/reconcile` | Top bar menu → Reconcile; Settings → Provisioning → Reconcile now | "Reconciling…" | — | toast | toast; full refresh + inspector reload | backend tests |
| `POST /api/departments/:id/provision` | Setup panel; Settings inspector (Provision / Provision again); floor banners | "Provisioning…" + step list (`role=status`) | — | toast + structured error | toast; `refreshOne` | `views.test.ts` (`provisioningActions`) |
| `POST /api/departments/:id/provision/retry` | Inspector "Retry provisioning" (only for a retryable error or `disconnected`); offline banner "Retry connection" | "Retrying…" | — | toast | toast; `refreshOne` | `views.test.ts` |
| `GET /api/departments/:id/provisioning` | Settings → **Hermes profiles & provisioning** inspector: state, attempts, error (code/step/retryable/at), board/chief/worker verified + timestamps, origin, consent, inventory applied/at/in-sync, last reconciled | "Loading provisioning status…" | — | last value kept | `aria-live` state | `views.test.ts` |
| `GET /api/departments/:id/profiles` | Inspector: Hermes reachability, chief/worker ref, exists, model, description; chief model on the Chain of command card | — | "—" | "Unknown (Hermes unreachable)"; infoError line, last value kept | — | `views.test.ts` |
| `GET /api/departments/:id/effective-inventory` | **Internal, by product decision (2026-11-03).** The capability report is no longer shown. The UI uses only `inSync`, for the "Hermes no longer matches" banner on the inventory sheet. Because nothing presents a guarantee, no screen can overclaim one. | — | — | — | — | `views.test.ts` (`isGuaranteed`, kept) |
| `GET /api/departments/:id/agents/:role` | **Agent view** (`AgentPanel`): opens when you click the chief or a worker on the floor (canvas or name tag), in the chain of command, or from the inventory's "Open agent". Shows the model, skills (active ones, plus the other skills installed in the profile under "Available"), toolsets (worker toggles; the chief's enabled list), recent Hermes sessions, the latest activity (chief: the department's quests; worker: its task and live events), and shared context. Skill, model, toolset and shared-context edits PATCH the department inventory, which both roles share; the "Needs provisioning again" banner then appears. | "Loading…" | "No sessions yet" / "No quests yet" | `sessionsError` line; failed reload banner + Retry, last view kept | inventory toast | backend `agents.test.ts` |

## Quests

| Route | UI surface | L | E | X | C | T |
|---|---|---|---|---|---|---|
| `GET /api/departments/:id/quests` | **Company quest board**: every department's lists combined (`data/company.ts`), filterable by department and status. Also the read-only Department → Quests tab, active quests and floor animation | — | "Nothing here" / "No quests yet" | per-department banner: *not loaded* ("missing, not zero") or *out of date* (`questSync`) | — | `company.test.ts`, `live.test.ts` |
| `POST /api/departments/:id/quests` | Company quest board composer: department required (only `ready` ones, others disabled with the reason), gateway-down warning, idempotent `clientRequestId` per department + form content | "Creating…" | — | toast; form kept | toast names the department and chief; department refresh | `company.test.ts`, backend `quests.test.ts`, `format.test.ts` |
| `GET /api/departments/:id/quests/:questId` | Quest detail → Overview: objective, counts, warnings, violations, truncation, expandable task rows (id, role, assignee, status, failure vs blocked, tree, times, summary, error, attachment count, runs), cancellation | "Loading…" | "No runs yet" | banner + Retry, last data kept | — | `views.test.ts`, `live.test.ts` |
| `GET /api/departments/:id/quests/:questId/tasks` | **Covered indirectly** by quest detail: same `TaskNode[]`, `violations` and `truncated`, from the same backend call (`quests_.detail`). The UI does not fetch both. `api.tasks()` exists and is tested. | | | | | `api.test.ts`, backend `quests.test.ts` |
| `GET /api/departments/:id/quests/:questId/activity` | Quest detail → Activity: time, label, task title, kind, scrubbed detail | "Loading…" | "No events yet." | banner, last events kept | live hint line | backend tests |
| `GET /api/departments/:id/quests/:questId/results` | Quest detail → Results: chief summary, per-task summary/error, attachments (name, size, type, created, task provenance, download) | "Loading…" | "Nothing final yet" / "N tasks have no output yet" | banner, last results kept | note that results survive cancellation | backend tests |
| `GET .../attachments/:attachmentId` | Download button: the backend-provided `downloadUrl`, a normal browser download (`download` attribute). Never reconstructed, never previewed. | | | | | backend `quests.test.ts` |
| `POST /api/departments/:id/quests/:questId/cancel` | Quest detail → Cancel quest… → inline confirmation listing the effects | "Requesting…" | — | toast | a 202 `requested` shows "requested, not confirmed"; starts polling | `live.test.ts` |
| `GET /api/departments/:id/quests/:questId/cancellation` | Cancellation panel: state, requested/confirmed times, still-stopping tasks, archived-by-Vibe-City tasks, already-finished tasks; polled with 1-2-4-8-10 s backoff for up to 2 min | "Checking with Hermes…" | — | "Stopped checking: Hermes…"; timeout note | `aria-live` | `live.test.ts`, `views.test.ts` |
| WebSocket `/api/live?departmentId=` | One socket per provisioned floor: `hermes.event` → activity feed + coalesced refresh; `resync` → refresh; `connection` → Hermes/Gateway LEDs; socket down → "Live updates reconnecting" banner | — | — | reconnect with backoff | — | `live.test.ts` |

## Deliberate omissions

- **`GET .../tasks` is not called by the UI**: quest detail already carries the identical validated tree (see above).
- **Activity `id`** is used only as the list key; it is a Hermes event number with no meaning to a user.
- **`TaskNode.parentIds/childIds`** are shown as the parent title and a child count plus the indented tree, not as raw id lists.
- **`AttachmentView.downloadUrl`** is used only as the link target; it is not printed.
- **`DepartmentView.floorOrder`** is internal (creation order); the UI shows the floor position.
- **No restore** for archived departments and **no Hermes deletion**: the backend has neither, so the UI offers neither.
- **No inline attachment preview**: downloads only (the backend always serves `application/octet-stream`).
- Never received by the browser, so never shown: the Hermes token, raw Hermes event payloads, the workspace path (only its last folder name), attachment `stored_path`, worker PIDs, command lines.
