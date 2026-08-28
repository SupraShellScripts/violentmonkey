# Workbench development extension identity

This downstream fork keeps the canonical Violentmonkey source/release identity intact and overlays a separate identity only for explicit Workbench development builds.

## Fixed development identities

| Browser family | Development identity | Source |
| --- | --- | --- |
| Firefox | `violentmonkey-workbench-dev@suprashellscripts.github` | explicit `browser_specific_settings.gecko.id` overlay |
| Chromium (Chrome/Edge development) | `mlooodbpjdohbedafmodnmelbmdgmngk` | SHA-256-derived from the pinned public SPKI in `scripts/workbench-dev-identity.js` |

The Chromium manifest `key` is **public key material only**. No private key is committed or required to load the extension unpacked with the same deterministic ID.

## Build commands

```text
pnpm dev:workbench:firefox
pnpm dev:workbench:chromium
pnpm build:workbench:firefox
pnpm build:workbench:chromium
```

The equivalent environment contract is fail-closed:

```text
VMWB_DEV_IDENTITY=1
VMWB_DEV_BROWSER=firefox|chromium
```

Setting `VMWB_DEV_IDENTITY=1` without an accepted browser value fails instead of falling back to an upstream or browser-assigned identity.

Ordinary `pnpm dev`, `pnpm build`, and `pnpm build:mv3` do not enable this overlay. `src/manifest.yml` retains Violentmonkey's upstream Firefox ID.

## Native messaging authority

Workbench native-host registration must authorize the exact identity reported by the qualified development artifact. It must not authorize the inherited upstream Firefox ID, a wildcard, or an assumed browser-generated Chromium ID.

Identity alone grants no Workbench mutation capability. Native transport remains handshake-only until the controlled-runtime operation is separately implemented and qualified.

## Vendor relationship

A vendor-issued store ID is not required for this unpacked development identity:

- Firefox permits an extension to specify its own `browser_specific_settings.gecko.id`; signing/store distribution is a separate step.
- Chromium's manifest `key` can hold a fixed public key to preserve the extension ID during development.
- Microsoft Edge accepts Chrome-compatible extension manifests; native messaging authorization still uses the exact `chrome-extension://<id>/` origin. A future Edge Add-ons publication may have a different store ID and must be qualified separately.

Current platform references:

- Chrome manifest `key`: https://developer.chrome.com/docs/apps/manifest/key/
- Firefox `browser_specific_settings`: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
- Microsoft Edge native messaging: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging

## Upstreaming strategy

Keep the downstream identity overlay isolated from generally useful Developer Mode/native-messaging changes. Candidate upstream contributions should not require Violentmonkey upstream to adopt the SupraShellScripts development identity or Workbench-specific authority model.
