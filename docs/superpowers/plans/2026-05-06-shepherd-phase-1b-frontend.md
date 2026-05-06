# Shepherd Phase 1.B — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the React SPA frontend (admin panel + public monitoring wall), embedded into `cmd/server` via `go:embed`. End state: `make web && make server && ./bin/shepherd-server` boots; visiting `http://localhost:8080` shows the public wall (with no servers yet, an empty grid + heading); `/admin/login` accepts the initial admin and routes to the dashboard. All Phase 1.A flows (install, repair, config push, settings) drivable from the browser.

**Out of scope:** Docker Compose / Caddy / cross-compile / GitHub release CI → Plan 1.C.

**Architecture:** Vite TS app under `web/`. Single binary deploy via `go:embed all:dist/*` in a new `internal/web/` package, mounted as a catch-all `/` handler in the existing router. SPA fallback: any path that isn't an API/agent route AND doesn't have a file extension returns `index.html`. shadcn/ui via CLI for primitives; lucide-react for icons; react-query for server state; zustand (with localStorage persist) for `auth` + `ui` (theme/lang/toasts); react-hook-form+zod for forms; react-i18next for zh-CN/en.

**Tech Stack:** React 19, TypeScript 5.x, Vite 5+, Tailwind 3, react-router-dom@6, @tanstack/react-query 5, zustand 5, react-hook-form, zod, react-i18next, i18next-browser-languagedetector, lucide-react, shadcn/ui (CLI), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-05-06-shepherd-phase-1b-frontend-design.md`

**Branch:** create `phase-1b` off main before starting Task 1.

---

## File Map

```
# new
.gitignore                          # MODIFY — add /internal/web/dist/* exception
Makefile                            # MODIFY — add `web` target, make `server` depend on it, add `server-no-web`
internal/api/admin_servers.go       # MODIFY — Task 1, add ?with=latest support
internal/api/admin_servers_test.go  # MODIFY — Task 1, add TestServersList_WithLatest
internal/api/router.go              # MODIFY — Task 8, mount web.Handler() at "/"
cmd/server/main.go                  # MODIFY — Task 8, import internal/web, no behaviour change beyond router

internal/web/
  embed.go                          # CREATE — //go:embed all:dist/* + Handler()
  embed_test.go                     # CREATE — placeholder fallback test
  dist/.gitkeep                     # CREATE — empty file kept in git so embed pattern matches before first build

web/                                # CREATE — full Vite project
  .gitignore
  package.json
  package-lock.json
  vite.config.ts
  tsconfig.json
  tsconfig.node.json
  tailwind.config.ts
  postcss.config.js
  components.json                   # shadcn config (created by CLI)
  index.html
  src/
    main.tsx
    App.tsx
    index.css
    i18n.ts
    vite-env.d.ts                   # standard Vite types
    api/
      client.ts
      auth.ts
      servers.ts
      public.ts
      settings.ts
    components/
      ui/                           # shadcn copies — populated by CLI in Task 10
      OnlineDot.tsx
      CountryFlag.tsx
      ThemeToggle.tsx
      LangToggle.tsx
      MetricBadge.tsx
      MetricCard.tsx
      Sparkline.tsx
      TimeSeriesChart.tsx
      InstallProgress.tsx
      RequireAdmin.tsx
      ToastBridge.tsx                 # bridges zustand toast queue → shadcn ui/toaster
    layouts/
      PublicLayout.tsx
      AdminLayout.tsx
    pages/
      public/
        Wall.tsx
        ServerDetail.tsx
      admin/
        Login.tsx
        Dashboard.tsx
        ServerList.tsx
        ServerNew.tsx
        ServerDetail.tsx
        Settings.tsx
      NotFound.tsx
    store/
      auth.ts
      ui.ts
    locales/
      zh-CN.json
      en.json
    lib/
      utils.ts
      bytes.ts
      time.ts
      thresholds.ts
      country.ts
    test-utils/
      render.tsx                    # RTL render() wrapped with QueryClient + I18nextProvider + Router

scripts/
  web-smoke.sh                      # CREATE — Task 25 manual e2e helper
```

---

## Conventions

- **Directories:** the Vite project lives at `web/`; build output writes to `internal/web/dist/` (cross-package output).
- **Working directory for npm commands:** always `web/` (e.g. `cd web && npm install`). The plan shows the `cd` explicitly in each step.
- **Why pinning is OK:** dependencies are pinned via `package-lock.json` (committed). Versions in this plan are minimum-acceptable; `npm install <pkg>` will pull a recent compatible version and lock it.
- **All component code is TypeScript with explicit types** for props. Hooks are typed via `useQuery<T>` / `useMutation<T>`.
- **Tests run with `cd web && npm test` (vitest run)** — NOT watch mode in CI/agent. The `package.json` `test` script is `vitest run`.
- **One commit per task** unless a task says otherwise.

---

## Milestone 1 — Branch + backend `?with=latest`

### Task 1: Add `?with=latest` to `/api/servers`

**Files:**
- Modify: `internal/api/admin_servers.go`
- Modify: `internal/api/admin_servers_test.go`

- [ ] **Step 1: Create the feature branch**

```
git checkout -b phase-1b
git log --oneline -1
```
Expected: still at `5e8897a` or `209df6f` (the spec commit).

- [ ] **Step 2: Modify `ServersAPI.List` to support `?with=latest`**

Edit `internal/api/admin_servers.go`. Find the existing `List` handler:

```go
func (a *ServersAPI) List(w http.ResponseWriter, r *http.Request) {
	out, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, out)
}
```

Replace with:

```go
func (a *ServersAPI) List(w http.ResponseWriter, r *http.Request) {
	servers, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if r.URL.Query().Get("with") != "latest" {
		writeJSON(w, 200, servers)
		return
	}
	type wrapped struct {
		*serversvc.Server
		Latest *telemetrysvc.Point `json:"latest"`
	}
	out := make([]wrapped, 0, len(servers))
	for _, s := range servers {
		pt, _ := a.Query.Latest(r.Context(), s.ID) // nil if no telemetry yet — fine
		out = append(out, wrapped{Server: s, Latest: pt})
	}
	writeJSON(w, 200, out)
}
```

> The anonymous wrap `*serversvc.Server` flattens the original fields into the JSON output via Go struct embedding. Original callers (no `?with=`) get the same response shape as before.

- [ ] **Step 3: Append `TestServersList_WithLatest` to `admin_servers_test.go`**

```go
func TestServersList_WithLatest(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	ing := &telemetrysvc.Ingest{DB: d}
	q := &telemetrysvc.Query{DB: d}
	api := &ServersAPI{Servers: svc, Query: q}

	srv, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "h1"})
	now := time.Now().UTC().Truncate(time.Second)
	if err := ing.WriteSample(context.Background(), srv.ID, agentapi.Telemetry{
		TS: now, CPUPct: 12.5, MemUsed: 1, MemTotal: 2,
	}); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/servers?with=latest", nil)
	api.List(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var out []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("want 1 server, got %d", len(out))
	}
	latest, ok := out[0]["latest"].(map[string]any)
	if !ok {
		t.Fatalf("missing latest object: %#v", out[0])
	}
	if latest["cpu_pct"] != 12.5 {
		t.Errorf("cpu_pct=%v want 12.5", latest["cpu_pct"])
	}
}

func TestServersList_NoLatestByDefault(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	svc := &serversvc.Service{DB: d}
	api := &ServersAPI{Servers: svc, Query: &telemetrysvc.Query{DB: d}}
	_, _ = svc.Create(context.Background(), serversvc.CreateInput{Name: "h1"})

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/servers", nil)
	api.List(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var out []map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if _, has := out[0]["latest"]; has {
		t.Error("plain /api/servers should not include latest")
	}
}
```

The test file already imports `agentapi`, `serversvc`, `shepdb`. You may need to add `time`, `path/filepath`, `httptest`, `encoding/json`, `context`, and `telemetrysvc`. Run goimports if your editor does it; otherwise add them by hand.

- [ ] **Step 4: Run tests**

```
go test ./internal/api -v -run "TestServersList"
go test ./...
```
Expected: both new tests pass; all other tests still pass.

- [ ] **Step 5: Commit**

```
git add internal/api/admin_servers.go internal/api/admin_servers_test.go
git commit -m "feat(api): /api/servers?with=latest joins most recent telemetry"
```

---

## Milestone 2 — Vite scaffold

### Task 2: Initialise Vite + TS project at `web/`

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/tsconfig.node.json`, `web/vite.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/vite-env.d.ts`, `web/.gitignore`

- [ ] **Step 1: Create `web/` directory tree**

```
mkdir -p /Users/hg/project/Shepherd/web/src
cd /Users/hg/project/Shepherd/web
```

- [ ] **Step 2: Write `web/package.json`** (initial — no deps yet; deps are added in subsequent steps via `npm install`)

```json
{
  "name": "shepherd-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 3: Install Vite + React + TypeScript**

```
cd /Users/hg/project/Shepherd/web
npm install --save-dev typescript @types/node @vitejs/plugin-react vite
npm install --save react@19 react-dom@19
npm install --save-dev @types/react @types/react-dom
```

- [ ] **Step 4: Write `web/.gitignore`**

```
node_modules
.DS_Store
.env.local
.vite
*.log
```

- [ ] **Step 5: Write `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 6: Write `web/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 7: Write `web/vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/agent': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
    },
  },
})
```

- [ ] **Step 8: Write `web/index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Shepherd</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 9: Write `web/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 10: Write `web/src/main.tsx`** (minimal — just renders App for now)

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 11: Write `web/src/App.tsx`** (placeholder — will be replaced in Task 14)

```tsx
export default function App() {
  return <div className="p-8">Shepherd — frontend boot OK</div>
}
```

- [ ] **Step 12: Write `web/src/index.css`** (placeholder — Tailwind directives land in Task 3)

```css
body {
  margin: 0;
  font-family: system-ui, -apple-system, sans-serif;
}
```

- [ ] **Step 13: Verify build works**

```
cd /Users/hg/project/Shepherd/web
npm run build
ls -la /Users/hg/project/Shepherd/internal/web 2>&1 || echo "dir not yet created — that's OK, Task 7 makes it"
```
Expected: build fails because `internal/web/dist` parent doesn't exist (or the embed dir doesn't exist yet). That's fine for now — we just need the source tree to compile. Run instead:

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
```
Expected: no TS errors.

- [ ] **Step 14: Commit**

```
cd /Users/hg/project/Shepherd
git add web/ -- ':!web/node_modules'
git commit -m "chore(web): scaffold vite + react + typescript"
```

---

### Task 3: Tailwind 3 + shadcn-ready CSS variables

**Files:**
- Create: `web/tailwind.config.ts`, `web/postcss.config.js`
- Modify: `web/src/index.css`
- Modify: `web/package.json` (add tailwind deps)

- [ ] **Step 1: Install Tailwind 3 + supporting libs**

```
cd /Users/hg/project/Shepherd/web
npm install --save-dev tailwindcss@3 postcss autoprefixer
npm install --save class-variance-authority clsx tailwind-merge
```

- [ ] **Step 2: Write `web/postcss.config.js`**

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 3: Write `web/tailwind.config.ts`** (shadcn-compatible — references CSS variables defined in `index.css`)

```ts
import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // metric-level color slots (used by MetricBadge)
        level: {
          low: 'hsl(var(--level-low))',
          mid: 'hsl(var(--level-mid))',
          high: 'hsl(var(--level-high))',
          alert: 'hsl(var(--level-alert))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
}

export default config
```

- [ ] **Step 4: Replace `web/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 5.9% 10%;
    --radius: 0.5rem;
    --level-low: 142 71% 45%;
    --level-mid: 48 96% 53%;
    --level-high: 30 95% 53%;
    --level-alert: 0 72% 51%;
  }

  .dark {
    --background: 222 14% 7%;
    --foreground: 0 0% 98%;
    --card: 222 14% 9%;
    --card-foreground: 0 0% 98%;
    --popover: 222 14% 9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 240 4.9% 83.9%;
    --level-low: 142 65% 50%;
    --level-mid: 48 90% 55%;
    --level-high: 30 90% 55%;
    --level-alert: 0 70% 55%;
  }
}

@layer base {
  body {
    @apply bg-background text-foreground;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  }
}
```

> The `--background: 222 14% 7%` choice for dark approximates the spec memory note `#0e1015` (xterm bg). Light-mode is conservative shadcn defaults.

- [ ] **Step 5: Verify build**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
npm run build 2>&1 | tail -10  # may still fail if internal/web doesn't exist; that's OK
```

- [ ] **Step 6: Commit**

```
cd /Users/hg/project/Shepherd
git add web/tailwind.config.ts web/postcss.config.js web/src/index.css web/package.json web/package-lock.json
git commit -m "feat(web): tailwind 3 with shadcn-compatible CSS variables (light + dark + level colors)"
```

---

### Task 4: Install runtime deps

**Files:**
- Modify: `web/package.json`, `web/package-lock.json`

- [ ] **Step 1: Install router, react-query, zustand, RHF, zod, i18next, lucide-react**

```
cd /Users/hg/project/Shepherd/web
npm install --save react-router-dom@6 @tanstack/react-query@5 zustand@5 react-hook-form @hookform/resolvers zod react-i18next i18next i18next-browser-languagedetector lucide-react
```

- [ ] **Step 2: Install testing deps**

```
npm install --save-dev vitest @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

- [ ] **Step 3: Add Vitest config to `web/vite.config.ts`**

Replace the file with:

```ts
/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/agent': { target: 'http://localhost:8080', changeOrigin: false, ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-utils/setup.ts'],
    css: false,
  },
})
```

