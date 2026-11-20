import { Github } from '@/lib/icons'
import { Badge } from '@renderer/lib/ui/badge';
import { SelectItem } from '@renderer/lib/ui/select';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { GitHubAccountSummary, GitHubCredentialSource } from '@shared/github';

// Every source has a label (a total record, so a new source cannot show an empty badge): "GitHub CLI" and "OAuth" are
// proper nouns shown verbatim in both locales; the descriptive ones are translated.
const GITHUB_SOURCE_LABELS: Record<GitHubCredentialSource, { verbatim: string } | { key: SessionMessageKey }> = {
  cli: { verbatim: 'GitHub CLI' },
  emdash_oauth: { verbatim: 'OAuth' },
  device_flow: { key: 'projects.github.sourceDeviceFlow' },
  secure_storage: { key: 'projects.github.sourceSavedToken' },
  pat: { key: 'projects.github.sourceSavedToken' },
  vault: { key: 'projects.github.sourceSavedToken' },
};

export function GitHubAccountSelectItem({ account }: { account: GitHubAccountSummary }) {
  return (
    <SelectItem value={account.accountId} className="py-2">
      <GitHubAccountSelectLabel account={account} />
    </SelectItem>
  );
}

export function GitHubAccountSelectLabel({ account }: { account: GitHubAccountSummary }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt={account.login}
          className="h-4 w-4 shrink-0 rounded-full"
        />
      ) : (
        <Github className="text-foreground-muted h-4 w-4 shrink-0" />
      )}
      <span className="min-w-0 truncate">@{account.login}</span>
      <span className="text-foreground-muted shrink-0 text-xs">{account.host}</span>
      {account.isDefault ? <GitHubDefaultAccountBadge /> : null}
    </div>
  );
}

export function GitHubDefaultAccountBadge() {
  const { translate } = useSessionMessages();
  return (
    <Badge
      variant="secondary"
      className="rounded-md border-foreground/10 bg-background-2 text-foreground"
    >
      {translate('projects.github.default')}
    </Badge>
  );
}

export function GitHubCredentialSourceBadge({ source }: { source: GitHubCredentialSource }) {
  const { translate } = useSessionMessages();
  const label = GITHUB_SOURCE_LABELS[source];
  return (
    <Badge
      variant="outline"
      className="rounded-md border-foreground/10 bg-transparent text-foreground-muted"
    >
      {'key' in label ? translate(label.key) : label.verbatim}
    </Badge>
  );
}
