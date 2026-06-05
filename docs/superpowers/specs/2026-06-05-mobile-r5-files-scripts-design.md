# Mobile app — R5: files (read-only) + scripts — Design

**Date:** 2026-06-05
**Status:** Approved (scope confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (`mobile/`). Roadmap: R1 token-auth ✅
(v0.23.0) → R2 skeleton ✅ (v0.24.0) → R3 list+monitoring ✅ (v0.25.0) → R4 terminal
✅ (v0.26.0) → **R5 files + scripts (this spec)** → R6 plugins + push/biometrics.

## Goal

Add two remote-ops features to the app: a **read-only file browser** (list a
machine's directories, preview text files) and **scripts** (list saved scripts,
run one on the current server, watch its status). Reuses R3's authedFetch +
TanStack Query. No backend change.

## Confirmed decisions

- **Files are read-only:** browse + breadcrumb navigation + text preview. No
  download/upload/mkdir/rename/rm (write ops are risky on a phone — deferred).
- **Scripts run single-target:** run on the *current* server (entered from its
  detail), not multi-select — simpler UI, lower blast radius.
- **Run status by polling** the run-detail endpoint (no live-output WS in R5).

## Headless constraint
Verify with `tsc --noEmit` + `eslint` + `jest` (RN logic + screen renders via
@testing-library/react-native). Device smoke-test is the user's manual step.

## Backend reuse (no change)
- `GET /api/admin/files?server_id=&path=` (bearer) → `FileEntry[]`.
- `GET /api/admin/files/preview?server_id=&path=&max_bytes=65536` → **`text/plain`**
  body (not JSON); `415` for binary content (the audit-fixed Preview).
- `GET /api/admin/scripts` → `[{id,name,description,content,params:[{name,label,required,default}],default_timeout_s?}]`.
- `POST /api/admin/scripts/{id}/run {args:{}, target_server_ids:[id]}` → `{run_id}`.
- `GET /api/admin/script-runs/{id}` → run detail (per-server status + output).

---

## Components

### 1. `authedText` — `src/api/authed.ts` (add)
The preview endpoint returns `text/plain`, so a JSON-parsing `authedFetch` won't
do. Add a sibling that reads the body as text, with the same baseURL/token/Bearer
+ 401→clearSession behaviour:
```ts
export async function authedText(path: string): Promise<string>
// builds ${baseURL}${path}, sets Authorization: Bearer; on res.ok → res.text();
// on 401 → clearSession() then throw APIError(401); other non-2xx → throw APIError(status, body|status).
```

### 2. `src/api/files.ts`
```ts
export type FileEntry = { name: string; path: string; is_dir: boolean; size?: number; mtime?: string }
export function listDir(serverId: number, path: string): Promise<FileEntry[]>      // authedFetch GET /api/admin/files?server_id=&path=
export function previewFile(serverId: number, path: string): Promise<string>        // authedText /api/admin/files/preview?...&max_bytes=65536
export function useDir(serverId: number, path: string): UseQueryResult<FileEntry[]>  // queryKey ['files', serverId, path]
```
`listDir`/`previewFile` URL-encode the path. `previewFile` maps an `APIError(415)`
to a sentinel the UI shows as "binary — can't preview".

### 3. `src/lib/paths.ts` — pure path helpers
```ts
export function joinPath(dir: string, name: string): string   // posix join, collapse //
export function parentPath(path: string): string              // '/a/b' → '/a', '/' → '/'
export function crumbs(path: string): { label: string; path: string }[]  // breadcrumb segments
```

### 4. `src/api/scripts.ts`
```ts
export type ScriptParam = { name: string; label?: string; required?: boolean; default?: string }
export type Script = { id: number; name: string; description?: string; params: ScriptParam[] }
export type RunDetail = { id: number; status: string; servers: { server_id: number; status: string; output?: string }[] }
export function useScripts(): UseQueryResult<Script[]>                       // GET /api/admin/scripts
export function runScript(id: number, args: Record<string, string>, serverId: number): Promise<{ run_id: number }>
export function useRun(runId: number | null): UseQueryResult<RunDetail>      // GET /api/admin/script-runs/{id}, refetchInterval 2s until finished
```
(`RunDetail`'s exact shape is read defensively — the plan confirms the run-detail
JSON field names against `RunDetail`'s handler; render whatever status/output it
provides.)

### 5. Screens
- **`app/(app)/files/[id].tsx`** — file browser for server `id`. Local `path`
  state (default `/` or `~`→`/`). Breadcrumb from `crumbs(path)`; a `..` row when
  not at root. `useDir(id, path)` → `FlatList` (dirs first, then files, name-sorted
  within each): a dir row sets `path = entry.path`; a file row navigates to the
  preview. Loading/error/empty states; pull-to-refresh.
- **`app/(app)/files/[id]/preview.tsx`** — given `?path=`, `previewFile(id, path)`
  → a monospace `ScrollView`; shows "binary — can't preview" on the 415 sentinel,
  "empty" when blank, the error message otherwise.
- **`app/(app)/scripts/index.tsx`** — `useScripts()` list (name + description);
  reached from server detail with `?serverId=`. Tap → the run form.
- **`app/(app)/scripts/[id].tsx`** — the script's `params` rendered as labelled
  `TextInput`s (prefilled with `default`); Run is disabled until required params
  are filled. Run → `runScript(id, args, serverId)` → navigate to the run status.
- **`app/(app)/scripts/run/[runId].tsx`** — `useRun(runId)` polls until the run
  finishes; renders the overall status + the target server's status + output
  (monospace).
- **Entries on server detail (`(app)/server/[id].tsx`):** "Files" →
  `/(app)/files/${id}`; "Run script" → `/(app)/scripts?serverId=${id}` (alongside
  the R4 "Open console").

---

## Data flow
```
detail "Files" → files/[id] (path state) → useDir(id,path) → listDir → FlatList
  dir tap → path = entry.path ; file tap → files/[id]/preview?path= → previewFile (text)
detail "Run script" → scripts?serverId= → useScripts → scripts/[id] (form)
  Run → runScript(id,args,serverId) → {run_id} → scripts/run/[runId] → useRun polls → status+output
any 401 → clearSession → login (via authedFetch/authedText)
```

## Testing (jest, headless)
- **`authedText`** (mock fetch + store): 200 → text body; 401 → clearSession +
  throws; non-401 → throws without clearing; missing baseURL → throws.
- **`files`** (mock authedFetch/authedText): `listDir` hits the right URL; `useDir`
  resolves; `previewFile` returns text; a 415 maps to the binary sentinel.
- **`paths`**: `joinPath`/`parentPath`/`crumbs` cases (root, nested, trailing slash).
- **`scripts`** (mock authedFetch): `useScripts` resolves; `runScript` posts
  `{args, target_server_ids:[serverId]}` and returns run_id; `useRun` polls/stops.
- **file browser screen** (mock `useDir`): renders entries, dirs-first; tapping a
  dir updates the listed path (assert the new `useDir` arg or rendered breadcrumb);
  error/empty states.
- **scripts run form** (mock `useScripts`/`runScript`): required-param validation
  (Run disabled until filled); pressing Run calls `runScript` with the entered args
  + serverId.
- **run status screen** (mock `useRun`): renders status + output; "running" state.

## Out of scope
- File writes (download/upload/mkdir/rename/rm); multi-target script runs; script
  CRUD (create/edit/delete scripts); live run-output WS (polling instead); search.

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; lock in sync (CI
`npm ci`); backend + web untouched. **Manual (user, dev build):** browse a
machine's files + preview a text file; run a script on a server and watch it finish.
