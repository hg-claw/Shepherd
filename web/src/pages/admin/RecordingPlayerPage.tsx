import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function RecordingPlayerPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current || !id) return
    let player: { dispose?: () => void } | null = null
    let cancelled = false
    ;(async () => {
      // @ts-expect-error no types
      const ap: typeof import('asciinema-player') = await import('asciinema-player')
      // also pull the css
      await import('asciinema-player/dist/bundle/asciinema-player.css')
      if (cancelled) return
      player = ap.create(`/api/admin/recordings/${id}/cast`, ref.current!)
    })()
    return () => {
      cancelled = true
      player?.dispose?.()
    }
  }, [id])

  return (
    <div className="space-y-4">
      <h1 className="text-xl sm:text-2xl font-semibold">{t('recording.title')}</h1>
      <div ref={ref} className="border rounded overflow-hidden" />
    </div>
  )
}
