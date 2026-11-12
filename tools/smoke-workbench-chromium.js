#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CHROMIUM_EXTENSION_ID,
  WORKBENCH_DEV_NAME,
} = require('../scripts/workbench-dev-identity');

const playwrightModule = process.env.VMWB_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);
const playwrightVersion = require(path.join(playwrightModule, 'package.json')).version;

const extensionPath = path.resolve(
  process.env.VMWB_EXTENSION_PATH || path.join(process.cwd(), 'dist-mv3'),
);
const evidencePath = path.resolve(
  process.env.VMWB_BROWSER_SMOKE_EVIDENCE ||
    path.join(process.cwd(), 'workbench-chromium-smoke.json'),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    }

    const extensionId = new URL(worker.url()).host;
    assert(
      extensionId === CHROMIUM_EXTENSION_ID,
      `Expected extension ID ${CHROMIUM_EXTENSION_ID}, got ${extensionId}`,
    );

    const observed = await worker.evaluate(() => ({
      runtimeId: chrome.runtime.id,
      manifest: chrome.runtime.getManifest(),
    }));

    assert(
      observed.runtimeId === CHROMIUM_EXTENSION_ID,
      `chrome.runtime.id mismatch: ${observed.runtimeId}`,
    );
    assert(
      observed.manifest.manifest_version === 3,
      `Expected MV3, got ${observed.manifest.manifest_version}`,
    );
    assert(
      observed.manifest.name === WORKBENCH_DEV_NAME,
      `Expected Workbench development name, got ${observed.manifest.name}`,
    );
    assert(
      observed.manifest.permissions?.includes('nativeMessaging'),
      'Browser-visible manifest lost nativeMessaging permission.',
    );


    // Exercise the built extension's human-facing settings surface in the
    // disposable browser profile. Never click Connect or invoke a native host.
    const optionsEntry = observed.manifest.options_ui?.page;
    assert(
      /^options\/index\.html(?:#settings)?$/.test(optionsEntry || ''),
      'Expected the declared built extension settings page.',
    );
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/${optionsEntry}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    const developerSection = optionsPage.locator('section.developer-mode');
    await developerSection.waitFor({ state: 'visible', timeout: 15000 });
    const heading = (await developerSection.locator('h3').textContent() || '').trim();
    assert(heading.length > 0, 'Developer Mode heading must have a readable label.');
    const actionButtons = developerSection.locator('.actions button');
    const actionCount = await actionButtons.count();
    assert(actionCount === 3, 'Developer Mode must show three human-facing actions.');
    for (let i = 0; i < actionCount; i += 1) {
      const button = actionButtons.nth(i);
      assert(await button.isVisible(), 'Developer Mode action must be visible.');
      assert((await button.textContent() || '').trim().length > 0,
        'Developer Mode action must have a nonempty label.');
    }
    const statusRegion = developerSection.locator('.status');
    await statusRegion.waitFor({ state: 'visible', timeout: 15000 });
    const statusCodes = await statusRegion.locator('code').allTextContents();
    assert(statusCodes.length >= 2,
      'Read-only Developer Mode status must expose transport and capability observations.');
    await optionsPage.close();

    const evidence = {
      schemaVersion: 1,
      status: 'PASS',
      sourceCommit: process.env.GITHUB_SHA || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      runnerArch: process.env.RUNNER_ARCH || process.arch,
      nodeVersion: process.version,
      playwrightVersion,
      profile: {
        kind: 'persistent-context',
        ephemeral: true,
      },
      extensionId,
      runtimeId: observed.runtimeId,
      manifestVersion: observed.manifest.manifest_version,
      extensionName: observed.manifest.name,
      nativeMessagingPermission: true,
      serviceWorkerUrl: worker.url(),
      claims: {
        chromiumExtensionLoads: true,
        pinnedDevelopmentIdentityObserved: true,
        nativeMessagingManifestPermissionObserved: true,
        developerModeSettingsVisible: true,
        developerModeActionsLabeled: true,
        developerModeReadOnlyStatusVisible: true,
        nativeHostConnected: false,
        developerModeActionInvoked: false,
        controllerIngressExercised: false,
        reconcileExercised: false,
        browserExecutionAuthority: false,
        authorityChange: false,
      },
    };

    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
  } finally {
    await context.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
