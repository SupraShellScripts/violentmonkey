#!/usr/bin/env node
'use strict';
// Synthetic-only browser check: the official upstream extension must render
// its MCP consent surface without performing an agent connection or tab grant.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/pw/node_modules/playwright');
const input = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(input, 'manifest.json'))) {
  throw new Error('No upstream extension manifest at expected build output');
}
const expectedSha = process.env.UPSTREAM_EXTENSION_SHA || '';
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('Missing immutable upstream extension SHA');
async function main() {
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      '--no-sandbox', // disposable rootless-host container; no real browser data
      '--disable-extensions-except=' + input,
      '--load-extension=' + input,
    ],
  });
  try {
    let worker = ctx.serviceWorkers()[0];
    if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const id = new URL(worker.url()).host;
    if (!/^[a-p]{32}$/.test(id)) throw new Error('Unexpected extension identity');
    const observable = await worker.evaluate(() => ({
      runtimeId: chrome.runtime.id,
      manifest: chrome.runtime.getManifest(),
    }));
    if (observable.runtimeId !== id) throw new Error('Manifest/runtime extension identity mismatch');
    const manifest = observable.manifest;
    if (manifest.manifest_version !== 3 || manifest.version !== '2.50.0') {
      throw new Error('Not the pinned stable upstream MV3 extension');
    }
    const options = manifest.options_ui?.page;
    if (typeof options !== 'string' || !options.startsWith('options/index.html')) {
      throw new Error('Missing official options entry');
    }
    const page = await ctx.newPage();
    await page.goto('chrome-extension://' + id + '/options/index.html#settings', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const section = page.locator('section.vm-mcp');
    await section.waitFor({state:'visible',timeout:20000});
    const heading = (await section.locator('h3').textContent() || '').trim();
    if (!heading) throw new Error('MCP heading lacks accessible text');
    const state = await section.locator('h3').getAttribute('data-status');
    if (state !== 'idle') throw new Error('MCP unexpectedly connected or authorized: ' + state);
    const buttons = await section.locator('button').count();
    if (buttons !== 0) throw new Error('Unrequested MCP connection exposed action buttons');
    const links = await section.locator('a[href]').count();
    if (links < 1) throw new Error('Official MCP guidance link not visible');
    const evidence = {
      schemaVersion:1, grade:'UPSTREAM_BROWSER_CONSENT_UI_UNCONNECTED_ONLY',
      status:'PASS', upstreamExtensionSha:expectedSha,
      runtimeId:id, manifestVersion:manifest.manifest_version,
      extensionVersion:manifest.version, nodeVersion:process.version,
      profile:'ephemeral-unprivileged-test-data-only',
      checks:{upstreamMcpConsentPanelVisible:true,headingLabeled:true,unconnectedIdle:true,
        grantsCreated:false,writeToolsInvoked:false,nativeHostUsed:false,authenticatedProfileUsed:false},
      promotionAuthorized:false, completeMcpHeadToHead:false,
    };
    console.log(JSON.stringify(evidence));
    await page.close();
  } finally {
    await ctx.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
