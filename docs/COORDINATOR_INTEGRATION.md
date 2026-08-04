# Coordinator integration

This repository is a child of the multi-repository program coordinated from `SupraShellScripts/violentmonkey-workbench-private`, but it remains authoritative for the modified Violentmonkey extension.

## Local path

```text
~/Projects/SupraShellScripts/violentmonkey
C:\Users\Mark\Projects\SupraShellScripts\violentmonkey
```

The coordinator is normally checked out at the sibling path:

```text
../violentmonkey-workbench-private
```

## Ownership boundary

This repository owns the MIT downstream extension, Developer Mode, native-messaging adapter, extension identities, browser packages, tests, and upstream synchronization.

The coordinator owns the private Workbench daemon, native host, CLI/API/MCP, browser/profile orchestration, integration acceptance, and cross-repository roadmap.

Neither repository imports the other's implementation as a build dependency. They integrate through versioned protocol contracts and exact artifacts.

## Work coordination

Because GitHub Issues are disabled here, extension child work uses:

1. a parent issue in `violentmonkey-workbench-private`;
2. an issue-named branch in this repository;
3. an early draft pull request that links the parent issue;
4. local stateless validation evidence;
5. immutable commit, artifact, protocol, and browser references in the parent issue.

## Validation

The authoritative heavy command remains:

```powershell
.\tools\ci.ps1
```

or:

```sh
sh ./tools/ci.sh
```

The coordinator may invoke this command, but it must not duplicate or bypass it. Successful evidence includes both extension variants, checksums, build metadata, and the structured run result.

## Dependency semantics

- Upstream Violentmonkey is a hard source dependency.
- Promoted stateless tooling images are hard operational dependencies once adopted and are pinned by digest.
- Workbench is a validation and feedback relationship, not a build dependency.
- Unchanged userscripts are acceptance fixtures, not extension dependencies.

The hard dependency graph remains acyclic even though integration defects flow back from Workbench to Developer Mode.
