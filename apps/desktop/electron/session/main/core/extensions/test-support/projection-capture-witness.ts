type Rgb = readonly [number, number, number];
export interface CaptureWitness { data: string; attempts: number; firstRgb: Rgb; rgb: Rgb }

/** Observe the source PNG independently before the media decoder sees it. The
 * caller supplies its existing observation wait and publishes exactly result.data. */
export async function captureColorWitness(ports: {
  capture(): Promise<string>;
  rgb(data: string): Promise<Rgb>;
  until(condition: () => Promise<boolean>): Promise<void>;
  expected: Rgb;
}): Promise<CaptureWitness> {
  let attempts = 0, firstRgb: Rgb | undefined, rgb: Rgb | undefined, accepted: string | undefined;
  try {
    await ports.until(async () => {
      const data = await ports.capture();
      rgb = await ports.rgb(data); attempts++; firstRgb ??= rgb;
      if (!ports.expected.every((wanted, channel) => Math.abs(rgb![channel]! - wanted) <= 1)) return false;
      accepted = data; return true;
    });
  } catch (cause) {
    throw new Error('Source capture color witness failed: ' + JSON.stringify({ expected: ports.expected, attempts, firstRgb, rgb }), { cause });
  }
  if (accepted === undefined || !firstRgb || !rgb) throw new Error('Source capture wait ended without a witnessed PNG');
  return { data: accepted, attempts, firstRgb, rgb };
}