- [ ] **Step 4: Create `web/src/test-utils/setup.ts`**

```ts
import '@testing-library/jest-dom/vitest'
```

- [ ] **Step 5: Sanity test — run vitest with no tests yet**

```
cd /Users/hg/project/Shepherd/web
npx vitest run
```
Expected: vitest finds no tests, exits 0 ("No test files found").

- [ ] **Step 6: Commit**

```
cd /Users/hg/project/Shepherd
git add web/package.json web/package-lock.json web/vite.config.ts web/src/test-utils/setup.ts
git commit -m "chore(web): runtime + test deps (router, react-query, zustand, RHF, i18n, lucide, vitest+RTL)"
```

---

### Task 5: i18n setup with zh-CN + en seed locales

**Files:**
- Create: `web/src/i18n.ts`, `web/src/locales/zh-CN.json`, `web/src/locales/en.json`
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Write `web/src/locales/zh-CN.json`** (initial keys; later tasks add more)

```json
{
  "app": {
    "name": "Shepherd",
    "tagline": "服务器舰队管理"
  },
  "auth": {
    "login": "登录",
    "logout": "登出",
    "username": "用户名",
    "password": "密码",
    "submit": "登录",
    "invalid_credentials": "用户名或密码错误"
  },
  "wall": {
    "title": "服务器状态",
    "online": "在线",
    "offline": "离线",
    "no_servers": "暂无公开展示的服务器",
    "ungrouped": "未分组"
  },
  "metric": {
    "cpu": "CPU",
    "mem": "内存",
    "disk": "磁盘",
    "net": "网络",
    "load": "负载",
    "tcp": "TCP 连接"
  },
  "level": {
    "low": "低",
    "mid": "中",
    "high": "高",
    "alert": "告警"
  },
  "range": {
    "1h": "1 小时",
    "24h": "24 小时",
    "7d": "7 天"
  },
  "admin": {
    "dashboard": "概览",
    "servers": "服务器",
    "settings": "设置",
    "add_server": "添加服务器",
    "name": "名称",
    "host": "地址",
    "agent_last_seen": "最近上线",
    "actions": "操作",
    "details": "详情",
    "delete": "删除",
    "confirm_delete": "确认删除服务器 \"{{name}}\"？此操作不可撤销。",
    "repair": "重新配对",
    "repair_token_issued": "已生成新的注册令牌（{{expires}} 过期）",
    "config_interval": "采样间隔（秒）",
    "config_pushed": "已推送给在线 agent",
    "config_offline": "agent 离线，配置未送达",
    "install_progress": "装机进度",
    "install_done": "装机完成",
    "install_failed": "装机失败",
    "save": "保存",
    "saved": "已保存",
    "summary": {
      "total": "总数",
      "online": "在线",
      "offline": "离线",
      "alerts": "告警中",
      "top_cpu": "CPU Top 5",
      "top_mem": "内存 Top 5"
    }
  },
  "settings": {
    "public_display_mode": "公共页显示模式",
    "mode_raw": "百分比",
    "mode_level": "档位",
    "mode_both": "两者都显示",
    "retention_30s": "30s 样本保留期",
    "retention_5m": "5min 聚合保留期",
    "retention_1h": "1h 聚合保留期",
    "default_telemetry_interval_seconds": "默认采样间隔（秒）"
  },
  "common": {
    "loading": "加载中…",
    "error": "出错了",
    "retry": "重试",
    "cancel": "取消",
    "ok": "好",
    "copy": "复制",
    "copied": "已复制",
    "back": "返回",
    "not_found": "未找到",
    "minute_ago": "{{n}} 分钟前",
    "second_ago": "{{n}} 秒前",
    "hour_ago": "{{n}} 小时前",
    "day_ago": "{{n}} 天前",
    "just_now": "刚刚"
  }
}
```

- [ ] **Step 2: Write `web/src/locales/en.json`** (mirror of zh-CN)

```json
{
  "app": { "name": "Shepherd", "tagline": "Server fleet manager" },
  "auth": {
    "login": "Login",
    "logout": "Logout",
    "username": "Username",
    "password": "Password",
    "submit": "Sign in",
    "invalid_credentials": "Invalid username or password"
  },
  "wall": {
    "title": "Server status",
    "online": "online",
    "offline": "offline",
    "no_servers": "No public servers",
    "ungrouped": "Ungrouped"
  },
  "metric": { "cpu": "CPU", "mem": "Memory", "disk": "Disk", "net": "Network", "load": "Load", "tcp": "TCP" },
  "level": { "low": "low", "mid": "med", "high": "high", "alert": "alert" },
  "range": { "1h": "1h", "24h": "24h", "7d": "7d" },
  "admin": {
    "dashboard": "Dashboard",
    "servers": "Servers",
    "settings": "Settings",
    "add_server": "Add server",
    "name": "Name",
    "host": "Host",
    "agent_last_seen": "Last seen",
    "actions": "Actions",
    "details": "Details",
    "delete": "Delete",
    "confirm_delete": "Delete server \"{{name}}\"? This cannot be undone.",
    "repair": "Re-pair",
    "repair_token_issued": "New enrollment token issued (expires {{expires}})",
    "config_interval": "Sample interval (sec)",
    "config_pushed": "Config pushed to live agent",
    "config_offline": "Agent offline; config not delivered",
    "install_progress": "Install progress",
    "install_done": "Install complete",
    "install_failed": "Install failed",
    "save": "Save",
    "saved": "Saved",
    "summary": {
      "total": "Total",
      "online": "Online",
      "offline": "Offline",
      "alerts": "Alerting",
      "top_cpu": "Top CPU",
      "top_mem": "Top memory"
    }
  },
  "settings": {
    "public_display_mode": "Public display mode",
    "mode_raw": "Raw values",
    "mode_level": "Levels",
    "mode_both": "Both",
    "retention_30s": "30s samples retention",
    "retention_5m": "5m rollup retention",
    "retention_1h": "1h rollup retention",
    "default_telemetry_interval_seconds": "Default sampling interval (sec)"
  },
  "common": {
    "loading": "Loading…",
    "error": "Error",
    "retry": "Retry",
    "cancel": "Cancel",
    "ok": "OK",
    "copy": "Copy",
    "copied": "Copied",
    "back": "Back",
    "not_found": "Not found",
    "minute_ago": "{{n}} min ago",
    "second_ago": "{{n}} sec ago",
    "hour_ago": "{{n}} hr ago",
    "day_ago": "{{n}} days ago",
    "just_now": "just now"
  }
}
```

- [ ] **Step 3: Write `web/src/i18n.ts`**

```ts
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zhCN from './locales/zh-CN.json'
import en from './locales/en.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      en: { translation: en },
    },
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en'],
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'shepherd-lang',
      caches: ['localStorage'],
    },
  })

export default i18n
```

- [ ] **Step 4: Modify `web/src/main.tsx`** to import i18n

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

- [ ] **Step 5: Type-check**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
```

- [ ] **Step 6: Commit**

```
cd /Users/hg/project/Shepherd
git add web/src/i18n.ts web/src/locales web/src/main.tsx
git commit -m "feat(web): i18n setup with zh-CN default + en fallback"
```

---

### Task 6: zustand stores (auth + ui)

**Files:**
- Create: `web/src/store/auth.ts`, `web/src/store/ui.ts`
- Create: `web/src/store/auth.test.ts`, `web/src/store/ui.test.ts`

- [ ] **Step 1: Write `web/src/store/auth.ts`**

```ts
import { create } from 'zustand'

export type Admin = { id: number; username: string }

type AuthState = {
  admin: Admin | null
  isLoaded: boolean
  setAdmin: (a: Admin | null) => void
  setLoaded: (v: boolean) => void
  clear: () => void
}

export const useAuth = create<AuthState>((set) => ({
  admin: null,
  isLoaded: false,
  setAdmin: (admin) => set({ admin, isLoaded: true }),
  setLoaded: (isLoaded) => set({ isLoaded }),
  clear: () => set({ admin: null }),
}))
```

- [ ] **Step 2: Write `web/src/store/ui.ts`**

```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Lang = 'zh-CN' | 'en'

export type ToastKind = 'info' | 'error' | 'success'
export type Toast = { id: number; kind: ToastKind; message: string }

type UIState = {
  themeMode: ThemeMode
  lang: Lang
  toasts: Toast[]
  setTheme: (m: ThemeMode) => void
  setLang: (l: Lang) => void
  toast: (kind: ToastKind, message: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 1

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      lang: 'zh-CN',
      toasts: [],
      setTheme: (themeMode) => set({ themeMode }),
      setLang: (lang) => set({ lang }),
      toast: (kind, message) =>
        set((s) => ({ toasts: [...s.toasts, { id: toastSeq++, kind, message }] })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: 'shepherd-ui',
      partialize: (s) => ({ themeMode: s.themeMode, lang: s.lang }), // toasts are ephemeral
    },
  ),
)
```

- [ ] **Step 3: Write `web/src/store/auth.test.ts`**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { useAuth } from './auth'

beforeEach(() => {
  useAuth.setState({ admin: null, isLoaded: false })
})

describe('useAuth', () => {
  it('starts unloaded with no admin', () => {
    const s = useAuth.getState()
    expect(s.admin).toBeNull()
    expect(s.isLoaded).toBe(false)
  })

  it('setAdmin marks store loaded', () => {
    useAuth.getState().setAdmin({ id: 1, username: 'alice' })
    const s = useAuth.getState()
    expect(s.admin?.username).toBe('alice')
    expect(s.isLoaded).toBe(true)
  })

  it('clear nulls admin but keeps loaded flag', () => {
    useAuth.getState().setAdmin({ id: 1, username: 'alice' })
    useAuth.getState().clear()
    const s = useAuth.getState()
    expect(s.admin).toBeNull()
    expect(s.isLoaded).toBe(true)
  })
})
```

- [ ] **Step 4: Write `web/src/store/ui.test.ts`**

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { useUI } from './ui'

beforeEach(() => {
  useUI.setState({ themeMode: 'system', lang: 'zh-CN', toasts: [] })
})

describe('useUI', () => {
  it('toast pushes to queue with monotonic ids', () => {
    useUI.getState().toast('info', 'a')
    useUI.getState().toast('error', 'b')
    const ts = useUI.getState().toasts
    expect(ts).toHaveLength(2)
    expect(ts[0].kind).toBe('info')
    expect(ts[1].kind).toBe('error')
    expect(ts[1].id).toBeGreaterThan(ts[0].id)
  })

  it('dismissToast removes by id', () => {
    useUI.getState().toast('info', 'a')
    const id = useUI.getState().toasts[0].id
    useUI.getState().dismissToast(id)
    expect(useUI.getState().toasts).toHaveLength(0)
  })

  it('setTheme + setLang update store', () => {
    useUI.getState().setTheme('dark')
    useUI.getState().setLang('en')
    const s = useUI.getState()
    expect(s.themeMode).toBe('dark')
    expect(s.lang).toBe('en')
  })
})
```

- [ ] **Step 5: Run tests**

```
cd /Users/hg/project/Shepherd/web
npx vitest run
```
Expected: 6 tests pass (3 auth + 3 ui).

- [ ] **Step 6: Commit**

```
cd /Users/hg/project/Shepherd
git add web/src/store
git commit -m "feat(web): zustand auth + ui stores (theme/lang persist to localStorage)"
```

---

## Milestone 3 — Go embed wiring

### Task 7: `internal/web` embed package + dist placeholder + .gitignore

**Files:**
- Create: `internal/web/embed.go`, `internal/web/embed_test.go`, `internal/web/dist/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Create directory + placeholder**

```
mkdir -p /Users/hg/project/Shepherd/internal/web/dist
touch /Users/hg/project/Shepherd/internal/web/dist/.gitkeep
```

- [ ] **Step 2: Update root `.gitignore`**

Append the following lines to `/Users/hg/project/Shepherd/.gitignore`:

```
# Frontend build output (placeholder kept for go:embed)
/internal/web/dist/*
!/internal/web/dist/.gitkeep
```

- [ ] **Step 3: Write `internal/web/embed.go`**

```go
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist/*
var distFS embed.FS

// Handler returns an http.Handler that serves the SPA from internal/web/dist.
// Static assets (paths containing a dot) go through http.FileServer; everything
// else returns index.html so React Router can take over. If the frontend has
// not been built yet (only .gitkeep present), a small placeholder page is
// returned with instructions.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static asset?
		if strings.Contains(strings.TrimPrefix(r.URL.Path, "/"), ".") {
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA fallback.
		b, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(placeholderHTML))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	})
}

const placeholderHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Shepherd</title></head>
<body style="font-family:system-ui;margin:2rem;color:#333;background:#fafafa">
<h1>Shepherd</h1>
<p>Frontend not built yet. Run <code>make web</code> and restart the server.</p>
</body></html>`
```

- [ ] **Step 4: Write `internal/web/embed_test.go`**

```go
package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler_PlaceholderWhenNoIndex(t *testing.T) {
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Frontend not built") {
		t.Errorf("expected placeholder, got %q", w.Body.String())
	}
}

func TestHandler_PlaceholderForAdminPath(t *testing.T) {
	h := Handler()
	w := httptest.NewRecorder()
	// Path without a dot — SPA fallback applies.
	r := httptest.NewRequest("GET", "/admin/login", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Frontend not built") {
		t.Error("expected placeholder for /admin/login when index.html absent")
	}
}

