/**
 * #7199 这台电脑的全部动作族,顺序 = 设置页里分组的顺序(「连接应用 → 本机」)。
 * 加一族:在 families/ 里写一个 createXxxFamily,再登记到这里。
 */
import type { ActionFamily } from '../catalog'
import { createCalendarFamily } from './calendar'
import { createClipboardFamily } from './clipboard'
import { createContactsFamily } from './contacts'
import { createDeviceFamily } from './device'
import { createExtrasFamily } from './extras'
import { createFilesFamily } from './files'
import { createMailFamily } from './mail'
import { createMessagesFamily } from './messages'
import { createNotesFamily } from './notes'
import { createPerfFamily } from './perf'
import { createRemindersFamily } from './reminders'
import { createSystemFamily } from './system'
import { createScreenFamily } from './screen'

export function createAllFamilies(): ActionFamily[] {
  return [
    createCalendarFamily(),
    createRemindersFamily(),
    createContactsFamily(),
    createNotesFamily(),
    createMailFamily(),
    createMessagesFamily(),
    createFilesFamily(),
    createScreenFamily(),
    createClipboardFamily(),
    createDeviceFamily(),
    createSystemFamily(),
    createExtrasFamily(),
    createPerfFamily(),
  ]
}
