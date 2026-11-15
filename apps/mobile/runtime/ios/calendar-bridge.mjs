// A catalog action normalizes its arguments synchronously before its first native
// await. Capture the invocation at that boundary, rather than keeping a mutable
// context alive across promises. Calls outside that synchronous scope fail loud.
let transport = null
const methods = Object.freeze({ calendarList: 'calendar.events.list', calendarCreate: 'calendar.events.create', calendarUpdate: 'calendar.events.update', calendarDelete: 'calendar.events.delete' })
export function withCalendarTransport(invoke, work) {
  const previous = transport
  transport = invoke
  try { return work() } finally { transport = previous }
}
export function registerPlugin(plugin) {
  return new Proxy({}, { get(_target, method) {
    if (method === 'then' || typeof method !== 'string') return undefined
    return (args = {}) => {
      const invoke = transport
      const actionName = plugin === 'GuguPhoneActions' ? methods[method] : undefined
      if (!invoke || !actionName) throw new Error('Unsupported or unscoped iOS native action')
      return invoke(actionName, args)
    }
  } })
}
