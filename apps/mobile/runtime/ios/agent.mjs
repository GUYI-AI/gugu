/* global __guguMonotonic, __guguUUID, __guguNativeCancel, __guguNativeRequest, __guguNativeEvent, __guguNativeProjection */
import 'core-js/actual/url/index.js'
import { calendarTools } from './calendar-tools.mjs'
import { Agent } from '@earendil-works/pi-agent-core'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import { collapseSystemMessages, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { getSystemMessageText } from '@earendil-works/pi-ai'
import { readNativeTimeline } from './timeline.mjs'
import { nativeChatDelivery } from './delivery.mjs'

// JSC has ECMAScript primitives, but no browser/Node host API. The native boundary
// below is deliberately narrower than fetch/filesystem and never receives a token.
globalThis.performance ??= { now: () => __guguMonotonic() }
globalThis.structuredClone ??= (value) => JSON.parse(JSON.stringify(value))
if (!globalThis.AbortController) {
  class Signal {
    aborted = false
    reason = undefined
    listeners = new Map()
    addEventListener(type, listener, options) {
      if (type === 'abort') this.listeners.set(listener, options?.once === true)
    }
    removeEventListener(type, listener) { if (type === 'abort') this.listeners.delete(listener) }
    throwIfAborted() { if (this.aborted) throw this.reason }
    abort(reason) {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason ?? new Error('Cancelled')
      for (const [listener, once] of [...this.listeners]) {
        if (once) this.listeners.delete(listener)
        listener.call(this, { type: 'abort', target: this })
      }
    }
  }
  globalThis.AbortController = class {
    signal = new Signal()
    abort(reason) { this.signal.abort(reason) }
  }
}

const pending = new Map()
const active = new Map()
const contextFields = ['ownerId', 'installationId', 'agentUserId', 'sessionId', 'jobId', 'contextEpoch', 'runtimeInstanceId']
const sameContext = (left, right) => contextFields.every((key) => left[key] === right[key])
function native(method, payload, signal) {
  signal?.throwIfAborted()
  const requestId = __guguUUID()
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!pending.delete(requestId)) return
      __guguNativeCancel(requestId)
      reject(signal.reason ?? new Error('Cancelled'))
    }
    pending.set(requestId, {
      resolve(value) { signal?.removeEventListener('abort', abort); resolve(value) },
      reject(error) { signal?.removeEventListener('abort', abort); reject(error) },
    })
    signal?.addEventListener('abort', abort, { once: true })
    try { __guguNativeRequest(requestId, method, JSON.stringify(payload)) }
    catch (error) { pending.delete(requestId); signal?.removeEventListener('abort', abort); reject(error) }
  })
}

