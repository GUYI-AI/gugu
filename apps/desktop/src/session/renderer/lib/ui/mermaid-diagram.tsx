import React, { useEffect, useState } from 'react';
import { cn } from '@renderer/utils/utils';
import { openDiagramViewer } from '@/lib/imageViewer';
import { MermaidDiagramPreview } from './mermaid-diagram-preview';
import { renderMermaidDiagram } from '@gugu/session-chat-ui/mermaid';

interface MermaidDiagramProps {
  chart: string;
  compact?: boolean;
}

type RenderState =
  | { kind: 'rendered'; key: string; svg: string }
  | { kind: 'error'; key: string; message: string | null };

const GENERIC_RENDER_ERROR = 'Unable to render Mermaid diagram.';

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message && error.message !== GENERIC_RENDER_ERROR) {
    return error.message;
  }
  if (typeof error === 'string' && error && error !== GENERIC_RENDER_ERROR) {
    return error;
  }
  return null;
}

export const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart, compact }) => {
  const [state, setState] = useState<RenderState | null>(null);

  useEffect(() => {
    let cancelled = false;

    renderMermaidDiagram(chart)
      .then((svg) => {
        if (!cancelled) setState({ kind: 'rendered', key: chart, svg });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', key: chart, message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [chart]);

  const visibleState = state?.key === chart ? state : null;

  if (visibleState?.kind === 'error') {
    return (
      <div
        className={cn(
          'my-3 rounded-md border border-border-destructive/30 bg-background-destructive p-3 text-xs text-foreground-destructive',
          compact && 'my-2 p-2 text-tiny'
        )}
        role="alert"
      >
        <div className="font-medium">{GENERIC_RENDER_ERROR}</div>
        {visibleState.message && (
          <div className="text-foreground-muted mt-1">{visibleState.message}</div>
        )}
        <pre className="bg-background-2/60 text-foreground-muted mt-2 overflow-x-auto rounded-sm p-2">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!visibleState) {
    return (
      <div
        className={cn(
          'my-3 rounded-md border border-border bg-background-2/20 p-3 text-xs text-foreground-muted',
          compact && 'my-2 p-2 text-tiny'
        )}
      >
        Rendering diagram...
      </div>
    );
  }

  const { svg } = visibleState;
  return <MermaidDiagramPreview svg={svg} compact={compact} onExpand={(drawn) => openDiagramViewer(svg, drawn)} />;
};
