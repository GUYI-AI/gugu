import { nativeImage } from 'electron';

/**
 * A 128×96 PNG of one colour, the frame a projection fixture publishes: the colour is what the viewer checks. Never a
 * capture of a hidden window, which holds whatever it last composited, under load an empty or earlier frame.
 */
export function solidFrame([red, green, blue]: readonly number[]): string {
  const bgra = [blue!, green!, red!, 255];
  return nativeImage.createFromBitmap(Buffer.from(Array.from({ length: 128 * 96 * 4 }, (_, at) => bgra[at % 4]!)), { width: 128, height: 96 })
    .toPNG().toString('base64');
}