function text(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some((block) => block.type !== 'text')) throw new Error('This iOS slice accepts text content only')
  return content.map((block) => block.text).join('\n')
}
function openAIRequest(model, context) {
  const messages = collapseSystemMessages(context).messages.map((message) => {
    if (message.role === 'system') return { role: 'system', content: getSystemMessageText(message) }
    if (message.role === 'user') return { role: 'user', content: text(message.content) }
    if (message.role === 'toolResult') return { role: 'tool', tool_call_id: message.toolCallId, content: text(message.content) }
    if (message.role !== 'assistant') throw new Error(`Unsupported message role: ${message.role}`)
    const content = message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
    const calls = message.content.filter((block) => block.type === 'toolCall').map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments) } }))
    const thinking = message.content.filter((block) => block.type === 'thinking').map((block) => block.thinking).join('')
    return { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), ...(thinking ? { reasoning_content: thinking } : {}) }
  })
  const tools = getCurrentTools(context.messages).map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  return { model: model.id, messages, stream: false, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) }
}
function assistant(model, raw) {
  const choice = raw.choices?.[0]
  if (!choice?.message || !['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) throw new Error('Model response has no supported completed choice')
  const source = choice.message
  const content = []
  if (source.reasoning_content) content.push({ type: 'thinking', thinking: source.reasoning_content })
  if (source.content) {
    if (typeof source.content !== 'string') throw new Error('Model returned non-text content')
    content.push({ type: 'text', text: source.content })
  }
  for (const call of source.tool_calls ?? []) {
    if (call.type !== 'function' || !call.id || !call.function?.name) throw new Error('Model returned an invalid tool call')
    const args = JSON.parse(call.function.arguments)
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Tool arguments must be an object')
    content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args })
  }
  const input = raw.usage?.prompt_tokens ?? 0
  const output = raw.usage?.completion_tokens ?? 0
  return { role: 'assistant', content, api: 'openai-completions', provider: 'gugu', model: model.id,
    stopReason: choice.finish_reason === 'tool_calls' ? 'toolUse' : choice.finish_reason,
    timestamp: Date.now(), usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: raw.usage?.total_tokens ?? input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
function streamFor(context) {
  return (model, transcript, options) => {
    const stream = new AssistantMessageEventStream()
    void (async () => {
      try {
        const response = await native('model.complete', { context, body: openAIRequest(model, transcript) }, options.signal)
        options.signal?.throwIfAborted()
        const message = assistant(model, response)
        stream.push({ type: 'done', reason: message.stopReason, message })
        stream.end(message)
      } catch (error) {
        const message = { role: 'assistant', content: [], api: 'openai-completions', provider: 'gugu', model: model.id,
          stopReason: options.signal?.aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
        stream.push({ type: 'error', reason: message.stopReason, error: message })
        stream.end(message)
      }
    })()
    return stream
  }
}

async function run(command) {
  const { context } = command
  if (active.has(context.sessionId)) throw new Error('Session is already running')
  const tools = calendarTools(command.tools, (toolCallId, actionName, args, signal) => native('tool.execute', { context, toolCallId, actionName, args }, signal))
  const model = { id: command.modelId, api: 'openai-completions', provider: 'gugu' }
  const agent = new Agent({ initialState: { model, systemPrompt: command.systemPrompt, tools, messages: command.messages ?? [], thinkingLevel: 'off' },
    streamFn: streamFor(context), toolExecution: 'sequential', sessionId: context.sessionId })
  active.set(context.sessionId, { context, agent })
  agent.subscribe(async (event) => {
    await native('journal.event', { context, event, ...(event.type === 'message_end' ? { messages: agent.state.messages } : {}) })
    __guguNativeEvent(JSON.stringify({ context, event }))
  })
  try {
    await agent.prompt(command.prompt)
    const last = agent.state.messages.at(-1)
    const status = last?.stopReason === 'aborted' ? 'cancelled' : last?.stopReason === 'error' ? 'failed' : 'done'
    const result = { context, status, messages: agent.state.messages, ...(last?.errorMessage ? { error: last.errorMessage } : {}),
      text: status === 'done' && last?.role === 'assistant' ? last.content.filter((block) => block.type === 'text').map((block) => block.text).join('') : '' }
    await native('turn.finished', result)
  } catch (error) {
    await native('turn.finished', { context, status: agent.signal?.aborted ? 'cancelled' : 'failed', text: '', error: error.message, messages: agent.state.messages })
  } finally {
    if (active.get(context.sessionId)?.agent === agent) active.delete(context.sessionId)
  }
}

globalThis.GuguIOSRuntime = Object.freeze({
  diagnostics: () => JSON.stringify({ protocolVersion: 1, piVersion: '1.4.0', engine: 'JavaScriptCore', node: typeof process !== 'undefined' }),
  timeline(id, json) {
    void Promise.resolve().then(() => readNativeTimeline(JSON.parse(json))).then(
      data => __guguNativeProjection(id, JSON.stringify({ ok: true, data })),
      error => __guguNativeProjection(id, JSON.stringify({ ok: false, code: error.code ?? 'record_unreadable', message: error.message })),
    )
  },
  delivery(id, json) {
    void Promise.resolve().then(() => nativeChatDelivery(JSON.parse(json))).then(
      data => __guguNativeProjection(id, JSON.stringify({ ok: true, data })),
      error => __guguNativeProjection(id, JSON.stringify({ ok: false, code: error.code ?? 'delivery_invalid', message: error.message })),
    )
  },
  start(json) {
    const command = JSON.parse(json)
    void run(command).catch(async (error) => {
      try { await native('turn.finished', { context: command.context, status: 'failed', text: '', error: error.message }) }
      finally { __guguNativeEvent(JSON.stringify({ type: 'host_error', context: command.context, message: error.message })) }
    })
  },
  cancel(json) {
    const context = JSON.parse(json)
    const turn = active.get(context.sessionId)
    if (!turn || !sameContext(turn.context, context)) return false
    turn.agent.abort()
    return true
  },
  settle(requestId, json) {
    const request = pending.get(requestId)
    if (!request) return false
    pending.delete(requestId)
    const result = JSON.parse(json)
    if (result.ok === true) request.resolve(result.data)
    else request.reject(Object.assign(new Error(result.message ?? 'Native request failed'), { code: result.code }))
    return true
  },
})
