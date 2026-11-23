import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'

/**
 * The original's pixel size as its message knows it: the file record, else (bytes still on their way) the size its sender
 * declared (owner 11-15). The bubble, an album's tiles and the viewer all lay the image out by this one size; a thumbnail's
 * own pixels are smaller.
 */
export function originalSize(meta: ParsedAttachment): { width: number; height: number } | undefined {
  const file = meta.fileMetadata
  return validSize(file?.status === 'ready' ? file.revision : file?.status === 'pending' ? file : undefined) ?? validSize(meta.imageDimensions)
}

export function validSize(dimensions?: { width?: number | null; height?: number | null }): { width: number; height: number } | undefined {
  const { width, height } = dimensions ?? {}
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { width, height } : undefined
}
