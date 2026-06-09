# Mobile Redesign (Claude Design handoff) — Implementation Plan

**Goal:** Re-skin the entire Expo app to the "Shepherd Mobile" design: bottom tab bar (Servers · Plugins · Settings), iOS nav bars, the Shepherd token system (light+dark, Geist fonts), and re-styled components — all wired to the existing real data layer.

**Design source (in-repo reference):** `docs/mobile-redesign/` — `colors_and_type.css` (tokens), `app.css` (component styles), `ui.jsx` (components), `app.jsx` (shell/nav), `screens-*.jsx`, `data.js`. Match these visually; bind to the real `@/api/*` hooks.

**Confirmed scope (user Q&A 2026-06-08):**
- Full redesign in **one pass** (all screens).
- **Dark + light** with a Settings toggle; **blue accent fixed** (no accent picker / density).
- **Bundle Geist + Geist Mono** (`@expo-google-fonts/geist` + `…/geist-mono` + `expo-font`).
- **Skip** area charts (server detail) + "Recent activity / audit" card (need history/audit endpoints). Keep KPI summary + metric bars + live traffic.

**Deps to add:** `@expo-google-fonts/geist`, `@expo-google-fonts/geist-mono`, `expo-font`, `lucide-react-native` (icons; pulls in `react-native-svg`). Sync the lock (`npm install` then `rm -rf node_modules && npm ci`).

---

## Architecture

### Theme (light + dark)
RN accepts `hsl(H, S%, L%)` / `hsla(...)` color strings, so we keep the design's HSL token triplets verbatim. Build `mobile/src/theme/tokens.ts` with `light` + `dark` palettes (each token = an `hsl(...)` string) and scales (space/radius/type/control heights), a `ThemeProvider` + `useTheme()` returning the active palette, and a persisted `useThemeMode` store (`'dark'|'light'`, default dark; AsyncStorage `shepherd_theme`). Tokens come straight from `docs/mobile-redesign/colors_and_type.css` (`:root` = light, `.dark` = dark).

Token → RN helper: `c('--primary')` → `hsl(217, 89%, 47%)`; `c('--primary', 0.85)` → `hsla(…, 0.85)`. The theme object exposes named getters (e.g. `theme.primary`, `theme.bg`, `theme.cardBg`, `theme.border`, `theme.ok/warn/err`, `theme.fgDim`, `theme.muted`, …) plus `theme.space(n)`, `theme.radius/.radiusLg/.radiusSm`, `theme.font`/`theme.mono`, and type sizes.

**Migration:** every screen currently does `import { theme } from '@/theme'` (static dark object). Convert to `const t = useTheme()` (reactive). Keep a static `darkTheme` export only where a non-component context needs it.

### Fonts
`expo-font` `useFonts` in the root layout loads Geist (400/500/600/700) + Geist Mono (400/500/600); gate render on loaded. Use `Geist_500Medium` etc. family names; `theme.font`/`theme.mono` map weights→family.

