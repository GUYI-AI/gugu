import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { Check, Hash, MessageCircle } from '@/lib/icons'
import { preserveComposerFocus } from '../composer/composer-focus'
import './room-composer-catalog'

export function PhoneTopicChoice({ name, unread, selected, onClick, main = false, id }: {
  name: string; unread: number; selected: boolean; onClick: () => void; main?: boolean; id?: string
}) {
  const { t } = useTranslation('mobileRoomControls')
  return <Button variant="ghost" className="gg-phone-room-choice" role="radio" aria-checked={selected}
    data-testid={main ? 'phone-room-main' : 'phone-room-topic'} data-topic-id={id}
    onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClick}>
    {main ? <MessageCircle aria-hidden /> : <Hash aria-hidden />}
    <span className="gg-phone-room-choice-name">{name}</span>
    {unread > 0 && <Chip shape="count" tone="danger" aria-label={t('unread', { count: unread })}>{unread.toLocaleString()}</Chip>}
    {selected && <Check className="gg-phone-room-check" aria-hidden />}
  </Button>
}
