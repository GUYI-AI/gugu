import { versionTextOf } from './probe';
import type { ProbeResult } from './types';

export interface HarnessRuntimeIdentity {
  providerId: string;
  executable: string;
  version: string | null;
  versionProbeExitCode: number | null;
  versionProbeTimedOut: boolean;
}

export function parseHarnessRuntimeVersion(probe: ProbeResult, versionLine?: RegExp): string | null {
  if (probe.exitCode !== 0 || probe.timedOut) return null;
  const printed = `${probe.stdout}\n${probe.stderr}`;
  // 声明了自己那一行就只认那一行(`versionTextOf`,认不出 = 没读到);没声明取第一行。
  const text = versionTextOf(printed, versionLine);
  const firstLine = versionLine ? text : text?.split('\n').map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  const match = firstLine.match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=$|\s)/);
  // 那一行里没有版本号就是没读到,❌ 拿原文冒充版本。
  return match?.[1] ?? null;
}

export function makeHarnessRuntimeIdentity(input: {
  providerId: string;
  executable: string;
  probe: ProbeResult;
  versionLine?: RegExp;
}): HarnessRuntimeIdentity {
  return {
    providerId: input.providerId,
    executable: input.executable,
    version: parseHarnessRuntimeVersion(input.probe, input.versionLine),
    versionProbeExitCode: input.probe.exitCode,
    versionProbeTimedOut: input.probe.timedOut,
  };
}
