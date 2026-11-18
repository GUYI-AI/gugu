import type { IncomingHttpHeaders } from 'node:http'

// These are protocol vocabulary, never arbitrary provider prose or field values.
const ERROR_TYPES = new Set(['invalid_request_error', 'invalid_request', 'bad_request', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'overloaded_error', 'api_error'])
const ERROR_CODES = new Set(['invalid_request', 'invalid_request_error', 'invalid_parameter', 'unsupported_parameter', 'unknown_parameter', 'context_length_exceeded', 'max_tokens_exceeded', 'request_too_large', 'model_not_found', 'insufficient_quota', 'rate_limit_exceeded'])
const PARAM_PARTS = new Set(['model', 'messages', 'system', 'tools', 'thinking', 'max_tokens', 'stream', 'output_config', 'context_management', 'metadata', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'content', 'type', 'text', 'input', 'name', 'id', 'tool_use_id', 'input_schema', 'properties', 'required', 'effort', 'budget_tokens', 'display', 'edits', 'keep', 'cache_control', 'ttl', 'role'])
const MAX_ERROR_BYTES = 16 * 1024

export interface PlatformHttpErrorDiagnostic {
  status: 400
  bodyInspection: 'json' | 'unavailable' | 'oversized' | 'incomplete'
  errorType?: string
  errorCode?: string
  param?: string
  requestId?: string
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function requestId(value: unknown): string | undefined {
  // Known request-id formats only; do not accept an arbitrary token-shaped string.
  return typeof value === 'string' && /^(?:\d{26}[a-zA-Z0-9]{13}|req_[a-zA-Z0-9]{8,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value) ? value : undefined
}

function parameter(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128) return undefined
  // No quoted properties or values. Unknown property names are omitted, not scrubbed.
  if (!/^[a-z_]+(?:(?:\.[a-z_]+)|(?:\.\d{1,4})|(?:\[\d{1,4}\]))*$/.test(value)) return undefined
  const parts = value.replace(/\[(\d+)\]/g, '.$1').split('.')
  return parts.every(part => PARAM_PARTS.has(part) || /^\d{1,4}$/.test(part)) ? value : undefined
}

/** Bounded passive observation. No messages, credentials, URLs or raw errors leave this class. */
export class PlatformHttpErrorRecorder {
  private chunks: Buffer[] = []
  private size = 0
  private readonly inspectBody: boolean
  private readonly headerId: string | undefined

  constructor(headers: IncomingHttpHeaders) {
    this.inspectBody = /^(?:application\/json|application\/[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(String(headers['content-type'] ?? ''))
      && ['', 'identity'].includes(String(headers['content-encoding'] ?? '').toLowerCase())
    this.headerId = requestId(headers['request-id']) ?? requestId(headers['x-request-id'])
  }

  data(chunk: Buffer): void {
    if (!this.inspectBody || this.size > MAX_ERROR_BYTES) return
    this.size += chunk.length
    if (this.size > MAX_ERROR_BYTES) this.chunks = []
    else this.chunks.push(Buffer.from(chunk))
  }

  finish(complete: boolean): PlatformHttpErrorDiagnostic {
    const diagnostic: PlatformHttpErrorDiagnostic = {
      status: 400,
      bodyInspection: !complete ? 'incomplete' : this.size > MAX_ERROR_BYTES ? 'oversized' : 'unavailable',
      ...(this.headerId ? { requestId: this.headerId } : {}),
    }
    if (!complete || !this.inspectBody || this.size > MAX_ERROR_BYTES) return diagnostic
    let body: Record<string, unknown>
    try { body = record(JSON.parse(Buffer.concat(this.chunks).toString('utf8'))) } catch { return diagnostic }
    this.chunks = []
    diagnostic.bodyInspection = 'json'
    const error = record(body.error)
    if (typeof error.type === 'string' && ERROR_TYPES.has(error.type)) diagnostic.errorType = error.type
    if (typeof error.code === 'string' && ERROR_CODES.has(error.code)) diagnostic.errorCode = error.code
    const param = parameter(error.param)
    if (param) diagnostic.param = param
    const id = this.headerId ?? requestId(body.request_id) ?? requestId(error.request_id)
    if (id) diagnostic.requestId = id
    return diagnostic
  }
}
