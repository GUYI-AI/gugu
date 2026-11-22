import { humanizeRpcError } from '@renderer/features/session-import/humanize-error'
import { tryLocalizeImportError } from '@renderer/features/session-import/import-error-copy'
import { translateSessionMessage } from '@renderer/localization/locale-store'

/** Only known codes become UI copy. Unknown diagnostics may contain local paths. */
export function importFailureDescription(error: unknown): string | undefined {
  return tryLocalizeImportError(humanizeRpcError(error, ''), translateSessionMessage) ?? undefined
}
