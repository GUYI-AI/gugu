import { LoadingIndicator } from './LoadingIndicator'
import { translateSessionMessage } from '../../session/renderer/localization/locale-store'

/**
 * A page beside a chat or in a task that is not drawn yet — its file still being found (the waiting tab), or its App's
 * document not painted yet: the product's loading mark, centred where the page will be. One look for every such wait.
 * `overlay`: over a frame that is there but blank (the phone's App frame), rather than in its place.
 */
export function PageLoading({ overlay = false }: { overlay?: boolean }) {
  return (
    <div className={overlay ? 'absolute inset-0 flex items-center justify-center bg-background' : 'flex h-full items-center justify-center'} data-testid="page-loading">
      <LoadingIndicator ariaLabel={translateSessionMessage('task.loading')} />
    </div>
  )
}
