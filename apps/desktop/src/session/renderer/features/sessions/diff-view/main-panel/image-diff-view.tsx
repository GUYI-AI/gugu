import type { Result } from '@gugu/session-shared';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { ReadingSlot } from '@/components/ui/ReadingSlot';
import { replica, useReplica, valueOf, type Reading } from '@/lib/replica';
import { useWorkspace } from '@renderer/features/sessions/session-view-context';
import { MicroLabel } from '@renderer/lib/ui/label';
import { formatBytes } from '@renderer/utils/formatBytes';
import {
  HEAD_REF,
  type ImageReadResult,
  type ImageUnavailableReason,
} from '@shared/core/git/types';
import { gitRefToString } from '@shared/core/git/utils';
import type { ActiveFile } from '@shared/view-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceRpc } from '@renderer/features/sessions/workspace-backend/workspace-backend';

interface ImageDiffViewProps {
  projectId: string;
  workspaceId: string;
  activeFile: ActiveFile;
}

type SideState =
  | { status: 'ready'; dataUrl: string; mimeType: string; size: number }
  | { status: 'missing' }
  | { status: 'unavailable'; reason: ImageUnavailableReason };

type Side = 'original' | 'modified';

function unavailableMessage(reason: ImageUnavailableReason): string {
  switch (reason) {
    case 'ssh':
      return 'Preview unavailable on SSH workspaces';
    case 'unsupported':
      return 'Preview unavailable for this format';
    case 'too-large':
      return 'Preview unavailable — file is too large';
    case 'lfs-pointer':
      return 'Preview unavailable — Git LFS smudge filter not applied';
    case 'git-error':
      return 'Preview unavailable';
  }
}

function fromImageReadResult(result: ImageReadResult): SideState {
  switch (result.kind) {
    case 'image':
      return {
        status: 'ready',
        dataUrl: result.image.dataUrl,
        mimeType: result.image.mimeType,
        size: result.image.size,
      };
    case 'missing':
      return { status: 'missing' };
    case 'unavailable':
      return { status: 'unavailable', reason: result.reason };
  }
}

/** Right after a write a side can briefly fail to read (file mid-write, index mid-update): retried. */
class TransientImageError extends Error {}

type ImageRpcResult = Result<{ result: ImageReadResult }, unknown>;

async function loadGitImage(call: () => Promise<ImageRpcResult>): Promise<SideState> {
  const res = await call();
  if (!res.success) throw new TransientImageError('Failed to load image', { cause: res.error });
  return fromImageReadResult(res.data.result);
}

function loadFromRef(
  projectId: string,
  workspaceId: string,
  filePath: string,
  ref: string
): Promise<SideState> {
  return loadGitImage(() =>
    workspaceRpc(projectId).gitWorktree.getImageAtRef(projectId, workspaceId, filePath, ref)
  );
}

async function loadFromDisk(
  projectId: string,
  workspaceId: string,
  filePath: string
): Promise<SideState> {
  const res = await workspaceRpc(projectId).files.readImage(projectId, workspaceId, filePath);
  if (!res.success) throw new TransientImageError('Failed to read image', { cause: res.error });
  const image = res.data;
  if (!image?.success) {
    const error = image?.error ?? '';
    if (/not found/i.test(error)) return { status: 'missing' };
    throw new TransientImageError(error || 'Failed to read image');
  }
  if (!image.dataUrl) throw new TransientImageError('The image read carried no data');
  return {
    status: 'ready',
    dataUrl: image.dataUrl,
    mimeType: image.mimeType ?? 'application/octet-stream',
    size: image.size ?? 0,
  };
}

type ImageFile = { path: string; group: ActiveFile['group']; originalRef: string; modifiedRef: string | null };

function loadOriginal(
  projectId: string,
  workspaceId: string,
  activeFile: ImageFile
): Promise<SideState> {
  const ref = activeFile.group === 'staged' ? gitRefToString(HEAD_REF) : activeFile.originalRef;
  return loadFromRef(projectId, workspaceId, activeFile.path, ref);
}

async function loadModified(
  projectId: string,
  workspaceId: string,
  activeFile: ImageFile
): Promise<SideState> {
  const state = await (() => {
    switch (activeFile.group) {
      case 'disk':
        return loadFromDisk(projectId, workspaceId, activeFile.path);
      case 'staged':
        return loadGitImage(() =>
          workspaceRpc(projectId).gitWorktree.getImageAtIndex(projectId, workspaceId, activeFile.path)
        );
      case 'git':
      case 'pr':
        return loadFromRef(projectId, workspaceId, activeFile.path, activeFile.modifiedRef ?? gitRefToString(HEAD_REF));
    }
  })();
  if (state.status === 'unavailable' && state.reason === 'git-error') throw new TransientImageError('Preview unavailable');
  return state;
}

