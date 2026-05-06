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
