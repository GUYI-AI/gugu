import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import type { MachineReadiness } from './assistant-data';
import { useAssistantReadError, useReadFailure } from './assistant-read-failure';
import { AssistantEmpty, PageHead } from './assistant-ui-parts';
import { useAssistantPanelPage } from '@/lib/assistantPanelPage';
import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';

export * from './assistant-ui-parts';

/** Read state belongs to the cloud copy, independently of the execution host. */
export function MachineGate({ loading, error, onRetry, children, hasData = false, failedTitle }: {
  readiness: MachineReadiness; loading: boolean; error: unknown; onRetry: () => void; children: ReactNode; hasData?: boolean; failedTitle?: string;
}) {
  const { t } = useTranslation('assistant');
  const readError = useAssistantReadError(loading,error);
  const failure = useReadFailure(readError,null,'',onRetry);
  if (hasData) return <>{children}{failure && !isAssistantPanelReadRetryable(readError) ? <p className="ta-page-sub" role="status">{failure.text}</p> : null}</>;
  if (failure) return <AssistantEmpty title={failedTitle} action={failure.retry ? (
    <button type="button" className="ta-pill-btn" onClick={failure.retry}>{t('machine.retry')}</button>
  ) : undefined}><span role={failure.tone === 'danger' ? 'alert' : 'status'}>{failure.text}</span></AssistantEmpty>;
  if (loading) return <AssistantEmpty><LoadingIndicator size="inline" /></AssistantEmpty>;
  return <>{children}</>;
}

/**
 * 面板里一页壳的组件(设置、设备、连接应用):大标题,往下钻进它自己的一层时收起(那一层的返回在面板顶上);
 * 内容是壳画进格子的那个组件。「助理」App 的面板与 App 面板上盖的那一页宿主页(#1925)同用这一框。
 */
export function AssistantShellPageFrame({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  const innerPage = useAssistantPanelPage();
  return (
    <div className="ta-page" data-testid={testId}>
      {/* 页头(大标题);头一句说明由壳那一侧的组件带(让 X 帮你操作以下设备)。 */}
      {!innerPage && <PageHead title={title} />}
      {children}
    </div>
  );
}
