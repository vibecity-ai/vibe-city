# Vibe City HUD and CEO Console UX Specification

**Status:** Approved design direction for the current backend feature set  
**Scope:** Player/CEO HUD, navigation, management workflows, and truthful operational feedback  
**Source contract:** `VIBE_CITY_SPEC.md`  
**Visual implementation:** existing Canvas 2D city plus React DOM HUD

## 1. Player role

The player is the company CEO. The CEO does not directly pretend to perform agent work; the CEO configures the organization, issues objectives, observes real Hermes execution, handles exceptions, and reviews results.

The UI must answer four questions at all times:

1. **Is the company operational?** Backend, Hermes dashboard, gateway, and stale-data state.
2. **What needs me?** Unconfigured departments, failed/blocked quests, disconnected resources, and unapplied changes.
3. **What is happening now?** Running chiefs, worker tasks, active quests, and live events.
4. **What can I do here?** Contextual actions for the selected tower, floor, agent task, or quest.

## 2. HUD principles

- **City first:** preserve the tower/office as the dominant surface.
- **One context panel:** use the right panel for the selected object; do not scatter full forms over the city.
- **Exception-driven CEO workflow:** attention is more prominent than healthy idle state.
- **Truth before spectacle:** animation never leads backend state.
- **Progress is factual:** show task counts and states, not invented percentages.
- **Status is redundant:** word + shape + color, never color alone.
- **Destructive actions explain consequences:** cancellation and department archive require explicit confirmation.
- **Planned features stay absent:** no fake hiring inbox, budgets, persistent employees, artifact bookshelf, heartbeat indicator, or Project status until the backend supports them.

## 3. Application shell

The existing shell remains:

```text
┌────────────────────────────────────────────────────────────────────────────────────┐
│ GLOBAL COMMAND BAR                                                                │
├──────────────────┬──────────────────────────────────────┬──────────────────────────┤
│ CEO MENU         │                                      │                          │
│                  │ CITY / FLOOR STAGE                   │ CONTEXT / DETAIL PANEL   │
│ Command Center   │                                      │                          │
│ Attention        │ stage HUD: floor signs, agent tags,  │ selected menu section,   │
│ Org Chart        │ elevator, outage banner and camera   │ department, quest, task  │
│ Departments      │                                      │ or settings              │
│ Projects         │                                      │                          │
│ Quest Board      │                                      │                          │
│ Results          │                                      │                          │
└──────────────────┴──────────────────────────────────────┴──────────────────────────┘
```

The CEO Menu is a persistent labeled rail on wide desktops, a compact icon rail on medium screens, and a drawer on phones. Wide sheets for inventory, quest board, quest detail, and department settings may expand the context panel while shrinking—not replacing—the city.

## 4. CEO Menu and global information architecture

The CEO Menu is the primary way to move between company functions. The elevator rail remains a world-navigation control for floors; it is not the application menu.

### 4.1 Menu destinations

| Destination | Purpose | Current data source |
|---|---|---|
| **Command Center** | Company health, KPIs, active work and shortcuts | Company, departments, quests, runtime health |
| **Needs Attention** | Prioritized operational notes requiring CEO action | Derived from current health, provisioning, capability and quest states |
| **Org Chart** | CEO → departments → chiefs → active worker assignments | Company/departments/profiles and live worker-role tasks |
| **Departments** | Active and archived department directory | Department APIs |
| **Projects** | Hermes Project bindings, folders, boards and workspace mode | Planned Hermes Project integration; show an honest unavailable/setup state until implemented |
| **Quest Board** | The player's only quest board: every department's quests in one view. Department boards belong to the agents. | Current per-department quest APIs, combined in the client; department chosen at creation |
| **Results** | Recent quest results and authorized attachments by department | Current quest result APIs for data actually fetched |
| **System** | Runtime health, reconciliation, refresh and deployment/version information | Runtime health and future safe build metadata |

### 4.2 Menu behavior

