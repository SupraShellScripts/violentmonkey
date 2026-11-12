# Official Violentmonkey MCP vs Workbench Developer Mode — public-source bake-off

## Question and reuse-first hypothesis

Can official Violentmonkey MCP replace part or all of the customized Workbench Developer Mode adapter, instead of adding more bespoke implementation? **Do not infer a replacement or introduce an MCP bridge from this test alone.**

## Immutable public candidates

- Downstream public fork: `SupraShellScripts/violentmonkey@master` source checked out at the exact CI PR head; declares Violentmonkey 2.48.0 and includes opt-in Developer Mode, native-messaging identity and a read-only status UI.
- Upstream stable: `violentmonkey/violentmonkey@f3f4e7f50e92f84e83076046171e042ecce6c4ff`, release **v2.50.0**, with official MCP support.
- Official standalone MCP monorepo: `violentmonkey/mcp@8e85ac81eefedbdf2ccc916873d428aff0d6e121`, which declares server version **0.2.0** in source. This source version is not an assertion about the version currently published on npm.

## Distinguish supported function from authority

| Dimension | Current Workbench Developer Mode | Official upstream MCP | Decision criterion |
| --- | --- | --- | --- |
| Script list/get/write | Not a general agents' CRUD API; intentionally restricted | Provided by official MCP | Reuse only behind authorization and source-custody policy |
| Browser tab and script diagnostics | Governed extension/host status; broader Workbench evidence outside extension | Explicit tab grants, matching, injection results, GM_log and GM.mcp calls | Reuse diagnostics that are genuinely sufficient |
| Source integrity and ownership | Private Workbench/userscripts authoritative source and revision checks | MCP's script identity and code hashes do not demonstrate those workflow guarantees | Do not weaken exact digest/revision authority |
| Native-host and managed reconciliation | Native Messaging, typed developer transport and managed lifecycle | WebSocket to local MCP server; script CRUD is not equivalent to reconciliation | Preserve only independently proved residual features |
| Security | Existing Workbench authority is explicitly bounded | Readonly server switch, tab consent, localhost/token/origin protections; scripts_get still exposes source, script_call may run arbitrary handlers | Test read-only/negative cases on disposable profile before any managed adoption |
| User/automation/agent interfaces | Human Developer Mode panel + automation/agent contracts | Extension MCP consent UI + stdio/HTTP tools for agents | Prefer official UX/API if equivalent for all three audiences |

## Public free-tier execution

The isolated `upstream-mcp-reuse-bakeoff.yml` workflow executes two independent public jobs:

1. **Capability source census**: inspect the three *public* pinned trees, report MCP tools and explicit authority limits. No execution of site scripts or transfer of private data.
2. **Upstream native tests**: run official MCP monorepo `pnpm build`, `pnpm typecheck`, and `pnpm test` on ephemeral public hosted GitHub Actions, using the pinned upstream source. These are upstream tests, not our Workbench HIL.

The downstream fork's existing native three-OS Chromium smoke remains separate, at public PR #31. Neither lane authenticates a real user profile or exercises source mutation.

## Promotion decision gates

Do not replace the fork adapter or change Workbench topology until **same-fixture** disposable browser A/B demonstrates: explicit connection and tab grant; denial of unauthorized writes, reads and script calls; deterministic source-version binding and postconditions; reconnection and revocation; neutral behavior under missing extension/server; and keyboard/screen-reader controls for humans. In particular, `scripts_get` is **not safe for sensitive source merely because its MCP annotation is read-only**.

If official MCP satisfies all required browser-facing features, retain our distinct Workbench policy, source authority and acceptance evidence outside the extension, and retire redundant custom transport after staged cutover. If not, keep only the smallest validated thin adapter. Escalate to the owner only for a genuine authority-policy difference or an authenticated browser requirement.

**No GitHub publication, packaging, releases, browser credentials, host grant changes or new privileged Workbench capabilities are approved by this experiment.**
