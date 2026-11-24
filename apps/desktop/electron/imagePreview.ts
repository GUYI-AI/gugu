import { invokeRendererImages } from './ipc-bridge'
import { IMAGE_PREVIEW, type ScaleImage } from '../src/lib/imagePreview'

export type MainScaledImage = { bytes: Uint8Array; type: string; width: number; height: number }

/**
 * An image scaled for the desktop's main process by the window's renderer (src/lib/imagePreview.ts scaleImage), where
 * createImageBitmap decodes off every thread anyone waits on. Main never decodes a photo itself: nativeImage decodes on
 * main's own thread, and a 12 MP photo stopped it for 0.2–0.5 s. The window lives as long as the app (closing it hides it
 * to the tray), so main always has a renderer to ask; a renderer that cannot decode the format rejects.
 */
export async function rendererScaleImage(bytes: Uint8Array, contentType: string, options: ScaleImage): Promise<MainScaledImage> {
  return await invokeRendererImages('scale', { bytes, contentType, ...options }) as MainScaledImage
}

/** An image's preview for main's uploads: the same preview the renderer draws for its own. */
export async function rendererImagePreview(original: Blob, contentType: string): Promise<Blob> {
  const preview = await rendererScaleImage(new Uint8Array(await original.arrayBuffer()), contentType, IMAGE_PREVIEW)
  return new Blob([new Uint8Array(preview.bytes)], { type: preview.type })
}