- The selected destination has text, icon, and a visible active marker.
- **Needs Attention** carries a factual badge count.
- **Projects** carries `Setup required`, `Disconnected`, or a verified count only when the backend provides it; never fake project rows.
- Collapsing the rail preserves icons, tooltips, focus order, badges, and accessible names.
- Opening a department, quest or task preserves the originating menu destination so Back returns to the correct list.
- Menu destinations have stable application routes/state, even if the first implementation uses internal panel state rather than URL routing.

### 4.3 Needs Attention center

This is a full list, not only a top-bar popover. Each attention note contains:

- severity: critical, action required, warning, or informational
- scope and link: system, department, quest, or task
- exact reason derived from backend state
- first-observed/last-observed time when available
- one recommended action
- current/cleared state

The first version is derived from live snapshots and is not a persistent notes database. A cleared item disappears only when the underlying backend state is resolved. Do not provide “dismiss forever” unless a durable acknowledgement model is added to the backend.

### 4.4 Org Chart view

The current truthful chart is:

```text
CEO
└─ Department
   ├─ Chief profile
   └─ Active worker assignments (real worker-role tasks/runs)
```

- Chiefs are persistent Hermes profile bindings.
- Worker nodes are active/recent assignments, not permanent employees.
- Every node links to its department, profile, quest, or task inspector.
- Disconnected, failed, and unconfigured nodes remain visible with their exact state.
- Do not imply reporting relationships or persistent staff records that the backend does not store.

When a persistent worker roster is explicitly added to the product model, it may replace assignment nodes; that is not part of the current merge.

### 4.5 Projects view

Projects is a required menu destination and a planned functional screen for the Hermes Project integration already specified in `VIBE_CITY_SPEC.md`.

Before integration, render an explicit setup state explaining that quests currently use department workspace configuration and that verified Hermes Project bindings are not available yet. After integration, show:

- logical project name and verification state
- bound department and Kanban board
- role-local chief/worker Project refs
- primary folder label, never an absolute host path
- workspace mode: scratch, directory, or worktree
- drift/disconnected state and reconcile action
- quests associated with the Project

Project creation, association, mutation and archive controls must wait for the verified backend contract; the menu entry itself may ship first.

## 5. Global command bar

The persistent top bar contains, left to right:

1. **Vibe City wordmark** — clicking returns to the Executive Office/tower view.
2. **Company plate** — current company name; not editable until a backend route exists.
3. **Menu toggle/collapse** — opens the CEO Menu on small screens or collapses its labels on desktop.
4. **Context breadcrumb** — current destination and selected department/quest.
5. **Attention button with factual count** — shortcut to the full Needs Attention center.
6. **New Quest** — enabled only when a ready department is selected; otherwise opens a department chooser containing only ready departments.
7. **Connection cluster:**
   - Backend
   - Hermes dashboard
   - Gateway
   - `Out of date` badge when the last refresh failed
8. **System menu:** refresh, reconcile, classic board, deployment/build information if exposed later.

Rules:

- Never collapse backend/Hermes/gateway into one generic “online” light.
- Gateway stopped means queued work cannot start; it does not mean stored data disappeared.
- A stale badge remains visible until a successful snapshot replaces it.

## 6. CEO Command Center — Executive Office panel

The Executive Office is the default tower context. It is an operational dashboard, not a decorative penthouse.

### 5.1 Header

- `PH · Executive Office`
- Company name
- One-line operational sentence generated from factual counts, for example:
  - “All departments are operational.”
  - “2 departments need attention; 3 worker tasks are running.”
- Primary action: **Add department**
- Secondary action: **Create quest** with ready-department chooser

### 5.2 KPI tiles

Only factual counters:

- Active departments
- Running agent tasks: chief runs + worker tasks
- Active quests
- Needs attention

No revenue, productivity percentage, XP, or completion forecast without a real source.

### 5.3 CEO attention queue

Ordered by urgency:

1. Backend or Hermes disconnected
2. Gateway unavailable while ready work exists
3. Department provisioning error
4. Failed quest/task
5. Awaiting human input
6. Quest in review
7. Inventory/profile drift or unapplied changes
8. Unconfigured department

Each item contains:

