import { describe, expect, it } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import { PlatformHttpErrorRecorder } from '../../../../apps/desktop/electron/sessionpage/platform-http-error'

const id = '20261116000000000000000000aBcDeFgHiJkLm'
function observe(body: unknown, headers: IncomingHttpHeaders = { 'content-type': 'application/json' }) {
  const recorder = new PlatformHttpErrorRecorder(headers)
  const wire = Buffer.from(JSON.stringify(body))
  recorder.data(wire.subarray(0, 17))
  recorder.data(wire.subarray(17))
  return recorder.finish(true)
}

describe('safe platform HTTP rejection metadata', () => {
  it('retains recognized protocol fields without copying prose or arbitrary fields', () => {
    const result = observe({ request_id: id, error: {
      type: 'invalid_request_error', code: 'unsupported_parameter', param: 'messages[2].content.0.type',
      message: 'private prompt and Bearer private-credential', headers: { authorization: 'private-credential' },
    }, request: { messages: ['private prompt'] } })
    expect(result).toEqual({ status: 400, bodyInspection: 'json', requestId: id,
      errorType: 'invalid_request_error', errorCode: 'unsupported_parameter', param: 'messages[2].content.0.type' })
    expect(JSON.stringify(result)).not.toMatch(/private|Bearer|authorization|headers/)
  })

  it.each(['privatecredential', 'messages.privatecredential', 'messages["privatecredential"]', 'Bearer credential', 'model\nprivate'])('omits unsafe parameter %s', param => {
    expect(observe({ error: { param } })).toEqual({ status: 400, bodyInspection: 'json' })
  })

  it('omits credential-shaped or unrecognized values even in allowlisted keys', () => {
    expect(observe({ request_id: 'sk-private', error: { type: 'privatecredential', code: 'privatecredential', param: ['model'] } },
      { 'content-type': 'application/json', 'x-request-id': 'Bearer privatecredential' }))
      .toEqual({ status: 400, bodyInspection: 'json' })
  })

  it('does not extract identifiers or guess causes from a generic error message', () => {
    expect(observe({ error: { message: `try again (request id: ${id})` } }))
      .toEqual({ status: 400, bodyInspection: 'json' })
  })

  it('retains a recognized header ID when the error body cannot safely be inspected', () => {
    const recorder = new PlatformHttpErrorRecorder({ 'content-type': 'application/json', 'x-request-id': id })
    recorder.data(Buffer.from('not JSON private prompt'))
    expect(recorder.finish(true)).toEqual({ status: 400, bodyInspection: 'unavailable', requestId: id })
  })

  it('prefers the safe HTTP request ID over an ID in the body and accepts JSON media types', () => {
    const result = observe({ request_id: 'req_bodyIdentifier123', error: { type: 'invalid_request_error' } }, {
      'content-type': 'application/problem+json; charset=utf-8', 'request-id': id,
    })
    expect(result).toEqual({ status: 400, bodyInspection: 'json', requestId: id, errorType: 'invalid_request_error' })
  })

  it.each([null, [], 42, 'private response'])('does not copy non-object JSON: %j', body => {
    expect(observe(body)).toEqual({ status: 400, bodyInspection: 'json' })
  })

  it.each([
    { 'content-type': 'text/html' },
    { 'content-type': 'text/event-stream' },
    { 'content-type': 'application/json', 'content-encoding': 'gzip' },
  ])('does not inspect non-JSON or compressed responses: %j', headers => {
    expect(observe({ error: { type: 'invalid_request_error', param: 'model' } }, headers))
      .toEqual({ status: 400, bodyInspection: 'unavailable' })
  })

  it('bounds accumulated bytes and ignores oversized and incomplete JSON', () => {
    const recorder = new PlatformHttpErrorRecorder({ 'content-type': 'application/json' })
    recorder.data(Buffer.from('{"error":{"type":"invalid_request_error"},"private":"'))
    recorder.data(Buffer.alloc(17 * 1024, 120))
    recorder.data(Buffer.from('"}'))
    expect(recorder.finish(true)).toEqual({ status: 400, bodyInspection: 'oversized' })
    const incomplete = new PlatformHttpErrorRecorder({ 'content-type': 'application/json' })
    incomplete.data(Buffer.from('{"error":{"type":"invalid_request_error"}}'))
    expect(incomplete.finish(false)).toEqual({ status: 400, bodyInspection: 'incomplete' })
  })
})
