import { useReplica, type Reading, type Replica } from '@/lib/replica';
import { useLibraryHost } from '@renderer/features/library/library-host';

/**
 * The library host's machine (null = this computer); one not connected is not asked (its last answer stays drawn).
 */
export function useHostMachine(): { machine: string | null; online: boolean } {
  const remote = useLibraryHost().remote;
  return { machine: remote?.deviceId ?? null, online: remote?.online !== false };
}

/** A reading of the library host's machine (@@@agent-readings: the machine is every such model's first argument); null = nothing to read. */
export function useHostReplica<R extends unknown[], V>(model: Replica<[string | null, ...R], V>, rest: R | null): Reading<V> {
  const { machine, online } = useHostMachine();
  return useReplica(model, rest && [machine, ...rest], { read: online });
}
