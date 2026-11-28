/**
 * Reads Claude Code's managed policy tier with the Agent SDK's `resolveSettings` and replies with the three keys the
 * review rule needs. A process of its own: loading the SDK costs about 83 MB, which the app process must not keep.
 * The SDK is the one the app ships (the root dependency), handed over by path; `settingSources: []` skips the user,
 * project and local files but still reads the policy tier (managed files, the remote-settings cache, MDM).
 */
import { pathToFileURL } from 'node:url';

type ResolveSettings = (options: { settingSources: [] }) => Promise<{ effective: Record<string, unknown> }>;

process.once('disconnect', () => process.exit(0));
process.once('message', (request: { sdkEntry: string }) => {
  void import(/* @vite-ignore */ pathToFileURL(request.sdkEntry).href)
    .then((sdk: { resolveSettings: ResolveSettings }) => sdk.resolveSettings({ settingSources: [] }))
    .then(({ effective }) => process.send?.({
      availableModels: effective.availableModels,
      deniedModels: effective.deniedModels,
      availableModelsMatch: effective.availableModelsMatch,
    }, () => process.disconnect()), (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
});
