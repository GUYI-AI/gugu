import { useTranslation } from 'react-i18next';
import { readUnfinishedAgentCreates, subscribeUnfinishedAgentCreates } from '@/lib/unfinishedAgentCreateBridge';
import { unfinishedAgentCreateRows } from '@/lib/unfinishedAgentCreateRows';
import { useReplica } from '@/lib/replica';
import { useSelect } from '@/lib/selectStore';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
const controller = { get: readUnfinishedAgentCreates, subscribe: subscribeUnfinishedAgentCreates };

/** Approved row: Continue and Delete, with the existing confirmation dialog. */
export function UnfinishedAgentCreates({ collapsed }: { collapsed: boolean }) {
  const view = useSelect(controller, value => value);
  const reading = useReplica(unfinishedAgentCreateRows, view ? [] : null);
  const { t } = useTranslation('agents');
  const confirm = useShowModal('confirmActionModal');
  if (collapsed || !view || reading.state !== 'value' || !reading.value.length) return null;
  return <section className="shrink-0 px-5 pb-2 text-sm" aria-label={t('create.unfinished.title')} data-testid="unfinished-agent-creates">
    <div className="pb-1 font-medium">{t('create.unfinished.title')}</div>
    {reading.value.map(row => <div key={row.operationId} className="flex min-w-0 items-center gap-3 py-1" aria-busy={view.busy}>
      <span className="min-w-0 flex-1 truncate" title={row.name}>{row.name}</span>
      <Button variant="ghost" className="h-auto border-0 p-0 text-foreground" disabled={view.busy}
        onClick={() => view.run(row.operationId, 'continue')}>{t('create.unfinished.continue')}</Button>
      <Button variant="ghost" className="h-auto border-0 p-0 text-foreground-destructive" disabled={view.busy}
        onClick={() => confirm({ title: t('create.unfinished.deleteTitle'), description: t('create.unfinished.deleteDescription', { name: row.name }), confirmLabel: t('create.unfinished.delete'),
          onSuccess: () => {
            const current = readUnfinishedAgentCreates();
            const rows = unfinishedAgentCreateRows.peek();
            if (current?.ownerUserId === view.ownerUserId && rows.state === 'value' && rows.value.some(item => item.operationId === row.operationId)) current.run(row.operationId, 'delete');
          } })}>{t('create.unfinished.delete')}</Button>
    </div>)}
  </section>;
}
