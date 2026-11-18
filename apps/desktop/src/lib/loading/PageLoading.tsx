import { LoadingIndicator } from './LoadingIndicator'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'

/** An App page or a file not drawn yet: the loading mark, filling the page's box over whatever is there. */
export function PageLoading() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background" data-testid="page-loading">
      <LoadingIndicator ariaLabel={translateSessionMessage('task.loading')} />
    </div>
  )
}
