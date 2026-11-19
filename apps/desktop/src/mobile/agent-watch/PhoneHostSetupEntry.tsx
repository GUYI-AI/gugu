import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/store/auth'
import { openPhoneAgentSetup } from '../local-agent/PhoneAgentSetupState'
import { platform } from '@/platform'
import './task-flow-catalog'

/** Open the existing guide; the entry itself never changes a host setting or grants a permission. */
export function PhoneHostSetupEntry() {
  const { t } = useTranslation('mobileTaskFlow')
  const ownerId = useAuth().user?.id
  if (!ownerId || !platform.capabilities?.phoneAgentHost) return null
  return (
    <Button variant="secondary" size="lg" data-testid="agent-watch-setup-phone" onClick={() => openPhoneAgentSetup(ownerId)}>
      {t('setupPhone')}
    </Button>
  )
}
