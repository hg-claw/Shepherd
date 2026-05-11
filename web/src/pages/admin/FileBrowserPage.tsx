import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Folder, File as FileIcon, Trash2, Download, Plus, Upload as UploadIcon, RefreshCw, ArrowRight } from 'lucide-react'
import {
  useFiles,
  useMkdir,
  useRm,
  previewFile,
  downloadFileURL,
  uploadFile,
  type FileEntry,
} from '@/api/files'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

function formatMode(m: number): string {
  return (m & 0o777).toString(8).padStart(3, '0')
}
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} M`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} G`
}

// Quick-jump shortcuts. Picks paths the default sandbox whitelists, with
// macOS /Users alongside Linux /home so the same chips work on either OS.
const QUICK_PATHS: string[] = ['/tmp', '/Users', '/home', '/var/log', '/etc/shepherd', '/opt', '/srv']

export default function FileBrowserPage() {
  const { t } = useTranslation()
  const { serverId } = useParams<{ serverId: string }>()
  const sid = serverId ? Number(serverId) : 0
  const [cwd, setCwd] = useState('/tmp')
  // Decoupled input state so typing into the path bar doesn't fire one
  // useFiles request per keystroke. Submit explicitly via Enter or arrow.
  const [pathInput, setPathInput] = useState(cwd)
  useEffect(() => { setPathInput(cwd) }, [cwd])
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

  const enter = (entry: FileEntry) => {
    if (entry.is_dir) {
      setCwd(cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`)
      return
    }
    const path = cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`
    previewFile(sid, path)
      .then((r) => {
        setPreviewName(entry.name)
        if (r.binary) {
          setPreviewText('(binary file — use Download)')
        } else {
          setPreviewText(r.text)
        }
        setPreviewOpen(true)
      })
      .catch((err) => alert(`preview failed: ${err}`))
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

  const handleRm = async (entry: FileEntry) => {
    if (!confirm(`Remove ${entry.name}?`)) return
    const path = cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`
    await rm.mutateAsync({ server_id: sid, path, recursive: entry.is_dir })
  }

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const f of Array.from(files)) {
      const dst = cwd === '/' ? `/${f.name}` : `${cwd}/${f.name}`
      await uploadFile(sid, dst, f)
    }
    refetch()
    e.target.value = ''
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('files.title', 'Files')}</h1>
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <button onClick={() => setCwd('/')} className="hover:underline">/</button>
        {breadcrumbs.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <button onClick={() => goTo(i)} className="hover:underline">
              {p}
            </button>
            {i < breadcrumbs.length - 1 && <span className="text-muted-foreground">/</span>}
          </span>
        ))}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex gap-2 flex-1 min-w-0">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitPath() }}
            placeholder="/tmp"
            className="font-mono flex-1 min-w-0"
          />
          <Button size="sm" variant="outline" onClick={submitPath} title={t('files.go', 'Go')}>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => refetch()} aria-label="refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={handleMkdir}>
            <Plus className="h-4 w-4 mr-1" />
            <span className="hidden sm:inline">{t('files.mkdir', 'New folder')}</span>
          </Button>
          <label className="inline-flex items-center gap-1 text-sm border rounded px-3 py-1 cursor-pointer hover:bg-muted">
            <UploadIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t('files.upload', 'Upload')}</span>
            <input type="file" multiple onChange={handleUpload} className="hidden" />
          </label>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {QUICK_PATHS.map((p) => (
          <button
            key={p}
            onClick={() => setCwd(p)}
            className={`px-2 py-0.5 text-xs rounded border transition-colors ${cwd === p ? 'bg-muted' : 'hover:bg-muted'}`}
          >
            {p}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div>{t('common.loading')}</div>
      ) : error ? (
        <div className="text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('files.name', 'Name')}</TableHead>
                <TableHead className="text-right">{t('files.size', 'Size')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('files.mode', 'Mode')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('files.mtime', 'Modified')}</TableHead>
                <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((entry) => (
                <TableRow key={entry.name}>
                  <TableCell>
                    <div className="flex items-center gap-2 min-w-0">
                      {entry.is_dir ? <Folder className="h-4 w-4 shrink-0" /> : <FileIcon className="h-4 w-4 shrink-0" />}
                      <button onClick={() => enter(entry)} className="hover:underline truncate text-left">
                        {entry.name}
                      </button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs whitespace-nowrap tabular-nums">
                    {entry.is_dir ? '-' : formatSize(entry.size)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell font-mono text-xs">{formatMode(entry.mode)}</TableCell>
                  <TableCell className="hidden md:table-cell text-xs whitespace-nowrap">
                    {new Date(entry.mtime * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {!entry.is_dir && (
                      <Button size="icon" variant="ghost" asChild>
                        <a
                          href={downloadFileURL(
                            sid,
                            cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`,
                          )}
                          aria-label="download"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => handleRm(entry)} aria-label="delete">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl w-[calc(100vw-2rem)]">
          <DialogHeader>
            <DialogTitle className="break-all">{previewName}</DialogTitle>
          </DialogHeader>
          <pre className="font-mono text-xs whitespace-pre-wrap overflow-auto max-h-[60vh] bg-muted p-2">
            {previewText}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}
