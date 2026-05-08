import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Folder, File as FileIcon, Trash2, Download, Plus, Upload as UploadIcon, RefreshCw } from 'lucide-react'
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

export default function FileBrowserPage() {
  const { t } = useTranslation()
  const { serverId } = useParams<{ serverId: string }>()
  const sid = serverId ? Number(serverId) : 0
  const [cwd, setCwd] = useState('/tmp')
  const { data, isLoading, refetch } = useFiles(sid, cwd)
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
      <h1 className="text-2xl font-semibold">{t('files.title', 'Files')}</h1>
      <div className="flex items-center gap-1 text-sm">
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
      <div className="flex gap-2">
        <Input value={cwd} onChange={(e) => setCwd(e.target.value)} className="font-mono" />
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={handleMkdir}>
          <Plus className="h-4 w-4 mr-1" />
          {t('files.mkdir', 'New folder')}
        </Button>
        <label className="inline-flex items-center gap-1 text-sm border rounded px-3 py-1 cursor-pointer hover:bg-muted">
          <UploadIcon className="h-4 w-4" />
          {t('files.upload', 'Upload')}
          <input type="file" multiple onChange={handleUpload} className="hidden" />
        </label>
      </div>
      {isLoading ? (
        <div>{t('common.loading')}</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('files.name', 'Name')}</TableHead>
              <TableHead className="text-right">{t('files.size', 'Size')}</TableHead>
              <TableHead>{t('files.mode', 'Mode')}</TableHead>
              <TableHead>{t('files.mtime', 'Modified')}</TableHead>
              <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((entry) => (
              <TableRow key={entry.name}>
                <TableCell className="flex items-center gap-2">
                  {entry.is_dir ? <Folder className="h-4 w-4" /> : <FileIcon className="h-4 w-4" />}
                  <button onClick={() => enter(entry)} className="hover:underline">
                    {entry.name}
                  </button>
                </TableCell>
                <TableCell className="text-right text-xs">
                  {entry.is_dir ? '-' : formatSize(entry.size)}
                </TableCell>
                <TableCell className="font-mono text-xs">{formatMode(entry.mode)}</TableCell>
                <TableCell className="text-xs">
                  {new Date(entry.mtime * 1000).toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {!entry.is_dir && (
                    <Button size="icon" variant="ghost" asChild>
                      <a
                        href={downloadFileURL(
                          sid,
                          cwd === '/' ? `/${entry.name}` : `${cwd}/${entry.name}`,
                        )}
                      >
                        <Download className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => handleRm(entry)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{previewName}</DialogTitle>
          </DialogHeader>
          <pre className="font-mono text-xs whitespace-pre-wrap overflow-auto max-h-96 bg-muted p-2">
            {previewText}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  )
}
