export const H_FIRST_ERROR_PREFIX: string
export const H_FIRST_ERROR_SOURCE: string
export interface HFirstErrorFrame {
  version: 1
  kind: 'phone-composer-first-error'
  source: string
  testName: string
  phase: string
  lineCount: number | null
  editorText: string | null
  errorMessage: string
  hasOriginalStack: boolean
  originalStack: string | null
}
export function readHFirstErrorFrame(line: string): HFirstErrorFrame | null
