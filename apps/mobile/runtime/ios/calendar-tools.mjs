import { PHONE_ACTIONS } from '../../../desktop/src/mobile/phone-device/phoneActionCatalog.ts'
import { utcOffsetOf } from '../../../desktop/src/mobile/phone-device/phoneTime.ts'
import { withCalendarTransport } from './calendar-bridge.mjs'

const allowed = new Map(PHONE_ACTIONS.filter((action) => action.group === 'calendar').map((action) => [action.name, action]))
const blockedFields = ['confirmed', 'approval', 'internalApproval', 'ownerId', 'context', 'requestId', 'toolCallId']
export function calendarTools(definitions, invoke) {
  return definitions.map(({ name, actionName }) => {
    const action = allowed.get(actionName)
    if (!action || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Unsupported iOS calendar tool definition')
    const parameters = structuredClone(action.input_schema)
    delete parameters.properties.confirmed
    parameters.additionalProperties = false
    const description = actionName === 'calendar.events.update' || actionName === 'calendar.events.delete'
      ? '修改或删除这台手机的单次日程；重复日程写入暂不支持。必须由主人在本机任务页对确切参数批准一次。'
      : action.description({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, utcOffset: utcOffsetOf(new Date()) })
    return { name, description, parameters,
      execute: async (toolCallId, args, signal) => {
        let originalFailure
        try {
          if (blockedFields.some((field) => Object.hasOwn(args, field))) throw Object.assign(new Error('Model arguments cannot supply host identity or approval'), { code: 'invalid_args' })
          const data = await withCalendarTransport(async (normalizedAction, normalizedArgs) => {
            if (normalizedAction !== actionName) throw new Error('Calendar native action mismatch')
            // Digest, approval and admission happen natively on this normalized
            // payload. Nothing touches EventKit during catalog projection.
            const envelope = await invoke(toolCallId, normalizedAction, normalizedArgs, signal)
            if (envelope.ok !== true) {
              originalFailure = envelope
              throw Object.assign(new Error(envelope.message ?? 'Native calendar action failed'), { code: envelope.code })
            }
            return envelope.data
          }, () => action.run(args))
          const result = { ok: true, data }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result }
        } catch (error) {
          const result = originalFailure ?? { ok: false, code: error.code ?? 'execution_failed', message: error.message }
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError: true }
        }
      },
    }
  })
}