func TestHandler_AssetPathReturns404WhenAbsent(t *testing.T) {
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/assets/missing.js", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d want 404", w.Code)
	}
}
```

- [ ] **Step 5: Run tests**

```
cd /Users/hg/project/Shepherd
go test ./internal/web -v
```
Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```
git add internal/web .gitignore
git commit -m "feat(web): go:embed dist + SPA fallback handler with placeholder"
```

---

### Task 8: Mount web handler in router + cmd/server

**Files:**
- Modify: `internal/api/router.go`
- Modify: `cmd/server/main.go`

- [ ] **Step 1: Modify `internal/api/router.go`** — add a `Web http.Handler` field to `Router`, register a catchall

Replace the `Router` struct definition + `NewRouter` + `Handler()` method. The new shape:

```go
type Router struct {
	Auth     *AuthAPI
	Servers  *ServersAPI
	Settings *SettingsAPI
	Public   *PublicAPI
	Agent    *AgentAPI
	Web      http.Handler // SPA static + fallback; nil = 404 root

	requireAdmin func(http.Handler) http.Handler
}

func NewRouter(authAPI *AuthAPI, requireAdmin func(http.Handler) http.Handler,
	servers *ServersAPI, settings *SettingsAPI, public *PublicAPI, agent *AgentAPI,
	web http.Handler) *Router {
	return &Router{
		Auth: authAPI, Servers: servers, Settings: settings, Public: public, Agent: agent,
		Web:          web,
		requireAdmin: requireAdmin,
	}
}
```

In `Handler()`, after the existing routes are registered (and BEFORE the `return mux` line), add:

```go
	// SPA static + fallback. The /api/ catchall above already swallows /api/*; the
	// /agent/* exact patterns swallow agent paths. Anything else falls through here.
	if r.Web != nil {
		mux.Handle("/", r.Web)
	}
```

- [ ] **Step 2: Modify `cmd/server/main.go`** — pass the web handler to `NewRouter`

Find the `import` block. Add:

```go
	shepweb "github.com/hg-claw/Shepherd/internal/web"
```

Find the call to `api.NewRouter(...)`. Add `shepweb.Handler()` as the final arg:

```go
	router := api.NewRouter(authAPI, authH.RequireAdmin, servers, settings, public, agentAPI, shepweb.Handler())
```

- [ ] **Step 3: Verify build + smoke**

```
cd /Users/hg/project/Shepherd
go build ./...
go test ./internal/api ./internal/web
```
Expected: build clean, all tests pass.

Manual smoke:
```
go run ./cmd/server &
SERVER_PID=$!
sleep 1
curl -s http://localhost:8080/ | head -3
# expect: HTML containing "Frontend not built yet" or actual index.html if you've run `make web` before
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/public/servers
# expect: 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/admin/dashboard
# expect: 200 (SPA fallback returns the placeholder, not 404)
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
```

- [ ] **Step 4: Commit**

```
git add internal/api/router.go cmd/server/main.go
git commit -m "feat(server): mount internal/web handler at / for SPA + static"
```

---

### Task 9: Makefile updates

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Replace the existing `Makefile` content with**

```make
.PHONY: web web-clean server server-no-web agent test test-go test-web fmt vet tidy

web:
	cd web && npm install && npm run build

web-clean:
	rm -rf internal/web/dist
	mkdir -p internal/web/dist
	touch internal/web/dist/.gitkeep

# Build the server binary. Builds the frontend first to embed real dist
# content; if you don't have npm available, use `make server-no-web`.
server: web
	go build -o bin/shepherd-server ./cmd/server

# For environments without npm (CI go-only runs, quick iteration):
server-no-web:
	go build -o bin/shepherd-server ./cmd/server

agent:
	go build -o bin/shepherd-agent ./cmd/agent

test: test-go test-web

test-go:
	go test ./...

test-web:
	cd web && npm test

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy
```

- [ ] **Step 2: Verify the targets build**

```
cd /Users/hg/project/Shepherd
make server-no-web
ls -lh bin/shepherd-server
make agent
ls -lh bin/shepherd-agent
make vet
```
Expected: both binaries built, vet clean.

> Don't run `make web` here — it would `npm install` 200+ packages just to verify Make wiring. The web build will be exercised when there's actual code (Task 10 onward).

- [ ] **Step 3: Commit**

```
git add Makefile
git commit -m "build: add web target, server depends on web, server-no-web for CI"
```

---

## Milestone 4 — Foundational frontend libs

### Task 10: shadcn/ui CLI init + add base components

**Files:**
- Create: `web/components.json` (created by shadcn CLI)
- Create: `web/src/lib/utils.ts` (created by shadcn CLI; we replace its content in Task 11)
- Create: `web/src/components/ui/{button,card,input,label,select,table,dialog,toast,tabs,dropdown-menu,sheet,badge,progress,separator,switch,tooltip}.tsx` (created by shadcn CLI)

- [ ] **Step 1: Run shadcn init**

```
cd /Users/hg/project/Shepherd/web
npx shadcn@latest init -d --base-color slate
```

This is interactive in the worst case. Use `-d` (defaults) to suppress prompts. The CLI writes:
- `components.json`
- `src/lib/utils.ts` (with `cn(...inputs: ClassValue[])`)
- May add tailwind layers — verify against ours (we already have CSS variables; CLI should detect and not overwrite).

If `components.json` doesn't get a sensible default, write it manually:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/index.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils"
  },
  "iconLibrary": "lucide"
}
```

- [ ] **Step 2: Add the 16 components we'll use**

```
cd /Users/hg/project/Shepherd/web
npx shadcn@latest add -y button card input label select table dialog toast tabs dropdown-menu sheet badge progress separator switch tooltip
```

This installs:
- The component files under `src/components/ui/`
- The corresponding `@radix-ui/*` primitives via npm (the CLI handles npm install for each)

If the CLI prompts ("which framework / overwrite", etc.), accept the defaults that match the `components.json` above.

- [ ] **Step 3: Verify type-check passes**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
```
Expected: clean. If shadcn used React types not yet installed, install them (`npm install --save-dev @types/react@latest`).

- [ ] **Step 4: Commit**

```
cd /Users/hg/project/Shepherd
git add web/components.json web/src/components/ui web/src/lib/utils.ts web/package.json web/package-lock.json
git commit -m "chore(web): shadcn/ui init + 16 base components (button/card/input/...)"
```

---

### Task 11: lib helpers (bytes / time / thresholds / country)

**Files:**
- Modify: `web/src/lib/utils.ts` (keep shadcn's `cn`, this task only confirms it)
- Create: `web/src/lib/bytes.ts`, `web/src/lib/time.ts`, `web/src/lib/thresholds.ts`, `web/src/lib/country.ts`
- Create: `web/src/lib/bytes.test.ts`, `web/src/lib/time.test.ts`, `web/src/lib/thresholds.test.ts`, `web/src/lib/country.test.ts`

- [ ] **Step 1: Write `web/src/lib/bytes.ts`**

```ts
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
const BPS_UNITS = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s']

function humanScale(n: number, units: string[]): string {
  if (!isFinite(n) || n < 0) return '-'
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return '-'
  return humanScale(n, BYTE_UNITS)
}

export function bps(n: number | null | undefined): string {
  if (n == null) return '-'
  return humanScale(n, BPS_UNITS)
}

export function pct(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || total <= 0) return null
  return (used / total) * 100
}
```

- [ ] **Step 2: Write `web/src/lib/bytes.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { bps, bytes, pct } from './bytes'

describe('bytes', () => {
  it('handles small bytes', () => {
    expect(bytes(0)).toBe('0 B')
    expect(bytes(512)).toBe('512 B')
    expect(bytes(1023)).toBe('1023 B')
  })
  it('scales to KB/MB/GB', () => {
    expect(bytes(1024)).toBe('1.0 KB')
    expect(bytes(1024 * 1024)).toBe('1.0 MB')
    expect(bytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
  it('returns dash for null', () => {
    expect(bytes(null)).toBe('-')
    expect(bytes(undefined)).toBe('-')
  })
})

describe('bps', () => {
  it('uses B/s units', () => {
    expect(bps(1024)).toBe('1.0 KB/s')
    expect(bps(0)).toBe('0 B/s')
  })
})

describe('pct', () => {
  it('computes percentage', () => {
    expect(pct(50, 100)).toBe(50)
    expect(pct(1, 4)).toBe(25)
  })
  it('returns null for invalid inputs', () => {
    expect(pct(null, 100)).toBeNull()
    expect(pct(50, 0)).toBeNull()
    expect(pct(50, null)).toBeNull()
  })
})
```

- [ ] **Step 3: Write `web/src/lib/time.ts`**

```ts
export type RelativeKey =
  | 'common.just_now'
  | 'common.second_ago'
  | 'common.minute_ago'
  | 'common.hour_ago'
  | 'common.day_ago'

/**
 * relativeTime returns the i18next key + the `n` value for templating.
 * Caller does t(key, { n }).
 */
export function relativeTime(when: Date | string | null | undefined, now: Date = new Date()): { key: RelativeKey; n: number } | null {
  if (when == null) return null
  const t = typeof when === 'string' ? new Date(when) : when
  if (isNaN(t.getTime())) return null
  const seconds = Math.max(0, Math.floor((now.getTime() - t.getTime()) / 1000))
  if (seconds < 5) return { key: 'common.just_now', n: 0 }
  if (seconds < 60) return { key: 'common.second_ago', n: seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { key: 'common.minute_ago', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { key: 'common.hour_ago', n: hours }
  const days = Math.floor(hours / 24)
  return { key: 'common.day_ago', n: days }
}

export function formatHHMM(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}
```

- [ ] **Step 4: Write `web/src/lib/time.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { formatHHMM, relativeTime } from './time'

const fixedNow = new Date('2026-05-06T12:00:00Z')

describe('relativeTime', () => {
  it('null/invalid returns null', () => {
    expect(relativeTime(null, fixedNow)).toBeNull()
    expect(relativeTime('not-a-date', fixedNow)).toBeNull()
  })
  it('within 5 seconds → just_now', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 1000), fixedNow)).toEqual({
      key: 'common.just_now',
      n: 0,
    })
  })
  it('seconds bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 30_000), fixedNow)).toEqual({
      key: 'common.second_ago',
      n: 30,
    })
  })
  it('minutes bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 5 * 60_000), fixedNow)).toEqual({
      key: 'common.minute_ago',
      n: 5,
    })
  })
  it('hours bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 3 * 3600_000), fixedNow)).toEqual({
      key: 'common.hour_ago',
      n: 3,
    })
  })
  it('days bucket', () => {
    expect(relativeTime(new Date(fixedNow.getTime() - 2 * 86400_000), fixedNow)).toEqual({
      key: 'common.day_ago',
      n: 2,
    })
  })
})

describe('formatHHMM', () => {
  it('zero-pads', () => {
    expect(formatHHMM(new Date(2026, 4, 6, 7, 5))).toBe('07:05')
  })
})
```

- [ ] **Step 5: Write `web/src/lib/thresholds.ts`** (spec §9.4)

```ts
export type Level = 'low' | 'mid' | 'high' | 'alert'

export type Metric = 'cpu' | 'mem' | 'disk' | 'net'

const cpuMemDisk: Record<'cpu' | 'mem' | 'disk', [number, number, number]> = {
  // boundaries (inclusive lower bound for next level): [low<x, mid<x, high<x] (≥last → alert)
  cpu: [40, 70, 90],
  mem: [50, 75, 90],
  disk: [60, 80, 90],
}

// NET uses bytes-per-second; level boundaries in MB/s
const NET_LOW_MBPS = 10
const NET_MID_MBPS = 50
const NET_HIGH_MBPS = 200

export function levelForPct(metric: 'cpu' | 'mem' | 'disk', pct: number | null | undefined): Level {
  if (pct == null) return 'low'
  const [a, b, c] = cpuMemDisk[metric]
  if (pct < a) return 'low'
  if (pct < b) return 'mid'
  if (pct < c) return 'high'
  return 'alert'
}

export function levelForNetBps(rxBps: number, txBps: number): Level {
  const mbps = Math.max(rxBps, txBps) / (1024 * 1024)
  if (mbps < NET_LOW_MBPS) return 'low'
  if (mbps < NET_MID_MBPS) return 'mid'
  if (mbps < NET_HIGH_MBPS) return 'high'
  return 'alert'
}

export const levelClass: Record<Level, string> = {
  low: 'bg-level-low text-white',
  mid: 'bg-level-mid text-black',
  high: 'bg-level-high text-white',
  alert: 'bg-level-alert text-white',
}
```

- [ ] **Step 6: Write `web/src/lib/thresholds.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { levelForNetBps, levelForPct } from './thresholds'

describe('levelForPct', () => {
  it('cpu boundaries', () => {
    expect(levelForPct('cpu', 0)).toBe('low')
    expect(levelForPct('cpu', 39.99)).toBe('low')
    expect(levelForPct('cpu', 40)).toBe('mid')
    expect(levelForPct('cpu', 69.99)).toBe('mid')
    expect(levelForPct('cpu', 70)).toBe('high')
    expect(levelForPct('cpu', 89.99)).toBe('high')
    expect(levelForPct('cpu', 90)).toBe('alert')
    expect(levelForPct('cpu', 100)).toBe('alert')
  })
  it('mem and disk pull from their own tables', () => {
    expect(levelForPct('mem', 49.99)).toBe('low')
    expect(levelForPct('mem', 50)).toBe('mid')
    expect(levelForPct('disk', 59.99)).toBe('low')
    expect(levelForPct('disk', 60)).toBe('mid')
  })
  it('null → low', () => {
    expect(levelForPct('cpu', null)).toBe('low')
  })
})

