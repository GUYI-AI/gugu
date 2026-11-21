import { useMemo, useState } from 'react';
import { replica, useReplica, type Reading } from '@/lib/replica';
import { rpc } from '@renderer/lib/ipc';
import type { ComboboxSelectOption } from '@renderer/lib/ui/combobox-popover';

/** Where a GitHub account can create repositories (the account itself and its organizations). */
export const githubOwners = replica({
  name: 'githubOwners',
  scope: 'device',
  read: async (_owner, accountId: string): Promise<ComboboxSelectOption[]> => {
    const result = await rpc.github.getOwners(accountId);
    if (!result.success) throw new Error(result.error || 'Failed to load repository owners');
    return result.owners.map((owner) => ({ value: owner.login, label: owner.login }));
  },
  fresh: 5 * 60_000,
});

export type RepositoryOwnerSelect = {
  /** The owners of the selected account; `unknown` also while no account is selected (nothing to choose from yet). */
  owners: Reading<ComboboxSelectOption[]>;
  /** The chosen owner: picked, or the account's first; null = none can be chosen (not read, or none there). */
  owner: ComboboxSelectOption | null;
  retry: () => void;
  handleOwnerChange: (owner: ComboboxSelectOption) => void;
};

export function useGitHubRepositoryOwnerSelect(githubAccountId: string | null): RepositoryOwnerSelect {
  const [ownerOverride, setOwnerOverride] = useState<{
    githubAccountId: string;
    owner: ComboboxSelectOption;
  } | null>(null);
  const owners = useReplica(githubOwners, githubAccountId === null ? null : [githubAccountId]);
  const owner = useMemo(() => {
    if (ownerOverride && ownerOverride.githubAccountId === githubAccountId) return ownerOverride.owner;
    return owners.state === 'value' ? (owners.value[0] ?? null) : null;
  }, [ownerOverride, githubAccountId, owners]);

  return {
    owners,
    owner,
    retry: () => { if (githubAccountId !== null) void githubOwners.refresh(githubAccountId); },
    handleOwnerChange: (nextOwner) => {
      if (githubAccountId === null) return;
      setOwnerOverride({ githubAccountId, owner: nextOwner });
    },
  };
}
