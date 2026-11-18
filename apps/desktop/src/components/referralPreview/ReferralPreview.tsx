import { useState } from 'react'
import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { InvitationPanel } from './InvitationPanel'
import { ReferralClaimField } from './ReferralClaimField'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { SharePosterDialog, type SharePosterDialogProps } from '../SharePosterDialog'
import { Button } from '../ui/Button'
import { SegmentedTabs } from '../ui/SegmentedTabs'
import { MenuItem } from '../ui/Menu'
import { SettingsGroup, SettingsRow } from '../settings/SettingsPrimitives'
import { Mail, X } from '@/lib/icons'
import { Sheet } from '../ui/Sheet'
import { IconButton } from '../ui/IconButton'
import { useReferral } from './useReferral'
import { referralOffer } from './referralOffer'
import '../../i18n/registerMainCatalog'
import './referralPreview.css'

const referralEnabled = () => officialServicesEnabled()

/** Both entry points use the existing QR sheet; other people's cards stay unchanged. */
export function PersonalSharePreview({
  initialPurpose = 'contact',
  ...props
}: SharePosterDialogProps & { initialPurpose?: 'invite' | 'contact' }) {
  const { t } = useTranslation('main')
  const [purpose, setPurpose] = useState<'invite' | 'contact'>(initialPurpose)
  if (!referralEnabled()) return <SharePosterDialog {...props} />
  return (
    <SharePosterDialog
      {...props}
      subtitle=""
      qrCaption={t('referralPreview.contactCaption')}
      ctaText={t('referralPreview.contactFooter')}
      posterVariant="contact"
      heading={t('referralPreview.sharePurpose')}
      headerContent={
        <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
          <SegmentedTabs<'invite' | 'contact'>
            ariaLabel={t('referralPreview.sharePurpose')}
            items={[
              { value: 'invite', label: t('referralPreview.invite') },
              { value: 'contact', label: t('referralPreview.myCard') }
            ]}
            value={purpose}
            onChange={setPurpose}
          />
        </div>
      }
      previewContent={
        purpose === 'invite' ? (
          <InvitationPanel />
        ) : !props.qrValue ? (
          <p className="p-5 text-[var(--muted-fg)]" role="status">
            {t('referralPreview.noNumber')}
          </p>
        ) : undefined
      }
    />
  )
}

export function ReferralSharePreview({ onClose, zIndex }: { onClose: () => void; zIndex?: string }) {
  const { t } = useTranslation(['main', 'common'])
  return <Sheet onClose={onClose} zIndex={zIndex} ariaLabel={t('referralPreview.invite')} desktopWidth="440px" desktopHeight="560px" desktopMaxHeight="calc(100dvh - 48px)">
    <div className="gg-referral-dialog">
      <div className="gg-referral-dialog-heading"><h2>{t('referralPreview.invite')}</h2>
        <IconButton aria-label={t('common:dialog.close')} size="sm" onClick={onClose}><X size={18} /></IconButton>
      </div>
      <InvitationPanel />
    </div>
  </Sheet>
}

export function InviteFriendsMenuItem({ onSelect }: { onSelect: () => void }) {
  const { t } = useTranslation('main')
  if (!referralEnabled()) return null
  return (
    <MenuItem data-testid="referral-preview-menu" icon={<Mail size={15} />} onClick={onSelect}>
      <span className="flex items-center gap-2">{t('referralPreview.invite')}</span>
    </MenuItem>
  )
}

export function InviteFriendsPreview() {
  const { t } = useTranslation('main')
  const [open, setOpen] = useState(false)
  if (!referralEnabled()) return null
  return (
    <>
      <div className="mt-1 flex justify-center">
        <Button
          variant="ghost"
          size="sm"
          data-testid="referral-preview-search"
          onClick={() => setOpen(true)}
        >
          <Mail size={15} aria-hidden />
          {t('referralPreview.inviteToGugu')}
        </Button>
      </div>
      {open && <ReferralSharePreview onClose={() => setOpen(false)} />}
    </>
  )
}

export function ReferralAccountPreview() {
  if (!referralEnabled()) return null
  return <ReferralAccountEntry />
}
function ReferralAccountEntry() {
  const { user } = useAuth()
  const { t } = useTranslation('main')
  const { data, failed } = useReferral(user?.id)
  const [open, setOpen] = useState(false)
  const offer = data ? referralOffer(data) : null
  return <>
    <SettingsGroup className="gg-referral-account-preview">
      <SettingsRow title={t('referralPreview.invite')}
        description={offer ? t(`referrals.offer.${offer.key}`, offer) : t(failed ? 'referrals.unavailable' : 'referrals.loading')}
        control={<div className="flex items-center gap-3">
          {data && <span className="text-[length:var(--font-caption)] text-[var(--muted-fg)]">{t('referrals.accountCount', { count: data.successful_invitations })}</span>}
          <Button variant="secondary" size="sm" data-testid="referral-preview-account" onClick={() => setOpen(true)}>{t('referrals.invite')}</Button>
        </div>} />
    </SettingsGroup>
    {open && <ReferralSharePreview zIndex="var(--z-settings-modal)" onClose={() => setOpen(false)} />}
  </>
}

export function ReferralCodePreview({ userId }: { userId: string }) {
  if (!referralEnabled()) return null
  return <ReferralClaimField key={userId} userId={userId} />
}