- scope: department/quest/task
- exact state and plain-language reason
- observed timestamp when available
- one primary next action
- link to the full context panel

Do not create a notification record in frontend state. Derive the queue from the latest snapshots.

### 5.4 Company operations

- Department rows with floor, name, state, active quest count, running task count
- Archived departments link
- Reconcile now
- Refresh
- Last successful snapshot time when tracked by the frontend

### 5.5 Active work and recent outcomes

- Active quests grouped by department
- Recently completed/cancelled quests from loaded data
- Direct links to quest details and results

Do not claim a complete company-wide history unless all department data has actually been fetched.

## 6. Tower and floor stage HUD

### 6.1 Tower view

- HQ summary card: total floors and active department count
- Clickable floor signs
- Elevator rail with department status dots
- Agent-state legend
- Zoom out/in/fit controls
- Add-floor ghost sign
- Global outage banner

### 6.2 Floor view

- Breadcrumb: Tower → floor number → department
- Chief and worker-task name tags on hover/selection
- Selected agent/task tag remains visible
- Failed task tags remain visible until state changes
- Elevator rail for direct floor switching
- Context panel defaults to department overview

### 6.3 Canvas interaction mapping

| World interaction | UI result |
|---|---|
| Click Executive Office | CEO Command Center |
| Click floor | Department Control Center |
| Click chief | Chief/profile inspector within department panel |
| Click worker at desk | Worker task/run inspector, not a persistent employee profile |
| Click Kanban wall or Quest Board action | Company quest board filtered to that department |
| Click server/inventory affordance | Department inventory/effective capability sheet |
| Click decorative shelf | No action until an artifact-library backend exists |

Interactive objects need focusable DOM overlays or equivalent accessible controls; canvas-only clicking is insufficient.

## 7. Department Control Center

### 7.1 Header

- Floor number and department name
- Purpose
- Department state chip
- Primary: New quest
- Secondary: Quest board, Inventory, Settings

### 7.2 Overview tab

- Chief card: profile ref, normalized state, current activity, model if returned
- Worker task rows: task title, desk ID, normalized state, since/done time
- Requested worker limit with honest “not enforced per department” copy
- Active quests
- Live activity feed

### 7.3 Profiles and provisioning tab

Show all safe backend fields:

- chief/worker refs, existence, model, description
- managed vs associated origin
- modification consent
- board/chief/worker verification and timestamps
- inventory applied/in-sync
- provisioning attempts, state, structured error, last reconcile

Actions: provision, retry when valid, reconcile, refresh.

### 7.4 Inventory tab/sheet

- Toolsets
- Skills
- MCP tools
- Models
- Shared context references
- Workspace label and advisory-isolation copy
- Runtime/concurrency limits
- Effective capability report grouped as enforced/configured/unverified/unsupported

Only enforced rows receive guarantee/lock styling.

### 7.5 Settings tab/sheet

- Name
- Purpose
- Workspace configure/clear
- Associated profile workflow remains under provisioning
- Archive department in a separated danger zone

Explain that archive removes the active floor but retains Hermes resources and results.

## 8. Agent and task inspector

### 8.1 Chief selection

The chief is a Hermes profile plus the root quest run when active. Show:

- profile ref
- existence/reachability
- model and description when returned
- current task/activity
- current quest link
- normalized status
- safe run history from quest task data

### 8.2 Worker selection

A desk worker is a real worker-role task/run, not a persistent employee. Show:

- desk label (`W-01`, etc.)
- task title and ID
- assignee profile
- task status and failure distinction
- parent quest
- created/started/completed times
- summary or scrubbed error
- run history
- attachment count and result link

Do not show fictional biography, permanent employment history, or per-worker inventory.

## 9. Quest Board

### 9.1 Columns

- Queued
- In progress: planning, running, cancelling
- Needs attention: awaiting input, in review, failed
- Finished: completed, cancelled

The board is a projection of Hermes-derived quest status. It does not allow drag-and-drop status changes unless the backend later supports those mutations safely.

### 9.2 Quest card