describe('levelForNetBps', () => {
  const MB = 1024 * 1024
  it('uses max of rx/tx', () => {
    expect(levelForNetBps(0, 5 * MB)).toBe('low')
    expect(levelForNetBps(11 * MB, 0)).toBe('mid')
    expect(levelForNetBps(0, 51 * MB)).toBe('high')
    expect(levelForNetBps(201 * MB, 0)).toBe('alert')
  })
})
```

- [ ] **Step 7: Write `web/src/lib/country.ts`**

```ts
/**
 * Convert ISO 3166-1 alpha-2 code to a flag emoji using regional indicator chars.
 * Returns empty string for invalid input.
 */
export function flagEmoji(code: string | null | undefined): string {
  if (!code || code.length !== 2) return ''
  const upper = code.toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return ''
  const A = 0x41
  const RI = 0x1f1e6
  const c1 = RI + (upper.charCodeAt(0) - A)
  const c2 = RI + (upper.charCodeAt(1) - A)
  return String.fromCodePoint(c1, c2)
}
```

- [ ] **Step 8: Write `web/src/lib/country.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { flagEmoji } from './country'

describe('flagEmoji', () => {
  it('converts known codes', () => {
    expect(flagEmoji('US')).toBe('🇺🇸')
    expect(flagEmoji('hk')).toBe('🇭🇰')
    expect(flagEmoji('JP')).toBe('🇯🇵')
  })
  it('rejects invalid input', () => {
    expect(flagEmoji('')).toBe('')
    expect(flagEmoji(null)).toBe('')
    expect(flagEmoji('USA')).toBe('')
    expect(flagEmoji('1A')).toBe('')
  })
})
```

- [ ] **Step 9: Run + commit**

```
cd /Users/hg/project/Shepherd/web
npx vitest run
```
Expected: ~22 tests pass.

```
cd /Users/hg/project/Shepherd
git add web/src/lib
git commit -m "feat(web): lib helpers (bytes, relative time, level thresholds, country flag)"
```

---

### Task 12: API client + auth/servers/public/settings hooks

**Files:**
- Create: `web/src/api/client.ts`, `web/src/api/auth.ts`, `web/src/api/servers.ts`, `web/src/api/public.ts`, `web/src/api/settings.ts`
- Create: `web/src/api/client.test.ts`

- [ ] **Step 1: Write `web/src/api/client.ts`**

```ts
export class APIError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type ApiOptions = {
  signal?: AbortSignal
  on401?: () => void
}

let on401Handler: () => void = () => {}
export function setOn401(fn: () => void) {
  on401Handler = fn
}

async function request<T>(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'include',
    signal: opts?.signal,
  }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(path, init)
  if (res.status === 401) {
    on401Handler()
    throw new APIError(401, 'unauthorized')
  }
  if (res.status === 204) {
    return undefined as T
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = res.statusText
    try {
      const j = text ? JSON.parse(text) : null
      if (j?.error) msg = j.error
    } catch {
      // ignore
    }
    throw new APIError(res.status, msg)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export const api = {
  get: <T>(path: string, opts?: ApiOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: ApiOptions) => request<T>('POST', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: ApiOptions) => request<T>('PATCH', path, body, opts),
  delete: <T>(path: string, opts?: ApiOptions) => request<T>('DELETE', path, undefined, opts),
}
```

- [ ] **Step 2: Write `web/src/api/client.test.ts`** (mock global fetch)

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, APIError, setOn401 } from './client'

const origFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})
afterEach(() => {
  globalThis.fetch = origFetch
})

function mockResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('api.get', () => {
  it('parses JSON', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(mockResponse({ ok: true }))
    const out = await api.get<{ ok: boolean }>('/api/x')
    expect(out).toEqual({ ok: true })
  })

  it('throws APIError with body.error message', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(mockResponse({ error: 'bad creds' }, 401))
    let caught: APIError | undefined
    let triggered = false
    setOn401(() => (triggered = true))
    try {
      await api.get('/api/login')
    } catch (e) {
      caught = e as APIError
    }
    expect(caught?.status).toBe(401)
    expect(triggered).toBe(true)
  })
})

describe('api.post', () => {
  it('204 returns undefined', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(Promise.resolve(new Response(null, { status: 204 })))
    const out = await api.post<void>('/api/x')
    expect(out).toBeUndefined()
  })
})
```

- [ ] **Step 3: Write `web/src/api/auth.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { Admin } from '@/store/auth'

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Admin>('/api/admins/me')
      } catch (e: any) {
        if (e?.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      api.post<Admin>('/api/login', input),
    onSuccess: (admin) => {
      qc.setQueryData(['me'], admin)
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/api/logout'),
    onSuccess: () => {
      qc.setQueryData(['me'], null)
      qc.invalidateQueries()
    },
  })
}
```

- [ ] **Step 4: Write `web/src/api/servers.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export type ServerRecord = {
  id: number
  name: string
  public_alias: { Valid: boolean; String: string } | null
  public_group: { Valid: boolean; String: string } | null
  country_code: { Valid: boolean; String: string } | null
  show_on_public: boolean
  ssh_host: { Valid: boolean; String: string } | null
  ssh_port: number
  ssh_user: { Valid: boolean; String: string } | null
  install_stage: 'pending' | 'installing' | 'done' | 'failed'
  install_log: string
  install_error: { Valid: boolean; String: string } | null
  install_started_at: { Valid: boolean; Time: string } | null
  agent_version: { Valid: boolean; String: string } | null
  agent_os: { Valid: boolean; String: string } | null
  agent_arch: { Valid: boolean; String: string } | null
  agent_kernel: { Valid: boolean; String: string } | null
  agent_last_seen: { Valid: boolean; Time: string } | null
  agent_fingerprint: { Valid: boolean; String: string } | null
  created_at: string
}

export type Latest = {
  ts: string
  cpu_pct?: number
  mem_used?: number
  mem_total?: number
  load_1?: number
  net_rx_bps?: number
  net_tx_bps?: number
  tcp_conn?: number
  disks_json?: string
}

export type ServerWithLatest = ServerRecord & { latest: Latest | null }

export function useServers(opts?: { withLatest?: boolean; refetchInterval?: number }) {
  const path = opts?.withLatest ? '/api/servers?with=latest' : '/api/servers'
  return useQuery({
    queryKey: opts?.withLatest ? ['servers', 'with-latest'] : ['servers'],
    queryFn: () => api.get<ServerWithLatest[]>(path),
    refetchInterval: opts?.refetchInterval,
  })
}

export function useServer(
  id: number,
  opts?: { refetchInterval?: number | ((q: any) => number | false) },
) {
  return useQuery({
    queryKey: ['server', id],
    queryFn: () => api.get<ServerRecord>(`/api/servers/${id}`),
    refetchInterval: opts?.refetchInterval,
    enabled: !!id,
  })
}

export type Range = '1h' | '24h' | '7d'

export type Point = {
  ts: string
  cpu_pct?: number
  mem_used?: number
  mem_total?: number
  load_1?: number
  net_rx_bps?: number
  net_tx_bps?: number
  tcp_conn?: number
  disks_json?: string
}

export function useTelemetry(id: number, range: Range, isPublic: boolean) {
  const path = isPublic
    ? `/api/public/servers/${id}/telemetry?range=${range}`
    : `/api/servers/${id}/telemetry?range=${range}`
  return useQuery({
    queryKey: [isPublic ? 'public-telemetry' : 'admin-telemetry', id, range],
    queryFn: () => api.get<Point[]>(path),
    staleTime: range === '1h' ? 30_000 : range === '24h' ? 5 * 60_000 : 30 * 60_000,
    enabled: !!id,
  })
}

export type InstallInput = {
  name: string
  ssh_host: string
  ssh_port?: number
  ssh_user: string
  ssh_password?: string
  ssh_key?: string
  arch: 'amd64' | 'arm64'
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public?: boolean
}

export function useInstall() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: InstallInput) =>
      api.post<{ server_id: number }>('/api/servers/install', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export type PatchInput = {
  name?: string
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public?: boolean
}

export function usePatchServer(id: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PatchInput) => api.patch<ServerRecord>(`/api/servers/${id}`, input),
    onSuccess: (data) => {
      qc.setQueryData(['server', id], data)
      qc.invalidateQueries({ queryKey: ['servers'] })
    },
  })
}

export function useDeleteServer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/api/servers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['servers'] }),
  })
}

export function useRepair(id: number) {
  return useMutation({
    mutationFn: () => api.post<{ enrollment_token: string; expires_at: string }>(`/api/servers/${id}/repair`),
  })
}

export function usePushConfig(id: number) {
  return useMutation({
    mutationFn: (input: { telemetry_interval_seconds: number }) =>
      api.post<void>(`/api/servers/${id}/config`, input),
  })
}
```

- [ ] **Step 5: Write `web/src/api/public.ts`**

```ts
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Point, Range } from './servers'

export type PublicCard = {
  id: number
  alias: string
  group: string
  country_code: string
  online: boolean
  latest?: {
    ts: string
    cpu_pct: number
    mem_pct: number
    disks_pct: number[]
    net_rx_bps: number
    net_tx_bps: number
    load_1: number
    tcp_conn: number
  }
}

export function usePublicServers() {
  return useQuery({
    queryKey: ['public-servers'],
    queryFn: () => api.get<PublicCard[]>('/api/public/servers'),
    refetchInterval: 30_000,
  })
}

export function usePublicSettings() {
  return useQuery({
    queryKey: ['public-settings'],
    queryFn: () => api.get<{ public_display_mode: 'raw' | 'level' | 'both' }>('/api/public/settings'),
    staleTime: 5 * 60_000,
  })
}

export function usePublicTelemetry(id: number, range: Range) {
  return useQuery({
    queryKey: ['public-telemetry', id, range],
    queryFn: () => api.get<Point[]>(`/api/public/servers/${id}/telemetry?range=${range}`),
    staleTime: range === '1h' ? 30_000 : range === '24h' ? 5 * 60_000 : 30 * 60_000,
    enabled: !!id,
  })
}
```

- [ ] **Step 6: Write `web/src/api/settings.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export type Settings = Record<string, string>

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
    staleTime: 5 * 60_000,
  })
}

export function usePatchSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Settings>) => api.patch<Settings>('/api/settings', input),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  })
}
```

- [ ] **Step 7: Run + commit**

```
cd /Users/hg/project/Shepherd/web
npx vitest run
npx tsc -b --noEmit
```
Expected: tests still pass; type-check clean.

```
cd /Users/hg/project/Shepherd
git add web/src/api
git commit -m "feat(web): API client + react-query hooks (auth, servers, public, settings)"
```

---

### Task 13: Custom components (OnlineDot, CountryFlag, ThemeToggle, LangToggle, MetricBadge, Sparkline)

**Files:**
- Create: `web/src/components/OnlineDot.tsx`, `web/src/components/CountryFlag.tsx`, `web/src/components/ThemeToggle.tsx`, `web/src/components/LangToggle.tsx`, `web/src/components/MetricBadge.tsx`, `web/src/components/Sparkline.tsx`, `web/src/components/Toaster.tsx`
- Create: `web/src/components/MetricBadge.test.tsx`, `web/src/components/Sparkline.test.tsx`
- Create: `web/src/test-utils/render.tsx`

- [ ] **Step 1: `web/src/test-utils/render.tsx`** — RTL render wrapped with QueryClient + I18nextProvider

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement, ReactNode } from 'react'
import i18n from '@/i18n'

export function renderWithProviders(ui: ReactElement, options: RenderOptions & { initialPath?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[options.initialPath ?? '/']}>{children}</MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper, ...options })
}
```

- [ ] **Step 2: `web/src/components/OnlineDot.tsx`**

```tsx
import { useTranslation } from 'react-i18next'

export function OnlineDot({ online }: { online: boolean }) {
  const { t } = useTranslation()
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${online ? 'bg-level-low' : 'bg-level-alert'}`}
      title={online ? t('wall.online') : t('wall.offline')}
      aria-label={online ? t('wall.online') : t('wall.offline')}
    />
  )
}
```

- [ ] **Step 3: `web/src/components/CountryFlag.tsx`**

```tsx
import { flagEmoji } from '@/lib/country'

export function CountryFlag({ code }: { code: string | null | undefined }) {
  const emoji = flagEmoji(code)
  if (!emoji) return null
  return <span aria-hidden>{emoji}</span>
}
```

- [ ] **Step 4: `web/src/components/ThemeToggle.tsx`**

```tsx
import { Moon, Sun, Laptop } from 'lucide-react'
import { useEffect } from 'react'
import { useUI } from '@/store/ui'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu'

export function ThemeToggle() {
  const { themeMode, setTheme } = useUI()

  useEffect(() => {
    const apply = () => {
      const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      const dark = themeMode === 'dark' || (themeMode === 'system' && sysDark)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    if (themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
  }, [themeMode])

  const Icon = themeMode === 'dark' ? Moon : themeMode === 'light' ? Sun : Laptop

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="theme">
          <Icon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}>
          <Sun className="mr-2 h-4 w-4" /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}>
          <Moon className="mr-2 h-4 w-4" /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}>
          <Laptop className="mr-2 h-4 w-4" /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 5: `web/src/components/LangToggle.tsx`**

```tsx
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useUI } from '@/store/ui'
import { Button } from './ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from './ui/dropdown-menu'

