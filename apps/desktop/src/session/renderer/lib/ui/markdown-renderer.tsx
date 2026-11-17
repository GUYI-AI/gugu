import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import React, { useCallback, useEffect } from 'react';
import { refreshFailure, useReplica } from '@/lib/replica';
import { Unknown } from '@/components/ui/Unknown';
import { workspaceImage } from '@renderer/features/sessions/workspace-backend/workspace-image';
import { Markdown, type MarkdownDensity } from '@/components/markdown/Markdown';
import { confirmOpenExternalLink } from '@renderer/lib/open-external-link';
import { ExpandableImage } from './expandable-image';

/**
 * The session page's markdown: the shared `<Markdown>` renderer bound to the session page's policies —
 * workspace links open in a tab, web links go through the confirm dialog, workspace images are
 * resolved through the host. Grammar, sanitizing and typography are the shared dialect's; nothing
 * here styles markdown.
 */
interface MarkdownRendererProps {
  content: string;
  density?: MarkdownDensity;
  className?: string;
  onOpenLink?: (href: string) => boolean | void;
  /** Files only: a leading `---` block is frontmatter. Free text (PR comments) must keep reading it as a rule. */
  frontmatter?: boolean;
  /** Where a non-web image source (e.g. workspace-relative) lives in a workspace; the path null = outside it ("not found"). */
  workspaceImages?: WorkspaceImages;
}

export type WorkspaceImages = { projectId: string; workspaceId: string; pathOf: (src: string) => string | null };

const ResolvedImage: React.FC<{
  src: string;
  alt: string;
  images: WorkspaceImages;
}> = ({ src, alt, images }) => {
  const path = images.pathOf(src);
  const reading = useReplica(workspaceImage, path ? [images.projectId, images.workspaceId, path] : null);
  const failed = refreshFailure(reading);
  useEffect(() => {
    if (failed) rendererLogger('markdown/image').error({ error: failed }, 'image resolution failed');
  }, [failed]);

  if (reading.state === 'error') {
    return <span className="text-foreground-muted inline-block text-xs">[{messageForUser(reading.error)}]</span>;
  }
  if (path && reading.state === 'unknown') return <Unknown className="h-24 w-40" />;
  const dataUrl = reading.state === 'value' ? reading.value : null;
  if (!dataUrl) return <span className="text-foreground-muted inline-block text-xs">[Image not found: {src}]</span>;
  return (
    <>
      <ExpandableImage src={dataUrl} alt={alt} className="max-w-full rounded-sm" />
      {/* Read before, its re-read failed: the image read before stays, the failure beside it (❌ shown as current). */}
      {failed ? <span role="alert" data-refresh-failed="" className="text-foreground-muted inline-block text-xs">[{messageForUser(failed)}]</span> : null}
    </>
  );
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  density = 'compact',
  className,
  frontmatter = false,
  workspaceImages,
  onOpenLink,
}) => {
  const compact = density === 'compact';
  const openLink = useCallback(
    (href: string) => {
      if (onOpenLink?.(href)) return true;
      if (!/^https?:\/\//i.test(href)) return false;
      confirmOpenExternalLink(href);
      return true;
    },
    [onOpenLink]
  );
  const renderImage = useCallback(
    ({ src, alt }: { src?: string; alt: string }) => {
      if (src && workspaceImages && !/^https?:\/\//i.test(src)) {
        return <ResolvedImage src={src} alt={alt} images={workspaceImages} />;
      }
      // Compact bodies sit in cards (PR comments, extension notes): a tall image must not push the card open.
      return (
        <ExpandableImage
          src={src}
          alt={alt}
          className={compact ? 'h-auto max-h-80 max-w-full rounded-sm' : 'max-w-full rounded-sm'}
        />
      );
    },
    [workspaceImages, compact]
  );

  return (
    <Markdown
      trust="document"
      density={density}
      frontmatter={frontmatter}
      content={content}
      onOpenLink={openLink}
      renderImage={renderImage}
      className={className}
    />
  );
};
