export interface ClientRpcCall {
  args: string[]
  sites: string[]
  /** Keys omitted by a finite argument branch or spread; the backend must allow their omission. */
  optionalArgs?: string[]
}

export declare function extractClientRpcContract(
  rootDirs: string[],
  repoRoot: string,
  includeSite?: (file: string, offset: number) => boolean,
  hooks?: {
    extraRpc?: (
      repoRoot: string,
      includeSite: (file: string, offset: number) => boolean,
    ) => { name: string; args: string[]; sites: string[] } | null
  },
): Map<string, ClientRpcCall>

export declare function extractClientSchemas(rootDirs: string[]): string[]

export interface ClientDataRelation {
  schema: string | null
  table: string
  columns: string[]
  sites: string[]
}

export declare function clientDataSourceRoots(rootDirs: string[], repoRoot: string): string[]

export declare function extractClientDataContract(
  rootDirs: string[],
  repoRoot: string,
  includeSite?: (file: string, offset: number) => boolean,
  hooks?: {
    schemaProof?: (files: string[]) => (file: string, offset: number) => Array<string | null>
    tolerate?: (error: unknown, site: string) => boolean
  },
): Map<string, ClientDataRelation>

export declare function extractClientEdgeFunctions(
  rootDirs: string[],
  hooks?: { reviewedNames?: (file: string, offset: number) => string[] | null },
): Set<string>
