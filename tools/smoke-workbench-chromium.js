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

    const evidence = {
      schemaVersion: 1,
      status: 'PASS',
      sourceCommit: process.env.GITHUB_SHA || null,
      runnerOs: process.env.RUNNER_OS || process.platform,
      runnerArch: process.env.RUNNER_ARCH || process.arch,
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
        nativeHostConnected: false,
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
