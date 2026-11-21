/** An image's preview, drawn where the sender has a canvas (the phone, the web): 560 px wide at most. */
export async function imagePreview(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, 560 / bitmap.width)
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image preview is unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image preview is unavailable')), 'image/webp'))
  } finally { bitmap.close() }
}
