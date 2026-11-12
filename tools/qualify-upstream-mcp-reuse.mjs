#!/usr/bin/env node
// Public source-only capability census, not a live agent or browser credential test.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';


const [forkArg, upstreamArg, mcpArg] = process.argv.slice(2);
if (!forkArg || !upstreamArg || !mcpArg) throw new Error('Expected fork, upstream extension and MCP checkout directories.');
const fork = resolve(forkArg);
const upstream = resolve(upstreamArg);
const mcp = resolve(mcpArg);
const read = (root, file) => readFileSync(join(root, file), 'utf8');
const json = (root, file) => JSON.parse(read(root, file));
const head = (root) => {
  const source = root === fork ? process.env.FORK_SOURCE_SHA
    : root === upstream ? process.env.UPSTREAM_EXTENSION_SHA : process.env.MCP_SOURCE_SHA;
  check(/^[0-9a-f]{40}$/.test(source || ''), 'exact public checkout identity missing');
  return source;
};

const forkVersion = json(fork, 'package.json').version;
const upstreamVersion = json(upstream, 'package.json').version;
const mcpVersion = json(mcp, 'packages/server/package.json').version;
const tools = read(mcp, 'packages/protocol/src/tools.ts');
const cli = read(mcp, 'packages/server/src/cli.ts');
const server = read(mcp, 'packages/server/src/mcp.ts');
const protocol = read(mcp, 'README.md');
const officialTools = [...tools.matchAll(/^  ([a-z_]+): defineTool\(\{/gm)].map(m => m[1]);
const uniqueTools = [...new Set(officialTools)];
const check = (value, label) => { if (!value) throw new Error('MCP public source contract drift: ' + label); };
const toolSpec = (name) => {
  const begin = tools.indexOf('  ' + name + ': defineTool({');
  check(begin >= 0, 'missing ' + name);
  const end = tools.indexOf('\n  }),', begin);
  check(end > begin, 'tool boundary for ' + name);
  return tools.slice(begin, end);
};

check(forkVersion === '2.48.0', 'qualified fork version changed; redo baseline');
check(upstreamVersion === '2.50.0', 'official release version not 2.50.0');
check(existsSync(join(fork, 'src/common/developer-mode.js')), 'fork Developer Mode entrypoint');
check(existsSync(join(fork, 'tools/smoke-workbench-chromium.js')), 'fork public browser qualification');
check(!existsSync(join(fork, 'src/background/utils/mcp.js')), 'fork has unexpected MCP integration');
check(existsSync(join(upstream, 'src/background/utils/mcp.js')), 'official MCP extension not present');
check(existsSync(join(upstream, 'src/options/views/tab-settings/vm-mcp.vue')), 'official MCP consent UI not present');
check(mcpVersion === '0.2.0', 'official MCP server source version changed');
check(uniqueTools.length === officialTools.length && uniqueTools.length >= 12, 'tool list changed');
check(toolSpec('scripts_get').includes('readOnlyHint: true'), 'scripts_get read-only annotation');
check(toolSpec('scripts_get').includes('scriptDetail'), 'scripts_get returns source-bearing detail');
check(tools.includes('code: z.string()'), 'scriptDetail exposes complete source');
check(toolSpec('scripts_write').includes('idempotentHint: true'), 'scripts_write exists');
check(toolSpec('script_call').includes('destructiveHint: true'), 'script_call destructive');
check(toolSpec('script_call').includes('openWorldHint: true'), 'script_call open-world');
check(toolSpec('script_results').includes('readOnlyHint: true'), 'script_results exists');
check(cli.includes("default: '127.0.0.1'"), 'loopback bind default');
check(cli.includes("default: 'stdio'"), 'stdio transport default');
check(cli.includes("readonly: { type: 'boolean', default: false }"), 'readonly is opt-in');
check(protocol.includes('scripts_test_match'), 'official matching diagnostics');
check(server.includes("session.isAllowed(name)"), 'server-side allowed tool filter');

const result = {
  schemaVersion: 1,
  grade: 'PUBLIC_SOURCE_CAPABILITY_CENSUS_ONLY',
  status: 'PASS',
  inputs: {
    downstreamFork: { sourceCommit: head(fork), version: forkVersion, developerModePresent: true, mcpPresent: false },
    upstreamExtension: { sourceCommit: head(upstream), version: upstreamVersion, mcpPresent: true },
    officialMcp: { sourceCommit: head(mcp), sourceVersion: mcpVersion, toolCount: uniqueTools.length, tools: uniqueTools },
  },
  confirmedBoundaries: {
    scriptsGetClassifiedReadOnlyEvenThoughItReturnsSource: true,
    scriptCallDestructiveAndOpenWorld: true,
    readonlyExplicitOptIn: true,
    loopbackAndStdioDefaults: true,
    upstreamMcpDoesNotProveManagedArtifactOwnership: true,
    newManagedExecutionAuthority: false,
  },
  notProven: ['official MCP live browser handshake', 'tab-grant enforcement in a real extension',
    'upstream vs fork native-host lifecycle parity', 'Workbench exact source custody and approval',
    'authenticated user profile', 'candidate release readiness'],
};
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
