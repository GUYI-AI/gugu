/**
 * Settles when the image has loaded (fulfils) or failed (rejects). Not `image.decode()`: a hidden document (the phone's
 * WebView with the app in the background) renders no frame, decode waits for one, and its promise then never settles —
 * while `load` and `error` fire regardless, and `drawImage` / `createImageBitmap` decode by themselves. Anything that
 * draws a picture for a notification runs exactly then (#3432).
 */
export function imageLoaded(image: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('image failed to load'))
    image.src = src
  })
}
