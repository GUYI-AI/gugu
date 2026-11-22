type ResponseMetadata = Pick<Response, 'url' | 'type' | 'redirected'>

/** Stream errors cross the same boundary as header errors, without pre-reading or buffering the response. */
export function networkResponse(response: Response, failure: (error: unknown) => unknown): Response {
  const metadata: ResponseMetadata = { url: response.url, type: response.type, redirected: response.redirected }
  if ([204, 205, 304].includes(response.status)) {
    void response.body?.cancel().catch(() => {})
    return new NetworkResponse(null, response, metadata)
  }
  if (!response.body) return new NetworkResponse(null, response, metadata)
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) { controller.error(failure(error)) }
    },
    cancel: reason => reader.cancel(reason),
  }, { highWaterMark: 0 })
  return new NetworkResponse(body, response, metadata)
}

/** A clone keeps the original response metadata as well as its normalized stream failures. */
class NetworkResponse extends Response {
  constructor(body: ReadableStream<Uint8Array> | null, init: ResponseInit, private readonly source: ResponseMetadata) {
    super(body, init)
  }
  override get url() { return this.source?.url ?? super.url }
  override get type() { return this.source?.type ?? super.type }
  override get redirected() { return this.source?.redirected ?? super.redirected }
  override clone(): Response {
    const copy = super.clone()
    return new NetworkResponse(copy.body, copy, this.source)
  }
}
