import { DataImportSection } from './DataImportSection'
import { useExternalImportProviders } from './use-external-import-providers'

export function DesktopDataImportSection({ onClose }: { onClose: () => void }) {
  const { providers, historyDialog } = useExternalImportProviders()
  return (
    <>
      <DataImportSection onClose={onClose} extraProviders={providers} />
      {historyDialog}
    </>
  )
}
