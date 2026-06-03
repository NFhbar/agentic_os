// Wire-shape types for the mcps route. Per standard-shared-types — the
// server (`mcps.ts`) and the client (`apps/mcps/View.tsx`) consume the same
// shapes; this is the canonical definition.
//
// Convention: this file holds ONLY type defs. No node:* imports, no runtime
// values. Anything stateful belongs in the sibling `mcps.ts`.

// Classification of one MCP entry. 'custom' = OS-built (has both .mcp.json
// row + mcps/<id>/ folder). 'hosted' = vendor-hosted (type http/sse + url).
// 'stale' = command-shaped row with no matching folder, or unknown shape.
export type McpKind = 'custom' | 'hosted' | 'stale';

// One tool advertised by a custom MCP's manifest.json.
export interface ManifestTool {
  name: string;
  summary?: string;
}

// Server-internal: the manifest.json shape we read off disk. Not directly
// returned to the client (its fields are projected into McpRow), but kept
// here because client and server should agree on the shape if anything
// reads manifest.json client-side later.
export interface ManifestFile {
  id: string;
  domain: string;
  description: string;
  transport: string;
  command: string;
  args: string[];
  env?: string[];
  tools?: ManifestTool[];
}

// Server-internal: one entry in .mcp.json's `mcpServers` map.
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
}

// Server-internal: shape of the parsed .mcp.json.
export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
}

// One row in GET /api/mcps. Fields are sparse depending on kind — `hosted`
// rows populate `url`, `custom` rows populate command/args/manifest fields,
// `stale` rows populate whatever it can scrape from the entry.
export interface McpRow {
  id: string;
  kind: McpKind;
  transport: string;
  // hosted-only
  url?: string;
  // custom-only
  command?: string;
  args?: string[];
  domain?: string;
  description?: string;
  tools?: ManifestTool[];
  envVarsRequired?: string[];
  // local file probes (custom only)
  hasManifest?: boolean;
  hasEnvExample?: boolean;
  hasEnv?: boolean;
  hasNodeModules?: boolean;
  // human-readable status hint shown next to the row
  statusHint: string;
}

// Full GET /api/mcps response.
export interface McpsListResponse {
  mcps: McpRow[];
  configExists: boolean;
  configPath: string;
  syncScript: string;
}