export function LangToggle() {
  const { lang, setLang } = useUI()
  const { i18n } = useTranslation()

  const change = (l: 'zh-CN' | 'en') => {
    setLang(l)
    i18n.changeLanguage(l)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="language">
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => change('zh-CN')}>
          {lang === 'zh-CN' ? '✓ ' : ''}中文
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => change('en')}>
          {lang === 'en' ? '✓ ' : ''}English
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 6: `web/src/components/MetricBadge.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { levelClass, levelForNetBps, levelForPct, type Level, type Metric } from '@/lib/thresholds'
import { bps } from '@/lib/bytes'
import { cn } from '@/lib/utils'

export type DisplayMode = 'raw' | 'level' | 'both'

type CommonProps = {
  metric: Metric
  mode: DisplayMode
  className?: string
}

type PctProps = CommonProps & { kind: 'pct'; value: number | null | undefined }
type NetProps = CommonProps & { kind: 'net'; rxBps: number; txBps: number }

export function MetricBadge(props: PctProps | NetProps) {
  const { t } = useTranslation()
  const { mode, metric, className } = props

  let level: Level
  let raw: string
  if (props.kind === 'net') {
    level = levelForNetBps(props.rxBps, props.txBps)
    raw = `↓ ${bps(props.rxBps)}  ↑ ${bps(props.txBps)}`
  } else {
    level = levelForPct(metric as 'cpu' | 'mem' | 'disk', props.value ?? null)
    raw = props.value == null ? '-' : `${props.value.toFixed(0)}%`
  }
  const levelLabel = t(`level.${level}`)

  if (mode === 'raw') {
    return <span className={cn('font-mono', className)}>{raw}</span>
  }
  if (mode === 'level') {
    return (
      <span className={cn('inline-flex rounded px-2 py-0.5 text-xs', levelClass[level], className)}>
        {levelLabel}
      </span>
    )
  }
  // both
  return (
    <span className={cn('inline-flex items-center gap-2 font-mono', className)}>
      <span>{raw}</span>
      <span className={cn('rounded px-2 py-0.5 text-xs', levelClass[level])}>{levelLabel}</span>
    </span>
  )
}
```

- [ ] **Step 7: `web/src/components/MetricBadge.test.tsx`**

```tsx
import { describe, expect, it } from 'vitest'
import { renderWithProviders } from '@/test-utils/render'
import { MetricBadge } from './MetricBadge'

describe('MetricBadge', () => {
  it('renders raw percentage', () => {
    const { getByText } = renderWithProviders(
      <MetricBadge metric="cpu" mode="raw" kind="pct" value={42} />,
    )
    expect(getByText('42%')).toBeInTheDocument()
  })

  it('renders level label', () => {
    const { container } = renderWithProviders(
      <MetricBadge metric="cpu" mode="level" kind="pct" value={95} />,
    )
    expect(container.textContent).toContain('告警') // zh-CN default; "alert" if you switch lang
  })

  it('both mode shows raw + level', () => {
    const { container } = renderWithProviders(
      <MetricBadge metric="cpu" mode="both" kind="pct" value={50} />,
    )
    expect(container.textContent).toContain('50%')
  })

  it('null value renders dash in raw mode', () => {
    const { getByText } = renderWithProviders(
      <MetricBadge metric="cpu" mode="raw" kind="pct" value={null} />,
    )
    expect(getByText('-')).toBeInTheDocument()
  })
})
```

- [ ] **Step 8: `web/src/components/Sparkline.tsx`**

```tsx
type Props = {
  values: number[]
  width?: number
  height?: number
  className?: string
  ariaLabel?: string
}

export function Sparkline({ values, width = 80, height = 24, className, ariaLabel }: Props) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel} />
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const dx = width / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = i * dx
      const y = height - ((v - min) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel}>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  )
}
```

- [ ] **Step 9: `web/src/components/Sparkline.test.tsx`**

```tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from './Sparkline'

describe('Sparkline', () => {
  it('renders empty svg with <2 points', () => {
    const { container } = render(<Sparkline values={[5]} />)
    expect(container.querySelector('polyline')).toBeNull()
  })
  it('renders polyline with 2+ points', () => {
    const { container } = render(<Sparkline values={[1, 2, 3]} />)
    const poly = container.querySelector('polyline')
    expect(poly).not.toBeNull()
    expect(poly?.getAttribute('points')?.split(' ').length).toBe(3)
  })
})
```

- [ ] **Step 10: `web/src/components/Toaster.tsx`** — wires the zustand toast queue to shadcn `Toast`

```tsx
import { useEffect } from 'react'
import { useToast } from './ui/use-toast' // shadcn-generated
import { useUI } from '@/store/ui'

export function Toaster() {
  const { toasts, dismissToast } = useUI()
  const { toast: shadcnToast } = useToast()

  useEffect(() => {
    for (const t of toasts) {
      shadcnToast({
        title: t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Success' : 'Info',
        description: t.message,
        variant: t.kind === 'error' ? 'destructive' : 'default',
      })
      dismissToast(t.id)
    }
  }, [toasts, shadcnToast, dismissToast])

  return null
}
```

> **Note:** shadcn's `toast` add includes a `<Toaster />` component (under `ui/toaster.tsx`) and `use-toast` hook. The `Toaster` in this file is a different name; rename it to `ToastBridge` if it conflicts. Check the generated file paths (`web/src/components/ui/toaster.tsx`, `use-toast.tsx`). If shadcn's Toaster is named `Toaster`, rename ours to `ToastBridge`:

If conflict, replace with:

```tsx
// web/src/components/ToastBridge.tsx
import { useEffect } from 'react'
import { useToast } from './ui/use-toast'
import { useUI } from '@/store/ui'

export function ToastBridge() {
  const { toasts, dismissToast } = useUI()
  const { toast: shadcnToast } = useToast()
  useEffect(() => {
    for (const t of toasts) {
      shadcnToast({
        title: t.kind === 'error' ? 'Error' : t.kind === 'success' ? 'Success' : 'Info',
        description: t.message,
        variant: t.kind === 'error' ? 'destructive' : 'default',
      })
      dismissToast(t.id)
    }
  }, [toasts, shadcnToast, dismissToast])
  return null
}
```

The implementer will pick whichever name doesn't collide. Document the choice in the commit message.

- [ ] **Step 11: Run + commit**

```
cd /Users/hg/project/Shepherd/web
npx vitest run
npx tsc -b --noEmit
```

```
cd /Users/hg/project/Shepherd
git add web/src/components web/src/test-utils
git commit -m "feat(web): foundational components (OnlineDot, CountryFlag, theme/lang toggles, MetricBadge, Sparkline, ToastBridge)"
```

---

## Milestone 5 — Routing + auth flow

### Task 14: App router + RequireAdmin + main bootstrap

**Files:**
- Modify: `web/src/main.tsx`
- Replace: `web/src/App.tsx`
- Create: `web/src/components/RequireAdmin.tsx`
- Create: `web/src/pages/NotFound.tsx`

- [ ] **Step 1: `web/src/components/RequireAdmin.tsx`**

```tsx
import { Navigate } from 'react-router-dom'
import { useMe } from '@/api/auth'
import { useEffect } from 'react'
import { useAuth } from '@/store/auth'
import type { ReactNode } from 'react'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe()
  const { setAdmin, setLoaded } = useAuth()

  useEffect(() => {
    if (!isLoading) {
      setAdmin(data ?? null)
      setLoaded(true)
    }
  }, [data, isLoading, setAdmin, setLoaded])

  if (isLoading) return null
  if (!data) return <Navigate to="/admin/login" replace />
  return <>{children}</>
}
```

- [ ] **Step 2: `web/src/pages/NotFound.tsx`**

```tsx
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export function NotFound() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-muted-foreground">{t('common.not_found')}</p>
      <Link to="/" className="text-primary underline">
        {t('common.back')}
      </Link>
    </div>
  )
}

export default NotFound
```

- [ ] **Step 3: `web/src/App.tsx`** — full router

```tsx
import { Suspense, lazy } from 'react'
import { Routes, Route } from 'react-router-dom'
import { RequireAdmin } from './components/RequireAdmin'

// Lazy pages — keeps main bundle small. Replace placeholder when each page lands.
const Wall = lazy(() => import('./pages/public/Wall'))
const PublicServerDetail = lazy(() => import('./pages/public/ServerDetail'))
const Login = lazy(() => import('./pages/admin/Login'))
const Dashboard = lazy(() => import('./pages/admin/Dashboard'))
const ServerList = lazy(() => import('./pages/admin/ServerList'))
const ServerNew = lazy(() => import('./pages/admin/ServerNew'))
const AdminServerDetail = lazy(() => import('./pages/admin/ServerDetail'))
const Settings = lazy(() => import('./pages/admin/Settings'))
const NotFound = lazy(() => import('./pages/NotFound'))

import { PublicLayout } from './layouts/PublicLayout'
import { AdminLayout } from './layouts/AdminLayout'

export default function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route path="/" element={<Wall />} />
          <Route path="/public/servers/:id" element={<PublicServerDetail />} />
        </Route>

        <Route path="/admin/login" element={<Login />} />

        <Route
          element={
            <RequireAdmin>
              <AdminLayout />
            </RequireAdmin>
          }
        >
          <Route path="/admin/dashboard" element={<Dashboard />} />
          <Route path="/admin/servers" element={<ServerList />} />
          <Route path="/admin/servers/new" element={<ServerNew />} />
          <Route path="/admin/servers/:id" element={<AdminServerDetail />} />
          <Route path="/admin/settings" element={<Settings />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  )
}
```

- [ ] **Step 4: Replace `web/src/main.tsx` with full bootstrap**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'
import './i18n'
import i18n from './i18n'
import { useUI } from './store/ui'
import { setOn401 } from './api/client'
import { useAuth } from './store/auth'
import { Toaster as ShadcnToaster } from './components/ui/toaster'
import { ToastBridge } from './components/ToastBridge'

// Sync stored language to i18next on startup.
const stored = useUI.getState().lang
i18n.changeLanguage(stored)

// 401 handler: clear auth + redirect by full reload to /admin/login.
setOn401(() => {
  useAuth.getState().clear()
  if (window.location.pathname.startsWith('/admin') && window.location.pathname !== '/admin/login') {
    window.location.assign('/admin/login')
  }
})

const qc = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
        <ShadcnToaster />
        <ToastBridge />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
```

> The ToastBridge import path (`./components/ToastBridge`) assumes the file we created in Task 13 was named that way. Adjust if the implementer chose a different name.

- [ ] **Step 5: Stub-out the page files** so `npm run build` works. Create empty default-export components for any page not yet fleshed out:

```tsx
// web/src/pages/public/Wall.tsx
export default function Wall() {
  return <div className="p-8">Wall (stub — Task 17)</div>
}
```

Make similar one-liner stubs for: `web/src/pages/public/ServerDetail.tsx`, `web/src/pages/admin/Login.tsx`, `web/src/pages/admin/Dashboard.tsx`, `web/src/pages/admin/ServerList.tsx`, `web/src/pages/admin/ServerNew.tsx`, `web/src/pages/admin/ServerDetail.tsx`, `web/src/pages/admin/Settings.tsx`.

Each stub:
```tsx
export default function ComponentName() {
  return <div className="p-8">ComponentName (stub — Task XX)</div>
}
```

Adjust ComponentName per file. These stubs will be replaced in later tasks.

- [ ] **Step 6: Stub layouts so router compiles**

```tsx
// web/src/layouts/PublicLayout.tsx (Task 15 fills it in)
import { Outlet } from 'react-router-dom'
export function PublicLayout() {
  return <Outlet />
}
```

```tsx
// web/src/layouts/AdminLayout.tsx (Task 15 fills it in)
import { Outlet } from 'react-router-dom'
export function AdminLayout() {
  return <Outlet />
}
```

- [ ] **Step 7: Type-check + build**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
npm run build
```
Expected: clean. Build output written to `internal/web/dist/` (replacing `.gitkeep`).

- [ ] **Step 8: Smoke (full stack)**

```
cd /Users/hg/project/Shepherd
make server-no-web   # already-built dist embedded
./bin/shepherd-server &
SERVER_PID=$!
sleep 1
curl -s http://localhost:8080/ | head -1
# expect: HTML containing the React app
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/admin/dashboard
# expect: 200 (SPA fallback), HTML
curl -sf http://localhost:8080/api/public/servers
# expect: []
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
```

- [ ] **Step 9: Commit**

```
git add web/src
git commit -m "feat(web): App router + RequireAdmin + main bootstrap with QueryClient/Router/i18n/Toasters"
```

---

### Task 15: Layouts (PublicLayout + AdminLayout)

**Files:**
- Replace: `web/src/layouts/PublicLayout.tsx`, `web/src/layouts/AdminLayout.tsx`

- [ ] **Step 1: `web/src/layouts/PublicLayout.tsx`**

```tsx
import { Outlet, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

export function PublicLayout() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <Link to="/" className="font-semibold">
            {t('app.name')}
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="container flex-1 py-6">
        <Outlet />
      </main>
    </div>
  )
}
```

- [ ] **Step 2: `web/src/layouts/AdminLayout.tsx`**

```tsx
import { Outlet, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, Server as ServerIcon, Settings as SettingsIcon, LogOut } from 'lucide-react'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/store/auth'
import { useLogout } from '@/api/auth'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

export function AdminLayout() {
  const { t } = useTranslation()
  const { admin } = useAuth()
  const logout = useLogout()
  const navigate = useNavigate()
  const loc = useLocation()

  const navItems = [
    { to: '/admin/dashboard', label: t('admin.dashboard'), icon: LayoutDashboard },
    { to: '/admin/servers', label: t('admin.servers'), icon: ServerIcon },
    { to: '/admin/settings', label: t('admin.settings'), icon: SettingsIcon },
  ]

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 border-r bg-card">
        <div className="px-4 py-3 font-semibold">{t('app.name')}</div>
        <nav className="px-2">
          {navItems.map((it) => {
            const active = loc.pathname.startsWith(it.to)
            return (
              <Link
                key={it.to}
                to={it.to}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-2 text-sm hover:bg-accent',
                  active && 'bg-accent text-accent-foreground',
                )}
              >
                <it.icon className="h-4 w-4" />
                {it.label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col">
        <header className="border-b">
          <div className="flex h-14 items-center justify-end gap-2 px-6">
            {admin && <span className="text-sm text-muted-foreground">{admin.username}</span>}
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout.mutateAsync()
                navigate('/admin/login')
              }}
            >
              <LogOut className="mr-1 h-4 w-4" />
              {t('auth.logout')}
            </Button>
            <ThemeToggle />
            <LangToggle />
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Type-check + commit**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
```

