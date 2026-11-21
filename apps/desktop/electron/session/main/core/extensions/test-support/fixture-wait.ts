const tick = () => new Promise<void>(resolve => setTimeout(resolve, 20));

/**
 * Waits for a real-process fixture's condition with no wall-clock budget, like the suites that run these fixtures
 * (no case or hook limit; a hang is bounded by the CI job). A loaded runner is slow, not wrong, so only what the
 * fixture can observe going wrong ends the wait: a recorded fault, or a peer process (the headless viewer) that
 * exited. The error names the phase and what had arrived by then, so a failure says which half was missing.
 */
export async function untilObserved(condition: () => boolean | Promise<boolean>, watch: {
  phase: string;
  /** What has arrived so far, reported with any failure. */
  arrived: () => Record<string, unknown>;
  /** A fault the fixture recorded (e.g. from its HTTP handlers or the peer's spawn error). */
  fault?: () => unknown;
  /** Set once the peer process has exited, with what it said. */
  exited?: () => string | undefined;
}): Promise<void> {
  while (!(await condition())) {
    const fault = watch.fault?.();
    if (fault) throw new Error(`${watch.phase}: ${String(fault)}; arrived ${JSON.stringify(watch.arrived())}`, { cause: fault });
    const exit = watch.exited?.();
    if (exit !== undefined) throw new Error(`${watch.phase}: viewer exited before it was reached; arrived ${JSON.stringify(watch.arrived())}\n${exit}`);
    await tick();
  }
}
