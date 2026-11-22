import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AgentLookup } from '@shared/core/agents/agent-payload';

/**
 * Why the last lookup found nothing usable, and where its PATH came from — built only from what the lookup saw.
 * "Check again" runs a detection, which re-reads the current PATH first: a CLI installed in another terminal shows up.
 */
export function AgentLookupLine({ lookup, onCheck }: { lookup: AgentLookup; onCheck: () => Promise<void> }) {
  const { translate, locale } = useSessionMessages();
  const [checking, setChecking] = useState(false);
  const { failure, pathSource } = lookup;
  const command = [lookup.path?.split(/[\\/]/).pop() ?? lookup.commands[0], ...lookup.versionArgs].join(' ');
  const outcome = !failure ? null
    : failure.timedOut ? translate('agentsPage.lookupTimedOut')
    : failure.signal ? translate('agentsPage.lookupSignal', { signal: failure.signal })
    : translate('agentsPage.lookupExitCode', { code: String(failure.exitCode) });
  const reason = lookup.path && outcome
    ? translate('agentsPage.lookupBroken', { path: lookup.path, command, outcome })
    : translate('agentsPage.lookupNotFound', { commands: lookup.commands.join(' / ') });
  const time = pathSource ? new Date(pathSource.at).toLocaleTimeString(locale) : '';
  const source = !pathSource ? translate('agentsPage.lookupFromLaunch')
    : pathSource.failed ? translate('agentsPage.lookupReadFailed', { time, detail: pathSource.failedDetail ?? pathSource.failed })
    : pathSource.from === 'windows-registry' ? translate('agentsPage.lookupFromRegistry', { time })
    : translate('agentsPage.lookupFromLoginShell', { shell: pathSource.shell ?? '', time });
  return (
    <div className="mt-1 flex items-start gap-2 text-xs text-foreground-muted" data-testid="agent-lookup-reason">
      <p className="m-0 min-w-0 flex-1 break-all">{reason}<br />{source}</p>
      <Button size="sm" variant="ghost" disabled={checking}
        onClick={() => { setChecking(true); void onCheck().finally(() => setChecking(false)); }}>
        {translate(checking ? 'agentsPage.checking' : 'agentsPage.checkAgain')}
      </Button>
    </div>
  );
}
