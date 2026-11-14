import type { BrowserAnnotationTarget } from '@shared/browser-annotation';

/** The capture is the real selected page; the host adds only its selection and number. */
export async function markedAnnotationScreenshot(dataUrl: string, target: BrowserAnnotationTarget, number: number): Promise<File> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The annotation screenshot could not be drawn');
  context.drawImage(image, 0, 0);
  context.scale(canvas.width / target.viewport.width, canvas.height / target.viewport.height);
  const { x, y, width, height } = target.rect;
  context.strokeStyle = '#1683ff';
  context.fillStyle = '#1683ff';
  context.lineWidth = 2;
  context.strokeRect(x, y, width, height);
  const markX = Math.max(12, Math.min(target.viewport.width - 12, x));
  const markY = Math.max(12, Math.min(target.viewport.height - 12, y));
  context.beginPath(); context.arc(markX, markY, 12, 0, Math.PI * 2); context.fill();
  context.fillStyle = '#fff'; context.font = '12px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(String(number), markX, markY);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('The annotation screenshot could not be encoded')), 'image/png'));
  return new File([blob], `browser-comment-${number}.png`, { type: 'image/png' });
}