```
cd /Users/hg/project/Shepherd
git add web/src/layouts
git commit -m "feat(web): public + admin layouts with theme/lang toggles + sidebar nav"
```

---

### Task 16: Login page

**Files:**
- Replace: `web/src/pages/admin/Login.tsx`

- [ ] **Step 1: `web/src/pages/admin/Login.tsx`**

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useLogin } from '@/api/auth'
import { useAuth } from '@/store/auth'
import { useUI } from '@/store/ui'
import { ThemeToggle } from '@/components/ThemeToggle'
import { LangToggle } from '@/components/LangToggle'

const schema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
type FormVals = z.infer<typeof schema>

export default function Login() {
  const { t } = useTranslation()
  const login = useLogin()
  const setAdmin = useAuth((s) => s.setAdmin)
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: { username: '', password: '' },
  })

  const onSubmit = async (vals: FormVals) => {
    try {
      const admin = await login.mutateAsync(vals)
      setAdmin(admin)
      navigate('/admin/dashboard')
    } catch (err: any) {
      const msg = err?.status === 401 ? t('auth.invalid_credentials') : err?.message ?? t('common.error')
      toast('error', msg)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b">
        <div className="container flex h-14 items-center justify-between">
          <span className="font-semibold">{t('app.name')}</span>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LangToggle />
          </div>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>{t('auth.login')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">{t('auth.username')}</Label>
                <Input id="username" autoComplete="username" {...register('username')} />
                {errors.username && <p className="text-xs text-destructive">{errors.username.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Input id="password" type="password" autoComplete="current-password" {...register('password')} />
                {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {t('auth.submit')}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Type-check + commit**

```
cd /Users/hg/project/Shepherd/web
npx tsc -b --noEmit
```

```
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/Login.tsx
git commit -m "feat(web): admin login page with RHF + zod"
```

---

## Milestone 6 — Public side

### Task 17: Public Wall + MetricCard

**Files:**
- Create: `web/src/components/MetricCard.tsx`
- Replace: `web/src/pages/public/Wall.tsx`

- [ ] **Step 1: `web/src/components/MetricCard.tsx`**

```tsx
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from './ui/card'
import { CountryFlag } from './CountryFlag'
import { OnlineDot } from './OnlineDot'
import { MetricBadge, type DisplayMode } from './MetricBadge'
import type { PublicCard } from '@/api/public'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/time'

type Props = {
  card: PublicCard
  mode: DisplayMode
}

export function MetricCard({ card, mode }: Props) {
  const { t } = useTranslation()
  const offline = !card.online
  const latest = card.latest

  const lastSeen = relativeTime(latest?.ts)
  const lastSeenLabel = lastSeen ? t(lastSeen.key, { n: lastSeen.n }) : '-'

  const cpuPct = latest?.cpu_pct ?? null
  const memPct = latest?.mem_pct ?? null
  const diskPct = latest?.disks_pct?.[0] ?? null // first disk

  return (
    <Link to={`/public/servers/${card.id}`} className="block">
      <Card className={cn('transition-colors hover:border-primary', offline && 'opacity-60')}>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CountryFlag code={card.country_code} />
              <span className="font-medium">{card.alias}</span>
            </div>
            <OnlineDot online={card.online} />
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.cpu')}</span>
              <MetricBadge metric="cpu" mode={mode} kind="pct" value={cpuPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.mem')}</span>
              <MetricBadge metric="mem" mode={mode} kind="pct" value={memPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.disk')}</span>
              <MetricBadge metric="disk" mode={mode} kind="pct" value={diskPct} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t('metric.net')}</span>
              <MetricBadge
                metric="net"
                mode={mode}
                kind="net"
                rxBps={latest?.net_rx_bps ?? 0}
                txBps={latest?.net_tx_bps ?? 0}
              />
            </div>
          </div>
          {offline && latest && (
            <div className="text-xs text-muted-foreground">
              {t('common.minute_ago', { n: 0 })}— {lastSeenLabel}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  )
}
```

- [ ] **Step 2: `web/src/pages/public/Wall.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { usePublicServers, usePublicSettings } from '@/api/public'
import { MetricCard } from '@/components/MetricCard'

export default function Wall() {
  const { t } = useTranslation()
  const servers = usePublicServers()
  const settings = usePublicSettings()
  const mode = settings.data?.public_display_mode ?? 'both'

  if (servers.isLoading) return <div>{t('common.loading')}</div>
  if (servers.error) return <div>{t('common.error')}</div>

  const list = servers.data ?? []
  if (list.length === 0) {
    return <div className="text-muted-foreground">{t('wall.no_servers')}</div>
  }

  // Group by group name
  const groups = new Map<string, typeof list>()
  for (const s of list) {
    const key = s.group || ''
    const arr = groups.get(key) ?? []
    arr.push(s)
    groups.set(key, arr)
  }
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">{t('wall.title')}</h1>
      {orderedGroups.map(([group, servers]) => (
        <section key={group} className="space-y-3">
          <h2 className="text-sm uppercase text-muted-foreground">
            {group || t('wall.ungrouped')}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {servers
              .slice()
              .sort((a, b) => a.alias.localeCompare(b.alias))
              .map((s) => (
                <MetricCard key={s.id} card={s} mode={mode} />
              ))}
          </div>
        </section>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/components/MetricCard.tsx web/src/pages/public/Wall.tsx
git commit -m "feat(web): public monitoring wall + MetricCard"
```

---

### Task 18: Public Server Detail + TimeSeriesChart

**Files:**
- Create: `web/src/components/TimeSeriesChart.tsx`
- Replace: `web/src/pages/public/ServerDetail.tsx`

- [ ] **Step 1: `web/src/components/TimeSeriesChart.tsx`**

```tsx
import { useMemo, useState } from 'react'

type Series = { name: string; values: { ts: string; v: number }[]; color?: string }

type Props = {
  height?: number
  series: Series[]
  yMin?: number
  yMax?: number
  yFormat?: (v: number) => string
  tooltipFormat?: (v: number) => string
}

const DEFAULT_PALETTE = ['hsl(var(--primary))', 'hsl(var(--level-mid))', 'hsl(var(--level-alert))', 'hsl(var(--level-low))']

export function TimeSeriesChart({
  height = 120,
  series,
  yMin,
  yMax,
  yFormat = (v) => v.toFixed(0),
  tooltipFormat = (v) => v.toFixed(2),
}: Props) {
  const [hoverX, setHoverX] = useState<number | null>(null)
  const width = 600 // SVG viewBox; CSS scales it to container

  const allValues = series.flatMap((s) => s.values.map((p) => p.v))
  const min = yMin ?? (allValues.length ? Math.min(...allValues) : 0)
  const max = yMax ?? (allValues.length ? Math.max(...allValues) : 1)
  const span = max - min || 1
  const allTs = series.flatMap((s) => s.values.map((p) => +new Date(p.ts)))
  const tMin = allTs.length ? Math.min(...allTs) : 0
  const tMax = allTs.length ? Math.max(...allTs) : 1
  const tSpan = tMax - tMin || 1

  const pad = { l: 40, r: 8, t: 8, b: 20 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b

  const x = (ts: string) => pad.l + ((+new Date(ts) - tMin) / tSpan) * innerW
  const y = (v: number) => pad.t + (1 - (v - min) / span) * innerH

  const yTicks = useMemo(() => {
    const n = 4
    return [...Array(n + 1)].map((_, i) => min + (span * i) / n)
  }, [min, span])

  const xTicks = useMemo(() => {
    const n = 4
    return [...Array(n + 1)].map((_, i) => tMin + (tSpan * i) / n)
  }, [tMin, tSpan])

  const closestPoints = useMemo(() => {
    if (hoverX == null) return null
    return series.map((s) => {
      let best: { ts: string; v: number } | null = null
      let bestDx = Infinity
      for (const p of s.values) {
        const px = x(p.ts)
        const dx = Math.abs(px - hoverX)
        if (dx < bestDx) {
          bestDx = dx
          best = p
        }
      }
      return { name: s.name, point: best }
    })
  }, [hoverX, series])

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const ratio = (e.clientX - rect.left) / rect.width
          setHoverX(ratio * width)
        }}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* gridlines */}
        {yTicks.map((v, i) => (
          <g key={`y${i}`}>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={y(v)}
              y2={y(v)}
              stroke="hsl(var(--border))"
              strokeDasharray="2 2"
            />
            <text x={4} y={y(v) + 4} fontSize={9} fill="hsl(var(--muted-foreground))">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={`x${i}`}
            x={pad.l + (innerW * i) / xTicks.length}
            y={height - 4}
            fontSize={9}
            fill="hsl(var(--muted-foreground))"
          >
            {new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </text>
        ))}
        {/* series */}
        {series.map((s, idx) => {
          if (s.values.length < 2) return null
          const d = s.values
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.v).toFixed(1)}`)
            .join(' ')
          return (
            <path
              key={s.name}
              d={d}
              fill="none"
              stroke={s.color ?? DEFAULT_PALETTE[idx % DEFAULT_PALETTE.length]}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
        {hoverX != null && (
          <line x1={hoverX} x2={hoverX} y1={pad.t} y2={height - pad.b} stroke="hsl(var(--muted-foreground))" />
        )}
      </svg>
      {closestPoints && hoverX != null && (
        <div className="absolute right-2 top-2 rounded border bg-popover p-2 text-xs shadow">
          {closestPoints.map(
            (cp) =>
              cp.point && (
                <div key={cp.name}>
                  <span className="text-muted-foreground">{cp.name}:</span> {tooltipFormat(cp.point.v)}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: `web/src/pages/public/ServerDetail.tsx`**

```tsx
import { useParams } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { usePublicTelemetry } from '@/api/public'
import type { Range } from '@/api/servers'
import { bps, bytes, pct } from '@/lib/bytes'

export default function PublicServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const [range, setRange] = useState<Range>('1h')
  const { data, isLoading, error } = usePublicTelemetry(id, range)

  if (isLoading) return <div>{t('common.loading')}</div>
  if (error) return <div>{t('common.not_found')}</div>

  const points = data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPct = points.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) ?? 0 }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))
  const load = points.map((p) => ({ ts: p.ts, v: p.load_1 ?? 0 }))
  const tcp = points.map((p) => ({ ts: p.ts, v: p.tcp_conn ?? 0 }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Server #{id}</h1>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="1h">{t('range.1h')}</TabsTrigger>
            <TabsTrigger value="24h">{t('range.24h')}</TabsTrigger>
            <TabsTrigger value="7d">{t('range.7d')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('metric.cpu')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'CPU%', values: cpu }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.mem')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'MEM%', values: memPct }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.net')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart
            series={[
              { name: 'rx', values: netRx },
              { name: 'tx', values: netTx },
            ]}
            yFormat={(v) => bps(v)}
            tooltipFormat={(v) => bps(v)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.load')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'load1', values: load }]} yFormat={(v) => v.toFixed(1)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.tcp')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'tcp', values: tcp }]} />
        </CardContent>
      </Card>
      {points.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('common.minute_ago', { n: 0 })}— mem snapshot: {bytes(points[points.length - 1].mem_used)} / {bytes(points[points.length - 1].mem_total)}
        </p>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/components/TimeSeriesChart.tsx web/src/pages/public/ServerDetail.tsx
git commit -m "feat(web): public server detail + hand-rolled TimeSeriesChart"
```

---

## Milestone 7 — Admin pages

### Task 19: Admin Dashboard

**Files:**
- Replace: `web/src/pages/admin/Dashboard.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useTranslation } from 'react-i18next'
import { useServers, type ServerWithLatest } from '@/api/servers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { levelForPct } from '@/lib/thresholds'
import { pct } from '@/lib/bytes'

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  const t = new Date(s.agent_last_seen.Time)
  return Date.now() - t.getTime() <= 90 * 1000
}

function isAlerting(s: ServerWithLatest): boolean {
  if (!s.latest) return false
  const cpuLevel = levelForPct('cpu', s.latest.cpu_pct ?? null)
  const memLevel = levelForPct('mem', pct(s.latest.mem_used, s.latest.mem_total))
  // disk: parse disks_json to find max
  let diskMax = 0
  if (s.latest.disks_json) {
    try {
      const ds = JSON.parse(s.latest.disks_json) as Array<{ used: number; total: number }>
      for (const d of ds) {
        if (d.total > 0) diskMax = Math.max(diskMax, (d.used / d.total) * 100)
      }
    } catch {}
  }
  const diskLevel = levelForPct('disk', diskMax)
  return cpuLevel === 'alert' || memLevel === 'alert' || diskLevel === 'alert'
}

export default function Dashboard() {
  const { t } = useTranslation()
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })

  if (isLoading) return <div>{t('common.loading')}</div>
  const servers = data ?? []
  const total = servers.length
  const online = servers.filter(isOnline).length
  const offline = total - online
  const alerts = servers.filter(isAlerting).length

  const topCPU = servers
    .filter((s) => s.latest?.cpu_pct != null)
    .sort((a, b) => (b.latest!.cpu_pct! ?? 0) - (a.latest!.cpu_pct! ?? 0))
    .slice(0, 5)

  const topMEM = servers
    .filter((s) => s.latest?.mem_used != null && s.latest?.mem_total)
    .sort((a, b) => (pct(b.latest!.mem_used, b.latest!.mem_total) ?? 0) - (pct(a.latest!.mem_used, a.latest!.mem_total) ?? 0))
    .slice(0, 5)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('admin.dashboard')}</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <SummaryCard label={t('admin.summary.total')} value={total} />
        <SummaryCard label={t('admin.summary.online')} value={online} />
        <SummaryCard label={t('admin.summary.offline')} value={offline} />
        <SummaryCard label={t('admin.summary.alerts')} value={alerts} />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('admin.summary.top_cpu')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topCPU.length === 0 && <p className="text-muted-foreground">-</p>}
            {topCPU.map((s) => (
              <div key={s.id} className="flex justify-between">
                <span>{s.public_alias?.Valid ? s.public_alias.String : s.name}</span>
                <span className="font-mono">{(s.latest!.cpu_pct ?? 0).toFixed(0)}%</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t('admin.summary.top_mem')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {topMEM.length === 0 && <p className="text-muted-foreground">-</p>}
            {topMEM.map((s) => (
              <div key={s.id} className="flex justify-between">
                <span>{s.public_alias?.Valid ? s.public_alias.String : s.name}</span>
                <span className="font-mono">
                  {(pct(s.latest!.mem_used, s.latest!.mem_total) ?? 0).toFixed(0)}%
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="mt-1 text-3xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  )
}
```

- [ ] **Step 2: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/Dashboard.tsx
git commit -m "feat(web): admin dashboard (online/offline/alerts/top-N) via /api/servers?with=latest"
```

---

### Task 20: Admin Server List + delete dialog

**Files:**
- Replace: `web/src/pages/admin/ServerList.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { useServers, useDeleteServer, type ServerWithLatest } from '@/api/servers'
import { useUI } from '@/store/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { OnlineDot } from '@/components/OnlineDot'
import { pct } from '@/lib/bytes'
import { relativeTime } from '@/lib/time'

function isOnline(s: ServerWithLatest): boolean {
  if (!s.agent_last_seen?.Valid) return false
  return Date.now() - new Date(s.agent_last_seen.Time).getTime() <= 90 * 1000
}

export default function ServerList() {
  const { t, i18n } = useTranslation()
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useServers({ withLatest: true, refetchInterval: 30_000 })
  const del = useDeleteServer()
  const toast = useUI((s) => s.toast)

  if (isLoading) return <div>{t('common.loading')}</div>
  const servers = (data ?? []).filter((s) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return s.name.toLowerCase().includes(f) || (s.ssh_host?.String ?? '').toLowerCase().includes(f)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('admin.servers')}</h1>
        <Button asChild>
          <Link to="/admin/servers/new">
            <Plus className="mr-1 h-4 w-4" />
            {t('admin.add_server')}
          </Link>
        </Button>
      </div>
      <Input
        placeholder="filter…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-xs"
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('admin.name')}</TableHead>
            <TableHead>{t('admin.host')}</TableHead>
            <TableHead>OS</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>{t('admin.agent_last_seen')}</TableHead>
            <TableHead>CPU</TableHead>
            <TableHead>MEM</TableHead>
            <TableHead className="w-32 text-right">{t('admin.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {servers.map((s) => {
            const online = isOnline(s)
            const lastSeen = relativeTime(s.agent_last_seen?.Valid ? s.agent_last_seen.Time : null)
            return (
              <TableRow key={s.id}>
                <TableCell className="flex items-center gap-2 font-medium">
                  <OnlineDot online={online} />
                  {s.name}
                </TableCell>
                <TableCell className="font-mono text-xs">{s.ssh_host?.String ?? '-'}</TableCell>
                <TableCell className="text-xs">
                  {s.agent_os?.String ?? '-'}/{s.agent_arch?.String ?? '-'}
                </TableCell>
                <TableCell>
                  <Badge variant={s.install_stage === 'failed' ? 'destructive' : 'default'}>
                    {s.install_stage}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs">
                  {lastSeen ? t(lastSeen.key, { n: lastSeen.n, lng: i18n.language }) : '-'}
                </TableCell>
                <TableCell className="font-mono">
                  {s.latest?.cpu_pct != null ? `${s.latest.cpu_pct.toFixed(0)}%` : '-'}
                </TableCell>
                <TableCell className="font-mono">
                  {(() => {
                    const p = pct(s.latest?.mem_used, s.latest?.mem_total)
                    return p == null ? '-' : `${p.toFixed(0)}%`
                  })()}
                </TableCell>
                <TableCell className="text-right space-x-2">
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/admin/servers/${s.id}`}>{t('admin.details')}</Link>
                  </Button>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label="delete">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>{t('admin.delete')}</DialogTitle>
                        <DialogDescription>
                          {t('admin.confirm_delete', { name: s.name })}
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <Button
                          variant="destructive"
                          onClick={async () => {
                            try {
                              await del.mutateAsync(s.id)
                              toast('success', t('common.ok'))
                            } catch (err: any) {
                              toast('error', err?.message ?? t('common.error'))
                            }
                          }}
                        >
                          {t('admin.delete')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/ServerList.tsx
git commit -m "feat(web): admin server list + delete confirmation dialog"
```

---

### Task 21: Admin Server New (install form)

**Files:**
- Replace: `web/src/pages/admin/ServerNew.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstall } from '@/api/servers'
import { useUI } from '@/store/ui'

const schema = z.object({
  name: z.string().min(1),
  ssh_host: z.string().min(1),
  ssh_port: z.coerce.number().int().min(1).max(65535).default(22),
  ssh_user: z.string().min(1),
  ssh_password: z.string().optional(),
  ssh_key: z.string().optional(),
  arch: z.enum(['amd64', 'arm64']),
  public_alias: z.string().optional(),
  public_group: z.string().optional(),
  country_code: z.string().regex(/^[A-Z]{2}$/).optional().or(z.literal('')),
  show_on_public: z.boolean().default(false),
}).refine((v) => !!v.ssh_password || !!v.ssh_key, {
  message: 'one of ssh_password or ssh_key required',
  path: ['ssh_password'],
})

type FormVals = z.infer<typeof schema>

export default function ServerNew() {
  const { t } = useTranslation()
  const install = useInstall()
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()
  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: { ssh_port: 22, arch: 'amd64', show_on_public: false, country_code: '' },
  })

  const arch = watch('arch')
  const show = watch('show_on_public')

  const onSubmit = async (vals: FormVals) => {
    try {
      const out = await install.mutateAsync({
        ...vals,
        country_code: vals.country_code || undefined,
        ssh_password: vals.ssh_password || undefined,
        ssh_key: vals.ssh_key || undefined,
      })
      navigate(`/admin/servers/${out.server_id}`)
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('admin.add_server')}</h1>
      <Card>
        <CardHeader><CardTitle>SSH</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Field id="name" label={t('admin.name')} {...register('name')} error={errors.name?.message} />
            <div className="grid grid-cols-3 gap-3">
              <Field id="ssh_host" label="ssh_host" {...register('ssh_host')} error={errors.ssh_host?.message} className="col-span-2" />
              <Field id="ssh_port" label="port" type="number" {...register('ssh_port')} error={errors.ssh_port?.message} />
            </div>
            <Field id="ssh_user" label="ssh_user" {...register('ssh_user')} error={errors.ssh_user?.message} />
            <Field id="ssh_password" label="ssh_password" type="password" {...register('ssh_password')} error={errors.ssh_password?.message} />
            <div className="space-y-1">
              <Label htmlFor="ssh_key">ssh_key (PEM)</Label>
              <textarea
                id="ssh_key"
                rows={5}
                className="block w-full rounded border bg-background px-3 py-2 font-mono text-xs"
                {...register('ssh_key')}
              />
              <p className="text-xs text-muted-foreground">
                Provide either password or key.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Arch</Label>
              <Select value={arch} onValueChange={(v) => setValue('arch', v as 'amd64' | 'arm64')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="amd64">amd64</SelectItem>
                  <SelectItem value="arm64">arm64</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field id="public_alias" label="public_alias" {...register('public_alias')} />
              <Field id="public_group" label="public_group" {...register('public_group')} />
              <Field id="country_code" label="country_code (XX)" {...register('country_code')} error={errors.country_code?.message} />
            </div>
            <div className="flex items-center gap-3">
              <Switch checked={show} onCheckedChange={(v) => setValue('show_on_public', v)} id="show_on_public" />
              <Label htmlFor="show_on_public">show_on_public</Label>
            </div>
            <Button type="submit" disabled={isSubmitting}>{t('admin.add_server')}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  id,
  label,
  error,
  className,
  ...rest
}: {
  id: string
  label: string
  error?: string
  className?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...rest} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/ServerNew.tsx
git commit -m "feat(web): admin install form (RHF + zod, password OR key, arch select)"
```

---

### Task 22: Admin Server Detail (install progress + repair + config + telemetry + delete)

**Files:**
- Create: `web/src/components/InstallProgress.tsx`
- Replace: `web/src/pages/admin/ServerDetail.tsx`

- [ ] **Step 1: `web/src/components/InstallProgress.tsx`**

```tsx
import { useEffect, useRef } from 'react'

export function InstallProgress({ log, stage }: { log: string; stage: string }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log])
  return (
    <div className="space-y-2">
      <div className="text-sm">stage: {stage}</div>
      <pre
        ref={ref}
        className="max-h-72 overflow-auto rounded border bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
      >
        {log || '...'}
      </pre>
    </div>
  )
}
```

- [ ] **Step 2: `web/src/pages/admin/ServerDetail.tsx`**

```tsx
import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useServer, useTelemetry, usePatchServer, useDeleteServer, useRepair, usePushConfig } from '@/api/servers'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { TimeSeriesChart } from '@/components/TimeSeriesChart'
import { InstallProgress } from '@/components/InstallProgress'
import { useUI } from '@/store/ui'
import { bps, bytes, pct } from '@/lib/bytes'
import type { Range } from '@/api/servers'

export default function AdminServerDetail() {
  const { id: idStr } = useParams<{ id: string }>()
  const id = Number(idStr)
  const { t } = useTranslation()
  const toast = useUI((s) => s.toast)
  const navigate = useNavigate()

  // Single useServer with dynamic refetchInterval — fast (1.5s) during install, slow (30s) otherwise.
  // To use a function refetchInterval, update useServer in api/servers.ts to accept
  //   `refetchInterval?: number | ((q: any) => number)`
  // and pass it straight through to useQuery.
  const server = useServer(id, {
    refetchInterval: ((q) => {
      const stage = (q?.state?.data as { install_stage?: string } | undefined)?.install_stage
      return stage === 'installing' || stage === 'pending' ? 1500 : 30_000
    }) as unknown as number, // cast: react-query v5 accepts a function here
  })
  const s = server.data

  const [range, setRange] = useState<Range>('1h')
  const tele = useTelemetry(id, range, false)

  const patch = usePatchServer(id)
  const repair = useRepair(id)
  const config = usePushConfig(id)
  const del = useDeleteServer()

  const [interval, setInterval] = useState(30)
  const [repairToken, setRepairToken] = useState<{ token: string; expires: string } | null>(null)

  if (!s) return <div>{t('common.loading')}</div>

  const points = tele.data ?? []
  const cpu = points.map((p) => ({ ts: p.ts, v: p.cpu_pct ?? 0 }))
  const memPctSeries = points.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) ?? 0 }))
  const netRx = points.map((p) => ({ ts: p.ts, v: p.net_rx_bps ?? 0 }))
  const netTx = points.map((p) => ({ ts: p.ts, v: p.net_tx_bps ?? 0 }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{s.name}</h1>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">{t('admin.delete')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('admin.delete')}</DialogTitle>
              <DialogDescription>{t('admin.confirm_delete', { name: s.name })}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="destructive"
                onClick={async () => {
                  await del.mutateAsync(s.id)
                  navigate('/admin/servers')
                }}
              >
                {t('admin.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm">
          <KV k="name" v={s.name} />
          <KV k="ssh_host" v={s.ssh_host?.String ?? '-'} />
          <KV k="agent_version" v={s.agent_version?.String ?? '-'} />
          <KV k="agent_os" v={`${s.agent_os?.String ?? '-'}/${s.agent_arch?.String ?? '-'}`} />
          <KV k="agent_kernel" v={s.agent_kernel?.String ?? '-'} />
          <KV k="agent_fingerprint" v={s.agent_fingerprint?.String ?? '-'} long />
          <KV k="agent_last_seen" v={s.agent_last_seen?.Valid ? s.agent_last_seen.Time : '-'} />
          <KV k="install_stage" v={s.install_stage} />
        </CardContent>
      </Card>

      {(s.install_stage === 'installing' || s.install_stage === 'failed') && (
        <Card>
          <CardHeader><CardTitle>{t('admin.install_progress')}</CardTitle></CardHeader>
          <CardContent>
            <InstallProgress log={s.install_log} stage={s.install_stage} />
            {s.install_error?.Valid && (
              <p className="mt-2 text-sm text-destructive">{s.install_error.String}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Public visibility</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Field
            label="public_alias"
            defaultValue={s.public_alias?.String ?? ''}
            onBlur={(v) => patch.mutate({ public_alias: v })}
          />
          <Field
            label="public_group"
            defaultValue={s.public_group?.String ?? ''}
            onBlur={(v) => patch.mutate({ public_group: v })}
          />
          <Field
            label="country_code"
            defaultValue={s.country_code?.String ?? ''}
            onBlur={(v) => patch.mutate({ country_code: v })}
          />
          <div className="flex items-center gap-2">
            <Switch
              defaultChecked={s.show_on_public}
              onCheckedChange={(v) => patch.mutate({ show_on_public: v })}
            />
            <Label>show_on_public</Label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Operations</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label>{t('admin.config_interval')}</Label>
              <Input
                type="number"
                min={5}
                max={3600}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </div>
            <Button
              onClick={async () => {
                try {
                  await config.mutateAsync({ telemetry_interval_seconds: interval })
                  toast('success', t('admin.config_pushed'))
                } catch (err: any) {
                  toast(err?.status === 409 ? 'error' : 'error', err?.status === 409 ? t('admin.config_offline') : err?.message ?? t('common.error'))
                }
              }}
            >
              push
            </Button>
          </div>
          <div className="flex items-end gap-2">
            <Button
              onClick={async () => {
                const out = await repair.mutateAsync()
                setRepairToken({ token: out.enrollment_token, expires: out.expires_at })
                toast('success', t('admin.repair_token_issued', { expires: new Date(out.expires_at).toLocaleString() }))
              }}
            >
              {t('admin.repair')}
            </Button>
            {repairToken && (
              <code className="rounded border bg-muted px-2 py-1 text-xs">
                {repairToken.token}
              </code>
            )}
            {repairToken && (
              <Button variant="ghost" size="sm" onClick={() => navigator.clipboard.writeText(repairToken.token).then(() => toast('success', t('common.copied')))}>
                {t('common.copy')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Telemetry</h2>
        <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
          <TabsList>
            <TabsTrigger value="1h">{t('range.1h')}</TabsTrigger>
            <TabsTrigger value="24h">{t('range.24h')}</TabsTrigger>
            <TabsTrigger value="7d">{t('range.7d')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Card>
        <CardHeader><CardTitle>{t('metric.cpu')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'CPU%', values: cpu }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.mem')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart series={[{ name: 'MEM%', values: memPctSeries }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('metric.net')}</CardTitle></CardHeader>
        <CardContent>
          <TimeSeriesChart
            series={[
              { name: 'rx', values: netRx },
              { name: 'tx', values: netTx },
            ]}
            yFormat={(v) => bps(v)}
            tooltipFormat={(v) => bps(v)}
          />
        </CardContent>
      </Card>
      {points.length > 0 && (
        <p className="text-xs text-muted-foreground">
          mem snapshot: {bytes(points[points.length - 1].mem_used)} / {bytes(points[points.length - 1].mem_total)}
        </p>
      )}
    </div>
  )
}

function KV({ k, v, long }: { k: string; v: string; long?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className={long ? 'truncate font-mono text-xs' : 'font-mono text-xs'}>{v}</span>
    </div>
  )
}

function Field({
  label,
  defaultValue,
  onBlur,
}: {
  label: string
  defaultValue: string
  onBlur: (v: string) => void
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        defaultValue={defaultValue}
        onBlur={(e) => {
          const v = e.target.value
          if (v !== defaultValue) onBlur(v)
        }}
      />
    </div>
  )
}
```

- [ ] **Step 3: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/components/InstallProgress.tsx web/src/pages/admin/ServerDetail.tsx
git commit -m "feat(web): admin server detail (telemetry + install progress + repair + config push + delete)"
```

---

### Task 23: Admin Settings page

**Files:**
- Replace: `web/src/pages/admin/Settings.tsx`

- [ ] **Step 1: Write the page**

```tsx
import { useTranslation } from 'react-i18next'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSettings, usePatchSettings } from '@/api/settings'
import { useUI } from '@/store/ui'

const schema = z.object({
  public_display_mode: z.enum(['raw', 'level', 'both']),
  retention_30s: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_5m: z.string().regex(/^\d+(s|m|h|d)$/),
  retention_1h: z.string().regex(/^\d+(s|m|h|d)$/),
  default_telemetry_interval_seconds: z.coerce.number().int().min(5).max(3600),
})
type FormVals = z.infer<typeof schema>

export default function Settings() {
  const { t } = useTranslation()
  const settings = useSettings()
  const patch = usePatchSettings()
  const toast = useUI((s) => s.toast)

  const { register, handleSubmit, setValue, watch, formState: { errors }, reset } = useForm<FormVals>({
    resolver: zodResolver(schema),
    defaultValues: {
      public_display_mode: 'both',
      retention_30s: '24h',
      retention_5m: '7d',
      retention_1h: '90d',
      default_telemetry_interval_seconds: 30,
    },
  })

  // hydrate from settings
  if (settings.data && !watch('public_display_mode')) {
    reset({
      public_display_mode: (settings.data.public_display_mode as 'raw' | 'level' | 'both') ?? 'both',
      retention_30s: settings.data.retention_30s ?? '24h',
      retention_5m: settings.data.retention_5m ?? '7d',
      retention_1h: settings.data.retention_1h ?? '90d',
      default_telemetry_interval_seconds: Number(settings.data.default_telemetry_interval_seconds ?? 30),
    })
  }

  const mode = watch('public_display_mode')

  const onSubmit = async (vals: FormVals) => {
    try {
      await patch.mutateAsync({
        public_display_mode: vals.public_display_mode,
        retention_30s: vals.retention_30s,
        retention_5m: vals.retention_5m,
        retention_1h: vals.retention_1h,
        default_telemetry_interval_seconds: String(vals.default_telemetry_interval_seconds),
      })
      toast('success', t('admin.saved'))
    } catch (err: any) {
      toast('error', err?.message ?? t('common.error'))
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t('admin.settings')}</h1>
      <Card>
        <CardHeader><CardTitle>{t('admin.settings')}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 max-w-md">
            <div className="space-y-1">
              <Label>{t('settings.public_display_mode')}</Label>
              <Select value={mode} onValueChange={(v) => setValue('public_display_mode', v as 'raw' | 'level' | 'both')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="raw">{t('settings.mode_raw')}</SelectItem>
                  <SelectItem value="level">{t('settings.mode_level')}</SelectItem>
                  <SelectItem value="both">{t('settings.mode_both')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Field label={t('settings.retention_30s')} {...register('retention_30s')} error={errors.retention_30s?.message} />
            <Field label={t('settings.retention_5m')} {...register('retention_5m')} error={errors.retention_5m?.message} />
            <Field label={t('settings.retention_1h')} {...register('retention_1h')} error={errors.retention_1h?.message} />
            <Field
              label={t('settings.default_telemetry_interval_seconds')}
              type="number"
              {...register('default_telemetry_interval_seconds')}
              error={errors.default_telemetry_interval_seconds?.message}
            />
            <Button type="submit">{t('admin.save')}</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  label,
  error,
  ...rest
}: {
  label: string
  error?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input {...rest} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
```

- [ ] **Step 2: Build + commit**

```
cd /Users/hg/project/Shepherd/web
npm run build
```

```
cd /Users/hg/project/Shepherd
git add web/src/pages/admin/Settings.tsx
git commit -m "feat(web): admin settings page (display mode + retention + default interval)"
```

---

## Milestone 8 — Smoke + final wiring

### Task 24: web smoke script

**Files:**
- Create: `scripts/web-smoke.sh`

- [ ] **Step 1: Write `scripts/web-smoke.sh`**

```bash
#!/usr/bin/env bash
# scripts/web-smoke.sh — Phase 1.B end-to-end check
# Runs after Phase 1.A backend smoke; assumes node/npm available.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

WORKDIR=$(mktemp -d)
DBFILE="$WORKDIR/shepherd.db"
COOKIES="$WORKDIR/cookies.txt"
SERVER_PID=
AGENT_PID=

cleanup() {
  if [[ -n "$AGENT_PID" ]]; then kill "$AGENT_PID" 2>/dev/null || true; wait "$AGENT_PID" 2>/dev/null || true; fi
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  if [[ "${SMOKE_PASSED:-0}" != "1" ]]; then
    echo "--- server.log ---"; tail -50 "$WORKDIR/server.log" 2>/dev/null || true
    echo "--- agent.log ---"; tail -50 "$WORKDIR/agent.log" 2>/dev/null || true
    echo "FAIL — workdir=$WORKDIR"
  fi
}
trap cleanup EXIT

echo "[1/8] build frontend"
make web

echo "[2/8] build server + agent"
make server
make agent

echo "[3/8] start server"
INITIAL_ADMIN_USERNAME=alice \
INITIAL_ADMIN_PASSWORD=hunter2 \
AUTO_RECOVER_KEY=secret \
DATABASE_DSN="file:$DBFILE?_fk=1" \
SERVER_PUBLIC_URL=http://localhost:8080 \
./bin/shepherd-server > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!
sleep 2

echo "[4/8] http GET / returns HTML"
curl -sf http://localhost:8080/ -o "$WORKDIR/index.html"
grep -q '<div id="root"></div>' "$WORKDIR/index.html"

echo "[5/8] /admin/anything returns SPA fallback (HTML, status 200)"
curl -sf -o "$WORKDIR/admin.html" -w '%{http_code}\n' http://localhost:8080/admin/dashboard | grep -q '^200$'

echo "[6/8] login + me round trip"
curl -sf -c "$COOKIES" -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"hunter2"}' \
  http://localhost:8080/api/login > /dev/null
curl -sf -b "$COOKIES" http://localhost:8080/api/admins/me | jq -e '.username == "alice"' > /dev/null

echo "[7/8] register agent + telemetry"
SERVER_URL=http://localhost:8080 \
AUTO_RECOVER_KEY=secret \
STATE_PATH="$WORKDIR/agent.state.json" \
./bin/shepherd-agent > "$WORKDIR/agent.log" 2>&1 &
AGENT_PID=$!
sleep 65 # let net delta primer + first telemetry land
curl -sf -b "$COOKIES" "http://localhost:8080/api/servers?with=latest" | jq -e '.[0].latest != null' > /dev/null

echo "[8/8] tear down"
SMOKE_PASSED=1
echo "PASS"
```

- [ ] **Step 2: Make executable + commit**

```
chmod +x /Users/hg/project/Shepherd/scripts/web-smoke.sh
git -C /Users/hg/project/Shepherd add scripts/web-smoke.sh
git -C /Users/hg/project/Shepherd commit -m "test: phase 1.B end-to-end web smoke script"
```

> **Don't run** the script as part of the implementation task — the `make web` step is slow (npm install). The implementer should manually run it once at the end of Task 24 to confirm the whole stack works, but only after Tasks 1-23 are merged. Re-running on each commit is fine but optional.

---

### Task 25: Final manual e2e validation

This is a **manual** task — no code changes. The implementer runs the smoke script and visually confirms the UI works.

- [ ] **Step 1: Run the smoke script**

```
cd /Users/hg/project/Shepherd
./scripts/web-smoke.sh
```
Expected: `PASS` printed; no error logs in `server.log` / `agent.log`.

- [ ] **Step 2: Visual check (browser)**

```
cd /Users/hg/project/Shepherd
INITIAL_ADMIN_USERNAME=alice INITIAL_ADMIN_PASSWORD=hunter2 AUTO_RECOVER_KEY=secret \
  DATABASE_DSN="file:./tmp.db?_fk=1" \
  ./bin/shepherd-server &
sleep 1
open http://localhost:8080/
# Then in another terminal:
SERVER_URL=http://localhost:8080 AUTO_RECOVER_KEY=secret \
  STATE_PATH=./tmp.state.json \
  ./bin/shepherd-agent &
```

In the browser, manually verify:
1. Public wall shows the loading state, then the wall (initially empty — no `show_on_public=true` servers yet).
2. Click "登录" / login — go to `/admin/login` directly. Login with `alice/hunter2`.
3. Dashboard renders with the registered server — total=1, online=1.
4. Click into the server detail. Toggle `show_on_public`, set `public_alias=DEV-1`, `country_code=US`. Hit save (or onBlur).
5. Open `/` in a new tab — wall shows the server card with the alias and US flag.
6. Toggle theme (sun/moon icon top right). Toggle language (Languages icon). Verify both persist on refresh.
7. Settings page — change `public_display_mode` to "raw". Refresh wall — values are bare percentages, no level chips.
8. Server detail → push config interval=10. Watch the chart fill in faster after 30 sec.
9. Re-pair button → token issued, copy works.

- [ ] **Step 3: Tear down**

```
pkill shepherd-agent || true
pkill shepherd-server || true
rm -f tmp.db tmp.state.json
```

- [ ] **Step 4: Report verdict**

If all 9 steps pass: report DONE.

If any UI breaks (text missing, layout broken, language doesn't change a string), the implementer reports DONE_WITH_CONCERNS listing the specific failures and fixes them in a follow-up commit before the branch is merged.

---

## Done — what's delivered

After Task 25, the branch contains:

- `internal/api/admin_servers.go` returning `?with=latest` payload
- `internal/web/` package + `dist/.gitkeep` + SPA-fallback handler
- `cmd/server/main.go` wiring the web handler
- A complete `web/` Vite project: 7 pages, 8 components, 5 lib helpers, 2 stores, 5 API hooks, full i18n + theme.
- Updated `Makefile` (`web`, `server`, `server-no-web`, `test-web`)
- `scripts/web-smoke.sh` end-to-end check

The `phase-1b` branch is ready to merge to main via `superpowers:finishing-a-development-branch`.

Plan 1.C (Docker Compose, Caddyfile, GitHub release CI, cross-compile Makefile) is the next logical phase.
