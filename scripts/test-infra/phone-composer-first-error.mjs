// A test-only wire frame. Ordinary console output must never stop a shard.
export const H_FIRST_ERROR_PREFIX = '__GUGU_H_FIRST_ERROR_V1__'
export const H_FIRST_ERROR_SOURCE = 'apps/desktop/src/session/renderer/tests/browser/phone-composer-height-real-entries.test.tsx'
const fields = ['version', 'kind', 'source', 'testName', 'phase', 'lineCount', 'editorText', 'errorMessage', 'hasOriginalStack', 'originalStack'].sort()
const phases = new Set(['before-test', 'before-real-page-render', 'before-setContent', 'after-setContent',
  'before-root-unmount', 'after-root-unmount-before-harness-cleanup', 'after-harness-cleanup-before-draft-discard', 'after-draft-discard'])
const testName = /^(new-page|existing-thread)\/(320|390)\/(light|dark): two lines retain natural height and separate touch targets in the actual Thread$/
export function readHFirstErrorFrame(line) {
  // Vitest decorates console lines with ANSI, but the frame itself must be the entire line.
  // eslint-disable-next-line no-control-regex -- strip Vitest's ANSI decoration before validating the entire diagnostic frame.
  const clean = line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').trim()
  if (!clean.startsWith(H_FIRST_ERROR_PREFIX)) return null
  try {
    const frame = JSON.parse(clean.slice(H_FIRST_ERROR_PREFIX.length))
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)
      || JSON.stringify(Object.keys(frame).sort()) !== JSON.stringify(fields)
      || frame.version !== 1 || frame.kind !== 'phone-composer-first-error'
      || frame.source !== H_FIRST_ERROR_SOURCE || typeof frame.testName !== 'string' || !testName.test(frame.testName)
      || typeof frame.phase !== 'string' || !phases.has(frame.phase)
      || !(frame.lineCount === null || Number.isInteger(frame.lineCount) && frame.lineCount >= 1 && frame.lineCount <= 3)
      || !(frame.editorText === null || typeof frame.editorText === 'string')
      || typeof frame.errorMessage !== 'string' || !frame.errorMessage
      || typeof frame.hasOriginalStack !== 'boolean'
      || (frame.hasOriginalStack ? typeof frame.originalStack !== 'string' || !frame.originalStack.trim() : frame.originalStack !== null)) return null
    return frame
  } catch { return null }
}
