import type { FileProgress } from '@gugu/core/shared/fileResolver'

/** Share successful image reads, retry rejected reads, and own each created object URL. */
export function createImageRead(read: (progress: FileProgress) => Promise<Blob>): { load(progress?: FileProgress): Promise<string>; release(): void } {
  let pending: Promise<string> | undefined
  let report: FileProgress | undefined
  let released = false
  const urls = new Set<string>()

  return {
    load(progress) {
      if (progress) report = progress
      if (released) return Promise.reject(new Error('Image reader is released'))
      if (pending) return pending
      const attempt = Promise.resolve().then(() => read((...args) => report?.(...args))).then(blob => {
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
      report = undefined
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }
}
