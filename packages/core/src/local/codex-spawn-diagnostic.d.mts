export declare function codexVersionFromUserAgent(value: unknown): string | null;
export declare function codexSpawnDiagnostic(input: {
  executable: string;
  nativeVersion?: string | null;
  appVersion?: string | null;
  mode: 'acp-stdio' | 'app-server-ws';
  phase: 'spawn' | 'initialized';
  versionSource?: 'version-probe' | 'initialize';
}): {
  providerId: 'codex';
  mode: 'acp-stdio' | 'app-server-ws';
  phase: 'spawn' | 'initialized';
  executable: string;
  nativeVersion: string | null;
  versionSource: 'version-probe' | 'initialize' | null;
  appVersion: string | null;
};
