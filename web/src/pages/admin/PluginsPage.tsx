import { useTranslation } from 'react-i18next'
import { Puzzle } from 'lucide-react'

// Plugin runtime isn't implemented in the backend yet (no agent-side sandbox,
// no signed distribution channel, no per-plugin metric namespace). The page
// is here so the design's sidebar entry resolves; it advertises the planned
// integration surface and links back to a tracking issue when one exists.
export default function PluginsPage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight m-0">
          {t('nav.plugins', 'Plugins')}
        </h1>
        <p className="text-muted-foreground text-[13px] mt-1">
          {t(
            'plugins.subtitle',
            'Extend the Shepherd agent with log parsers, extra metric collectors, and alert routers.',
          )}
        </p>
      </div>
      <div className="border rounded-lg bg-elev p-10 flex flex-col items-center justify-center gap-3 text-center">
        <div className="h-12 w-12 rounded-full bg-sunken grid place-items-center">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="font-medium">
          {t('plugins.placeholder_title', 'Plugin runtime not enabled')}
        </div>
        <p className="text-muted-foreground text-[12.5px] max-w-md">
          {t(
            'plugins.placeholder_body',
            'This release ships without a plugin host. The plugin sandbox, signed distribution, and per-host enablement are tracked separately.',
          )}
        </p>
      </div>
    </div>
  )
}