- title
- exact status
- department
- factual task counts
- flags: failures, blocked, unauthorized assignee, idle
- created time
- no percentage

### 9.3 Create quest

- ready department
- title
- objective
- optional instructions
- stable client request ID for idempotency
- explicit warning when gateway is unavailable

## 10. Quest detail

Tabs:

1. **Overview** — objective, warnings, violations, factual task tree, task/run inspector, truncation notice.
2. **Activity** — normalized, scrubbed events; heartbeat events remain hidden.
3. **Results** — chief summary, per-task summaries/errors, authorized attachment downloads.
4. **Cancellation status** — may be embedded in Overview until it warrants a tab; show requested/confirmed timestamps, remaining tasks, archived tasks, and already-finished tasks.

Cancellation remains “requested” until Hermes confirms terminal tasks and no open runs.

## 11. CEO action model

### 11.1 Safe immediate actions

- navigate
- refresh
- reconcile
- inspect
- download authorized attachment

### 11.2 Confirmed mutations

- create/edit department
- edit inventory
- provision/retry
- create quest

Use a clear submit state and success/error toast.

### 11.3 Destructive actions

- cancel quest
- archive department

Require a modal that states consequences and uses the specific object name. Never use a generic “Are you sure?” prompt as the final design.

## 12. Empty, loading, error, and stale states

Every panel must define:

- first load
- empty but healthy
- stale last-known data
- backend unreachable
- Hermes dashboard unreachable
- token rejected
- gateway stopped
- mutation pending
- mutation failed
- retry action

Global outage banners must not erase context. Keep the last known city visible and label it out of date.

## 13. Responsive design

### Desktop ≥ 1100 px

- city + 440 px context panel
- wide sheets expand the panel and reduce city width
- full command bar labels

### Tablet 700–1099 px

- city above or beside panel depending orientation
- command actions collapse into icon + accessible label
- floor rail becomes horizontal when needed

### Phone < 700 px

- 56–60 px command bar
- stage remains a navigational strip, not the only content
- context panel becomes the primary scroll region
- sheets occupy full width
- persistent bottom action row only for the current panel’s one or two primary actions
- destructive confirmation is full-screen

Touch targets are at least 44×44 px. Safe-area insets are respected.

## 14. Accessibility

- All world interactions have DOM controls and keyboard focus.
- Escape moves back one navigation level.
- Tabs use tab semantics and keyboard navigation.
- Modals trap focus and restore it on close.
- Connection and mutation changes use polite `aria-live`; destructive failures use assertive alerts.
- Reduced-motion mode suppresses camera dives, blinking, bloom-heavy transitions, and celebratory effects without suppressing state.
- Canvas has a useful label, but operational information is duplicated in accessible DOM.

## 15. Visual hierarchy

Retain the current visual language:

- Bungee for signage/display
- Jersey 10 for controls and counts
- Manrope for reading
- JetBrains Mono for IDs and technical values
- dark violet material
- pink primary action
- cyan navigation/secondary action
- mint success
- amber configuration/attention
- red failure/destructive
- gold chief/Executive Office

Use the stepped sunset stripe only for identity and primary selection, not every card.

## 16. Implementation order

1. Global command bar navigation and attention count.
2. CEO attention queue and active-work summaries.
3. Department Settings and archive.
4. Profiles/provisioning inspector.
5. Complete Inventory fields and guarantees.
6. Worker task/run inspector.
7. Cancellation progress UI.
8. Responsive/mobile command patterns.
9. Keyboard/focus/reduced-motion audit.
10. Screenshot and end-to-end verification against a deployed instance.

## 17. HUD definition of done

- The CEO can perform every current backend mutation from the main city UI.
- The CEO can identify system health, urgent attention, active work, and results without opening the classic board.
- Every displayed status is derived from backend data and has loading/stale/error behavior.
- No unsupported feature appears interactive.
- Desktop, tablet, and phone workflows remain usable.
- The city remains visible during normal management flows.
- Destructive actions communicate exact consequences.
- Keyboard and screen-reader users can reach the same operational functionality as pointer users.