### Navigation — bottom tabs
Restructure `(app)`:
- `(app)/_layout.tsx` stays a Stack (wraps the lock gate + wallLive + AppState) — holds the tabs group + all pushed screens.
- New `(app)/(tabs)/_layout.tsx` = `Tabs` with a **custom tab bar** matching `.tabbar` (blurred bg, 3 lucide tabs): `index` (Servers), `plugins` (Plugins list), `settings` (Settings).
- Move home `index.tsx` → `(tabs)/index.tsx`; plugins list → `(tabs)/plugins.tsx`; settings → `(tabs)/settings.tsx`.
- Pushed screens stay at `(app)/...` (server/[id], console/[id], files/[id]/*, scripts/*, plugins/[id]/* (detail/config/hosts), ) so they cover the tab bar. Their header: hide the native Stack header, render the design `NavBar` (large iOS bar, chevron-left "Back", centered title).
- Tab roots render the design `Header` (56px top pad, big title, action icons).

---

## Components — `mobile/src/components/ds/` (new design-system kit)
Match `docs/mobile-redesign/ui.jsx` + `app.css`. Each is an RN component using `useTheme()`:
- `Icon` (lucide-react-native by name), `Pill` (kind ok/warn/err/neutral, pulsing dot), `Dot`, `OnlineDot` (glow ring), `Kpi` tile, `MetricBar` (label·track·value, warn/err tint), `Card`+`CardHead`, `ListRow` (icon tile · title · detail · chevron), `Switch` (iOS 51×31, green-on), `Segmented`, `Button` (primary/outline/danger/ghost, h44), `Input`+`Field`+`Label`, `Cc` (country chip), `BrandTile`, `Header` (tab root), `NavBar` (pushed), `TabBar` (custom), `Eyebrow`/`SectionLabel`, `Empty`.
- Helpers: `statusOf(online,cpu,mem,disk)`, `barKind(v)` (from ui.jsx); reuse `bps`/`pct`/`bytes` from `@/lib/format` (design `fmt.*` matches).

## Screens (bind to real data; keep all existing hooks/logic, re-skin only)
- **Servers** `(tabs)/index.tsx` — Header (Servers · sub · theme-toggle + add icons) → KPI grid (Nodes/Online/Offline/Alerting) → in/out traffic Card → grouped `HostCard`s. Drop the audit ActivityCard (deferred). Keep two-query split + live net + manual refresh.
- **ServerDetail** `server/[id].tsx` — NavBar (alias, Console action) → name + status/group/cc pills → MiniKpi grid (CPU/Mem/Disk/Load) → details Card (Net/TCP/OS/Kernel/Last seen) → Open console / Files / Run script buttons. **Skip the Telemetry area-chart card** (deferred).
- **Console** `console/[id].tsx` — NavBar + statline (Pill status + Close) + the WebView terminal (unchanged logic, themed) + keybar. Keep R4/R6 WS + buffering logic; restyle the chrome.
- **Files** `files/[id]/index.tsx` — NavBar + crumbs bar + list rows (folder/file icons). **Preview** `files/[id]/preview.tsx` — NavBar + path/read-only pill + codeblock.
- **Scripts** `scripts/index.tsx`, **RunForm** `scripts/[id].tsx`, **RunStatus** `scripts/run/[runId].tsx` — NavBar + design list/field/pill styling.
- **Plugins** `(tabs)/plugins.tsx` (list) + `plugins/[id]/index.tsx` (detail) + `…/config.tsx` + `…/hosts.tsx` — Header/NavBar + ListRow + Switch + Card. (Read `docs/mobile-redesign/screens-plugins.jsx`.)
- **Settings** `(tabs)/settings.tsx` — Header + Appearance (Dark-mode Switch → theme store) + Security (Face-ID Switch → lock store; Lock now) + Account (signed-in/server rows; Sign out). Drop the accent picker.
- **Login** `(auth)/login.tsx` — login-mark `[ Shepherd ]` glow + Field/Input/Button. **Lock** `components/LockScreen.tsx` — lock-mark + ring + Face-ID button (themed).

---

## Tasks (bite-sized; commit per task on branch `feat/mobile-redesign`)

1. **Deps + fonts** — add the 4 packages, sync lock; root `_layout` loads Geist via `useFonts`, gates render. Verify `npm ci` clean + tsc.
2. **Theme tokens + provider** — `theme/tokens.ts` (light+dark) + `theme/index.tsx` (`useTheme`, `ThemeProvider`, `useThemeMode` store + `theme/__tests__`). Keep the old `theme` export shape (dark) so nothing breaks pre-migration. jest: mock fonts + provider in setup.
3. **DS kit** — `components/ds/*` per the inventory + a barrel `index.ts`; unit-render tests for Pill/MetricBar/Kpi/ListRow/Switch/Button/Icon.
4. **Tab navigation** — `(app)/(tabs)/_layout.tsx` custom TabBar; move index/plugins/settings into `(tabs)/`; update `(app)/_layout` Stack to host tabs + pushed screens with native headers hidden (NavBar used instead). Fix all `router.push` targets (`/(app)/(tabs)/...` vs `/(app)/...`). Update layout-lock test.
5. **Servers tab** — rewrite `(tabs)/index.tsx` to the design (KPIs, traffic card, HostCard, Header). Keep data hooks. Update home/list tests.
6. **Server detail** — rewrite `server/[id].tsx` (NavBar, pills, MiniKpi, details card, action buttons; no chart). Update detail test.
7. **Console** — restyle `console/[id].tsx` chrome (NavBar/statline/keybar) keeping the WebView+WS+buffer logic.
8. **Files + preview** — restyle both.
9. **Scripts (list/form/status)** — restyle all three.
10. **Plugins (list/detail/config/hosts)** — restyle all four; read screens-plugins.jsx.
11. **Settings + Login + Lock** — restyle; wire dark-mode Switch to the theme store.
12. **Full verification** — clean `npm ci` + tsc + eslint + jest; backend/web untouched; remove the design-reference from the app bundle path (keep under docs/, not src/).

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; lock in sync (new deps); backend + web untouched. **Manual (user, dev build):** every screen matches the mock in dark + light; tab bar switches Servers/Plugins/Settings; back works; fonts render as Geist.

## Notes / risks
- Light/dark migration touches every screen (`theme` → `useTheme()`) — the DS kit absorbs most of it; screens mostly compose DS components.
- `lucide-react-native` needs `react-native-svg` (native) → already need a dev build (we do since R4). CI unaffected (typecheck/lint/test).
- Tests: add a global jest mock for `expo-font` (`useFonts: () => [true]`) and wrap renders in `ThemeProvider` (or mock `useTheme` to the dark palette) so screen tests don't need fonts/provider.
- Deferred (not in this redesign): server-detail telemetry charts, Servers "Recent activity" audit card, accent picker, density.
