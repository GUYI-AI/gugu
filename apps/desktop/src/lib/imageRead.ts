/** Share successful image reads, retry rejected reads, and own each created object URL. */
export function createImageRead(read: () => Promise<Blob>): { load(): Promise<string>; release(): void } {
  let pending: Promise<string> | undefined
  let released = false
  const urls = new Set<string>()

  return {
    load() {
      if (released) return Promise.reject(new Error('Image reader is released'))
      if (pending) return pending
      const attempt = Promise.resolve().then(read).then(blob => {
        const url = URL.createObjectURL(blob)
        if (released) URL.revokeObjectURL(url)
        else urls.add(url)
        return url
      }).catch(error => {
        if (pending === attempt) pending = undefined
        throw error
      })
      pending = attempt
      return attempt
    },
    release() {
      if (released) return
      released = true
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }
}