export const IMAGE_RETRY_DELAYS_MS = [120, 300, 600];

/** Keyed by what names its bytes; bytes that change in place add the worktree's status revision. */
export const imageDiffSide = replica({
  name: 'imageDiffSide',
  scope: 'device',
  read: (_owner, projectId: string, workspaceId: string, side: Side, activeFile: ImageFile, _revision: number): Promise<SideState> =>
    side === 'original' ? loadOriginal(projectId, workspaceId, activeFile) : loadModified(projectId, workspaceId, activeFile),
  fresh: Infinity,
  keep: 60_000,
  retry: IMAGE_RETRY_DELAYS_MS.length,
  retryDelay: (attempt) => IMAGE_RETRY_DELAYS_MS[Math.min(attempt, IMAGE_RETRY_DELAYS_MS.length - 1)]!,
});

function ImageSidePanel({ label, reading, side }: { label: string; reading: Reading<SideState>; side: Side }) {
  const state = valueOf(reading);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-baseline gap-2 border-b border-border px-3 py-2">
        <span className="font-sans text-xs text-foreground-muted">{label}</span>
        {state?.status === 'ready' && (
          // 一次性 10px caption → MicroLabel(design.md Reject:tiny muted prose);
          // 字节数是「数」,mono 才是它的家(design.md:mono 唯一的活是命令/包名/路径/
          // 标识符/版本号/计数)—— 2026-09-22 两条一起改。
          <MicroLabel className="font-mono">{formatBytes(state.size)}</MicroLabel>
        )}
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        <ReadingSlot reading={reading} placeholder="h-40 w-40"
          failed={(error) => (error instanceof TransientImageError ? unavailableMessage('git-error') : error.message)}>
          {(value) => <ImageSideContent state={value} side={side} />}
        </ReadingSlot>
      </div>
    </div>
  );
}

function ImageSideContent({ state, side }: { state: SideState; side: Side }) {
  switch (state.status) {
    case 'missing':
      return (
        <div className="text-xs text-foreground-passive">
          {side === 'original' ? 'File added' : 'File deleted'}
        </div>
      );
    case 'unavailable':
      return (
        <div className="text-xs text-foreground-passive">{unavailableMessage(state.reason)}</div>
      );
    case 'ready':
      return <PreviewImage state={state} alt={side} />;
  }
}

function PreviewImage({
  state,
  alt,
}: {
  state: Extract<SideState, { status: 'ready' }>;
  alt: string;
}) {
  const { translate } = useSessionMessages();
  const [decodeFailed, setDecodeFailed] = useState(false);

  if (decodeFailed) {
    return <div className="text-xs text-foreground-passive">{translate('diff.imageDecodeFailed')}</div>;
  }

  return (
    <img
      key={state.dataUrl}
      src={state.dataUrl}
      alt={alt}
      className="max-h-full max-w-full object-contain"
      onError={() => setDecodeFailed(true)}
    />
  );
}

export const ImageDiffView = observer(function ImageDiffView({
  projectId,
  workspaceId,
  activeFile,
}: ImageDiffViewProps) {
  const { translate } = useSessionMessages();
  const workspace = useWorkspace();
  const git = workspace.gitWorktree;

  // Plain data: the pane's file may be observable.
  const file: ImageFile = {
    path: activeFile.path,
    group: activeFile.group,
    originalRef: gitRefToString(activeFile.originalRef),
    modifiedRef: activeFile.modifiedRef ? gitRefToString(activeFile.modifiedRef) : null,
  };

  // For disk/staged groups the bytes can change without the file changing
  // (in-place overwrite, re-stage). Pinning to statusRevision reruns the
  // load whenever GitWorktreeStore observes an fs-watch or index event.
  const reactiveRevision =
    activeFile.group === 'disk' || activeFile.group === 'staged' ? git.statusRevision : 0;

  const original = useReplica(imageDiffSide, [projectId, workspaceId, 'original', file, reactiveRevision]);
  const modified = useReplica(imageDiffSide, [projectId, workspaceId, 'modified', file, reactiveRevision]);

  return (
    <div className="flex h-full min-h-0 w-full">
      <ImageSidePanel label={translate('diff.original')} reading={original} side="original" />
      <div className="w-px shrink-0 bg-border" />
      <ImageSidePanel label={translate('diff.modified')} reading={modified} side="modified" />
    </div>
  );
});
