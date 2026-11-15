import { translateSessionMessage } from '@renderer/localization/locale-store';
import { messageForUser } from '@/lib/userFacingError';
import React, { createContext, useCallback, useContext, useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import {
  githubAccountsChangedChannel,
  githubAuthErrorChannel,
  githubAuthSuccessChannel,
} from '@shared/events/githubEvents';
import type { GitHubUser } from '@shared/github';
import { useToast } from '../hooks/use-toast';
import { refreshGitHubAccountState } from '../hooks/useGithubAccounts';

type GithubContextValue = {
  cancelGithubConnect: () => void;
};

const GithubContext = createContext<GithubContextValue | null>(null);

/** This machine's GitHub sign-in events: a device-flow outcome is said, and an accounts change refreshes the lists. */
export function GithubContextProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();

  const handleDeviceFlowSuccess = useCallback(
    (flowUser: GitHubUser) => {
      log.info('[GithubContext] auth success via device flow', { user: flowUser?.login });
      refreshGitHubAccountState();
      toast({
        title: 'Connected to GitHub',
        description: `Signed in as ${flowUser?.login || flowUser?.name || 'user'}`,
      });
    },
    [toast]
  );

  const handleDeviceFlowError = useCallback(
    (error: string) => {
      toast({
        title: translateSessionMessage('github.authFailed'),
        description: messageForUser(error),
        variant: 'destructive',
      });
    },
    [toast]
  );

  useEffect(() => {
    const cleanupSuccess = events.on(githubAuthSuccessChannel, (data) => {
      log.info('[GithubContext] received githubAuthSuccessChannel event', {
        user: data.user?.login,
      });
      handleDeviceFlowSuccess(data.user);
    });
    const cleanupError = events.on(githubAuthErrorChannel, (data) => {
      log.info('[GithubContext] received githubAuthErrorChannel event', {
        message: data.message || data.error,
      });
      handleDeviceFlowError(data.message || data.error);
    });
    const cleanupAccountsChanged = events.on(githubAccountsChangedChannel, () => {
      log.info('[GithubContext] received githubAccountsChangedChannel event');
      refreshGitHubAccountState();
    });

    return () => {
      cleanupSuccess();
      cleanupError();
      cleanupAccountsChanged();
    };
  }, [handleDeviceFlowSuccess, handleDeviceFlowError]);

  const cancelGithubConnect = useCallback(() => {
    void rpc.github.authCancel();
    toast({
      title: 'GitHub connection unsuccessful',
      description: 'Device flow was canceled',
    });
  }, [toast]);

  const value: GithubContextValue = { cancelGithubConnect };

  return <GithubContext.Provider value={value}>{children}</GithubContext.Provider>;
}

export function useOptionalGithubContext() { return useContext(GithubContext); }
export function useGithubContext() {
  const ctx = useContext(GithubContext);
  if (!ctx) {
    throw new Error('useGithubContext must be used inside GithubContextProvider');
  }
  return ctx;
}
