import { initProcessLogging } from '@gugu/session-shared/logger/node';
import { createController, withValidation } from '@gugu/session-wire/api';
import { serveWorkerProcess, workerValidatePolicy } from '@gugu/session-wire/util/process-runtime';
import { recordIngestContract } from './contract';
import { runIngest, type IngestRun } from './plan';

const logger = initProcessLogging({ name: 'record-ingest-runtime', env: process.env });
let run: IngestRun | null = null;

void serveWorkerProcess(
  () => withValidation(recordIngestContract, createController(recordIngestContract, {
    async start(request) {
      if (run) throw new Error('record-ingest: one ingest per process');
      run = await runIngest(request);
      return run.summary;
    },
    async next() {
      if (!run) throw new Error('record-ingest: next before start');
      return run.next();
    },
  }), workerValidatePolicy(process.env)),
  { logger, failOnCleanupError: true },
);
