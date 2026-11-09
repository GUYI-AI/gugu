import type { IoKind, WindowBudget, WindowIoCounters, WindowLimits } from './types';

export const WINDOW_LIMITS: Readonly<WindowLimits> = Object.freeze({
  sourceBytes: 512 * 1024, indexBytes: 64 * 1024, decodedBytes: 512 * 1024,
  outputBytes: 128 * 1024, examinedRecords: 128,
});

export class WindowBudgetExceeded extends Error {
  readonly counter: keyof WindowLimits;
  constructor(counter: keyof WindowLimits) {
    super(`Window budget exhausted: ${counter}`);
    this.name = 'WindowBudgetExceeded';
    this.counter = counter;
  }
}

function validAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid window accounting amount');
}

/** One instance belongs to the entire request, including repair and identity I/O. */
export function createWindowBudget(limits: Readonly<WindowLimits> = WINDOW_LIMITS): WindowBudget {
  const ceiling = { ...limits };
  Object.values(ceiling).forEach(validAmount);
  const used: WindowIoCounters = { sourceBytes: 0, indexBytes: 0, decodedBytes: 0, outputBytes: 0, examinedRecords: 0 };
  const reserved = { sourceBytes: 0, indexBytes: 0 };
  function admit(kind: keyof WindowLimits, amount: number, pending = 0): void {
    validAmount(amount);
    if (amount > ceiling[kind] - used[kind] - pending) throw new WindowBudgetExceeded(kind);
  }
  return {
    get counters() { return { ...used }; },
    async read(kind: IoKind, requested: number, operation: () => Promise<number>) {
      admit(kind, requested, reserved[kind]);
      reserved[kind] += requested;
      try {
        const actual = await operation();
        validAmount(actual);
        if (actual > requested) throw new RangeError('Read exceeded its admitted allocation');
        used[kind] += actual;
        return actual;
      } finally { reserved[kind] -= requested; }
    },
    charge(kind, amount) { admit(kind, amount); used[kind] += amount; },
  };
}
