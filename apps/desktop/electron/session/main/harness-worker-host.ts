import { utilityProcessHost, type UtilityForkLike } from '@gugu/session-wire/process';
import { utilityProcess } from 'electron';

/** Workers that run harnesses start through Chromium's launcher, which closes every descriptor of the browser
 * process; a Node fork hands them all (its listeners, the profile's leveldb locks) down to every harness. */
export const harnessWorkerHost = utilityProcessHost({ fork: (...args) => (utilityProcess.fork as UtilityForkLike)(...args) });
