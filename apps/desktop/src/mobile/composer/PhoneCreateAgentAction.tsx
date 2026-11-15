import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SquarePen } from '@/lib/icons'
import { preserveComposerFocus } from './composer-focus'
import '../agent-watch/create-controls-catalog'

export function PhoneCreateAgentAction({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation('mobileCreateControls')
  return <Button variant="ghost" className="gg-phone-composer-choice" data-testid="phone-create-agent"
    onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onCreate}>
    <SquarePen aria-hidden /><span>{t('createAgent')}</span>
  </Button>
}
