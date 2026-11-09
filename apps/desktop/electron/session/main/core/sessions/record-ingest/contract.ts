import { defineContract, procedure } from '@gugu/session-wire/api';
import { z } from 'zod';
import type { IngestBatch, IngestRequest, IngestSummary } from './plan';

/**
 * The ingest child (resume-mem): `start` reads one session's record and plans what to copy; `next` hands the planned
 * turns out a batch at a time, so the host holds at most one batch. One ingest per process; the host disposes it after.
 */
export const recordIngestContract = defineContract({
  start: procedure({ input: z.custom<IngestRequest>(), output: z.custom<IngestSummary>() }),
  next: procedure({ input: z.object({}), output: z.custom<IngestBatch | null>() }),
});
