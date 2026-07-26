import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  Plus,
  Trash2,
  Upload as UploadIcon,
} from 'lucide-react'
import {
  useFiles,
  useMkdir,
  useRm,
  previewFile,
  downloadFileURL,
  uploadFileWithProgress,
  type FileEntry,
} from '@/api/files'
import { openConsole } from '@/api/console'
import { useServers } from '@/api/servers'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { XtermPane } from '@/components/ConsoleDock/XtermPane'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { PageHeader } from '@/components/PageHeader'
import { LoadingState } from '@/components/LoadingState'
import { ErrorState } from '@/components/ErrorState'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ConfirmDialog'

function formatMode(m: number): string {
  return (m & 0o777).toString(8).padStart(3, '0')
}
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type Transfer = {
  id: string
  name: string
  dir: 'up' | 'down'
  size: number
  loaded: number
  progress: number
  status: 'active' | 'done' | 'error' | 'cancelled'
  host: string
  cancel?: () => void
}

const QUICK_PATHS = ['/tmp', '/Users', '/home', '/var/log', '/etc/shepherd', '/opt', '/srv']

export default function FileBrowserPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { serverId } = useParams<{ serverId: string }>()
  const sid = serverId ? Number(serverId) : 0

  const serversQuery = useServers({ refetchInterval: 60_000 })
  const host = serversQuery.data?.find((s) => s.id === sid)

  const [cwd, setCwd] = useState('/tmp')
  const [pathInput, setPathInput] = useState(cwd)
  useEffect(() => setPathInput(cwd), [cwd])
  const submitPath = () => {
    const trimmed = pathInput.trim()
    if (trimmed && trimmed !== cwd) setCwd(trimmed)
  }

  const { data, isLoading, error, refetch } = useFiles(sid, cwd)
  const mkdir = useMkdir()
  const rm = useRm()
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewText, setPreviewText] = useState('')
  const [previewName, setPreviewName] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // PTY session for the inline terminal. Open one per host visit; close on
  // unmount via the agent-side timeout when the WS drops.
  const [removeTarget, setRemoveTarget] = useState<FileEntry | null>(null)
  const [ptySid, setPtySid] = useState<string | null>(null)
  const [auditId, setAuditId] = useState<number | null>(null)
  useEffect(() => {
    if (!sid) return
    let cancelled = false
    openConsole(sid, { rows: 24, cols: 80, term: 'xterm-256color' })
      .then((out) => {
        if (!cancelled) {
          setPtySid(out.sid)
          setAuditId(out.session_id)
        }
      })
      .catch(() => {
        // Quiet failure — terminal panel just stays in a "loading" state.
      })
    return () => {
      cancelled = true
    }
  }, [sid])

  const enter = (entry: FileEntry) => {
    if (entry.is_dir) {
      setCwd(cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`)
      setSelected(null)
      return
    }
    setSelected(entry.name)
    const path = cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`
    previewFile(sid, path)
      .then((r) => {
        setPreviewName(entry.name)
        setPreviewText(r.binary ? '(binary file — use Download)' : r.text)
        setPreviewOpen(true)
      })
      .catch((err) => alert(`preview failed: ${err}`))
  }

  const goUp = () => {
    if (cwd === '/') return
    const parts = cwd.split('/').filter(Boolean)
    parts.pop()
    setCwd('/' + parts.join('/'))
  }

  const breadcrumbs = cwd.split('/').filter(Boolean)
  const goTo = (i: number) => setCwd('/' + breadcrumbs.slice(0, i + 1).join('/'))

  const handleMkdir = async () => {
    const name = prompt('Folder name:')
    if (!name) return
    await mkdir.mutateAsync({
      server_id: sid,
      path: cwd === '/' ? `/${name}` : `${cwd}/${name}`,
      mode: 0o755,
    })
  }

  const handleRm = (entry: FileEntry) => {
    setRemoveTarget(entry)
  }

  const queueUpload = (files: FileList | File[]) => {
    const arr = Array.from(files)
    for (const f of arr) {
      const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const dst = cwd === '/' ? `/${f.name}` : `${cwd}/${f.name}`
      const xhr = uploadFileWithProgress(sid, dst, f, (loaded, total) => {
        setTransfers((prev) =>
          prev.map((tr) =>
            tr.id === id ? { ...tr, loaded, progress: total ? (loaded / total) * 100 : 0 } : tr,
          ),
        )
      })
      setTransfers((prev) => [
        {
          id,
          name: f.name,
          dir: 'up',
          size: f.size,
          loaded: 0,
          progress: 0,
          status: 'active',
          host: host?.name ?? '',
          cancel: xhr.cancel,
        },
        ...prev,
      ])
      xhr.promise
        .then(() => {
          setTransfers((prev) =>
            prev.map((tr) => (tr.id === id ? { ...tr, status: 'done', progress: 100 } : tr)),
          )
          refetch()
        })
        .catch((err) => {
          if (String(err).includes('aborted')) {
            setTransfers((prev) =>
              prev.map((tr) => (tr.id === id ? { ...tr, status: 'cancelled' } : tr)),
            )
          } else {
            setTransfers((prev) =>
              prev.map((tr) => (tr.id === id ? { ...tr, status: 'error' } : tr)),
            )
          }
        })
    }
  }

  const handleUploadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) queueUpload(e.target.files)
    e.target.value = ''
  }

  const handleDownload = (entry: FileEntry) => {
    const url = downloadFileURL(sid, cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`)
    // Open in a hidden anchor — keeps the queue UI honest about pending
    // requests even though the browser owns the actual byte stream.
    const id = `t_${Date.now().toString(36)}`
    setTransfers((prev) => [
      {
        id,
        name: entry.name,
        dir: 'down',
        size: entry.size,
        loaded: entry.size,
        progress: 100,
        status: 'done',
        host: host?.name ?? '',
      },
      ...prev,
    ])
    const a = document.createElement('a')
    a.href = url
    a.download = entry.name
    a.click()
  }

  const transfersActive = useMemo(() => transfers.filter((t) => t.status === 'active').length, [
    transfers,
  ])

  return (
    <div className="space-y-4">
      <div>
        <PageHeader
          title={<>{t('files.title', 'Files')} &amp; shell</>}
          actions={
            <select
              value={sid}
              onChange={(e) => navigate(`/admin/files/${e.target.value}`)}
              className="h-8 px-2.5 rounded-md border bg-background text-sm font-mono w-full sm:w-[280px]"
            >
              {(serversQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.ssh_host?.String ? ` · ${s.ssh_host.String}` : ''}
                </option>
              ))}
            </select>
          }
        />
        <p className="text-muted-foreground text-sm mt-1">
          {t(
            'files.page_sub',
            'Browse the remote filesystem and run a PTY through the Shepherd agent. Every action is audit-logged.',
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* File browser */}
        <div className="border rounded-lg bg-elev flex flex-col h-[460px] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <Button
              variant="ghost"
              size="xs"
              onClick={goUp}
              className="w-7 p-0"
              aria-label="up"
              disabled={cwd === '/'}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <div className="flex items-center gap-1 text-xs font-mono min-w-0 flex-1 overflow-hidden">
              <button
                onClick={() => setCwd('/')}
                className="text-muted-foreground hover:text-foreground"
              >
                /
              </button>
              {breadcrumbs.map((p, i) => (
                <span key={i} className="flex items-center gap-1 min-w-0">
                  <span className="text-fg-dim">/</span>
                  <button
                    onClick={() => goTo(i)}
                    className={cn(
                      'hover:text-foreground truncate',
                      i === breadcrumbs.length - 1 ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    {p}
                  </button>
                </span>
              ))}
            </div>
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleUploadInput}
              multiple
              className="hidden"
            />
            <Button
              variant="outline"
              size="xs"
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon className="h-3.5 w-3.5 mr-1" />
              {t('files.upload', 'Upload')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={handleMkdir}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="px-3 py-1.5 border-b flex items-center gap-1.5 flex-wrap">
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitPath()}
              placeholder="/tmp"
              className="font-mono text-xs flex-1 min-w-[120px] h-7 px-2 border rounded bg-background"
            />
            {QUICK_PATHS.map((p) => (
              <button
                key={p}
                onClick={() => setCwd(p)}
                className={cn(
                  'px-2 h-7 text-2xs rounded border font-mono transition-colors',
                  cwd === p ? 'bg-sunken' : 'hover:bg-sunken',
                )}
              >
                {p}
              </button>
            ))}
          </div>

          <div
            className={cn(
              'relative flex-1 overflow-auto',
              dragOver && 'bg-accent/40 outline-2 outline-dashed outline-primary',
            )}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files.length > 0) queueUpload(e.dataTransfer.files)
            }}
          >
            {isLoading ? (
              <LoadingState />
            ) : error ? (
              <ErrorState message={(error as Error).message} onRetry={refetch} />
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-elev">
                  <tr>
                    <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-3 py-1.5">
                      {t('files.name', 'Name')}
                    </th>
                    <th className="text-right font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-3 py-1.5">
                      {t('files.size', 'Size')}
                    </th>
                    <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-3 py-1.5 hidden md:table-cell">
                      {t('files.mode', 'Perms')}
                    </th>
                    <th className="text-left font-medium text-muted-foreground text-2xs uppercase tracking-[0.05em] px-3 py-1.5 hidden lg:table-cell">
                      {t('files.mtime', 'Modified')}
                    </th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(data ?? []).map((entry) => (
                    <tr
                      key={entry.name}
                      className={cn(
                        'border-t cursor-pointer hover:bg-sunken/60',
                        selected === entry.name && 'bg-sunken',
                      )}
                      onClick={() => setSelected(entry.name)}
                      onDoubleClick={() => enter(entry)}
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-fg-dim w-3 text-center shrink-0">
                            {entry.is_dir ? '▸' : '·'}
                          </span>
                          {entry.is_dir ? (
                            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              enter(entry)
                            }}
                            className="font-mono truncate hover:underline text-left"
                          >
                            {entry.name}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-fg-dim text-2xs tabular-nums whitespace-nowrap">
                        {entry.is_dir ? '—' : formatSize(entry.size)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-fg-dim text-2xs hidden md:table-cell">
                        {formatMode(entry.mode)}
                      </td>
                      <td className="px-3 py-1.5 font-mono text-fg-dim text-2xs whitespace-nowrap hidden lg:table-cell">
                        {new Date(entry.mtime * 1000).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        {!entry.is_dir && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="w-7 p-0"
                            aria-label="download"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDownload(entry)
                            }}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="xs"
                          className="w-7 p-0"
                          aria-label="delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRm(entry)
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="border-t px-3 py-1.5 flex items-center justify-between text-2xs text-fg-dim font-mono">
            <span>
              {data?.length ?? 0} {t('files.items', 'items')}
            </span>
            <span>{t('files.drop_hint', 'drop files here to upload')}</span>
          </div>
        </div>

        {/* Terminal */}
        <div className="border rounded-lg bg-elev flex flex-col h-[460px] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b">
            <span className="font-mono text-sm truncate">
              {host?.name ?? `#${sid}`}:{cwd}
            </span>
            <Pill kind={ptySid ? 'ok' : 'neutral'}>pty</Pill>
            <span className="ml-auto text-fg-dim text-2xs font-mono">
              {auditId ? `audit_id=ses_${auditId}` : 'opening…'}
            </span>
          </div>
          <div className="flex-1 bg-console">
            {ptySid ? (
              <XtermPane tabId={`files-${ptySid}`} sid={ptySid} />
            ) : (
              <div className="text-xs text-console-muted font-mono p-3">opening PTY…</div>
            )}
          </div>
        </div>
      </div>

      {/* Transfers */}
      <div className="border rounded-lg bg-elev overflow-hidden">
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b">
          <span className="text-foreground font-medium text-sm">
            {t('files.transfers', 'Transfers')}
          </span>
          {transfersActive > 0 && (
            <span className="inline-flex items-center gap-1 h-4 px-1.5 rounded-full bg-warn-soft text-warn text-2xs font-mono">
              {transfersActive} active
            </span>
          )}
          <span className="ml-auto text-fg-dim text-2xs font-mono">
            {transfers.length} {t('files.items', 'items')}
          </span>
        </div>
        {transfers.length === 0 ? (
          <div className="px-3.5 py-6 text-center text-fg-dim text-xs font-mono">
            {t('files.no_transfers', 'no transfers yet')}
          </div>
        ) : (
          transfers.map((tr) => (
            <div
              key={tr.id}
              className="flex items-center gap-3 px-3.5 py-2.5 border-b last:border-b-0 text-xs"
            >
              <span
                className={cn(
                  'font-mono w-4 text-center',
                  tr.dir === 'down' ? 'text-ok' : 'text-primary',
                )}
              >
                {tr.dir === 'down' ? '↓' : '↑'}
              </span>
              <span className="font-mono truncate flex-1 min-w-0">{tr.name}</span>
              <span className="font-mono text-fg-dim text-2xs hidden sm:inline truncate w-[120px]">
                {tr.host}
              </span>
              <span className="font-mono text-fg-dim text-2xs w-[64px] text-right tabular-nums">
                {formatSize(tr.size)}
              </span>
              <div className="hidden sm:block w-[140px] h-1.5 bg-sunken rounded overflow-hidden">
                <div
                  className={cn(
                    'h-full transition-[width]',
                    tr.status === 'done'
                      ? 'bg-ok'
                      : tr.status === 'error'
                        ? 'bg-err'
                        : tr.status === 'cancelled'
                          ? 'bg-fg-dim'
                          : 'bg-primary',
                  )}
                  style={{ width: `${tr.progress}%` }}
                />
              </div>
              <span className="font-mono w-12 text-right tabular-nums text-2xs">
                {tr.status === 'error'
                  ? 'err'
                  : tr.status === 'cancelled'
                    ? 'x'
                    : `${tr.progress.toFixed(0)}%`}
              </span>
              {tr.status === 'active' && tr.cancel && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-2xs"
                  onClick={() => tr.cancel?.()}
                >
                  {t('common.cancel', 'cancel')}
                </Button>
              )}
            </div>
          ))
        )}
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="break-all font-mono">{previewName}</DialogTitle>
          </DialogHeader>
          <pre className="font-mono text-xs whitespace-pre-wrap overflow-auto max-h-[80vh] bg-sunken p-3 rounded">
            {previewText}
          </pre>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t('files.remove')}
        description={t('files.remove_confirm', { name: removeTarget?.name ?? '' })}
        onConfirm={() => {
          if (!removeTarget) return
          const path = cwd === '/' ? `/${removeTarget.name}` : `${cwd}/${removeTarget.name}`
          rm.mutate({ server_id: sid, path, recursive: removeTarget.is_dir })
        }}
      />
    </div>
  )
}
