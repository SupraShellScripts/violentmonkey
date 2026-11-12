#!/usr/bin/env node
'use strict';
// Synthetic-only end-to-end test: official extension <-> official MCP server,
// explicit consent in a disposable browser profile, read-only and no tab grants.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/pw/node_modules/playwright');
const input = path.resolve(process.argv[2] || '');
if (!fs.existsSync(path.join(input, 'manifest.json'))) {
  throw new Error('No upstream extension manifest at expected build output');
}
const expectedSha = process.env.UPSTREAM_EXTENSION_SHA || '';
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('Missing immutable upstream extension SHA');
const mcpSourceSha = process.env.MCP_SOURCE_SHA || '';
if (!/^[0-9a-f]{40}$/.test(mcpSourceSha)) throw new Error('Missing immutable official MCP SHA');
const TOKEN = 'synthetic-bakeoff-local-only-not-a-credential';
async function waitFor(check, maxMs=15000) {
  const end=Date.now()+maxMs;
  while (Date.now()<end) {
    try { if (await check()) return; } catch {}
    await new Promise(done=>setTimeout(done,150));
  }
  throw new Error('Timed out waiting for synthetic MCP connection state');
}
async function main() {
  let serverProcess;
  let writeServerProcess;
  let agent;
  let writer;
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

    // Start the immutable upstream MCP CLI on container-local loopback.
    // No user browser, external port or real token enters this workcell.
    serverProcess=spawn(process.execPath, [
      '/mcp/packages/server/dist/cli.js', '--transport', 'http', '--readonly',
      '--host', '127.0.0.1', '--port', '5678', '--token', TOKEN,
    ],{stdio:['pipe','ignore','ignore']});
    await waitFor(async()=>{
      if (serverProcess.exitCode !== null) throw Error('MCP server exited early');
      return (await fetch('http://127.0.0.1:5678/health')).ok;
    },15000);

    // The SDK comes from the actual immutable MCP workspace, not a test
    // imitation or unrelated globally installed package.
    const fromServer=createRequire('/mcp/packages/server/package.json');
    const sdkClientPath=fromServer.resolve('@modelcontextprotocol/sdk/client/index.js');
    const sdkTransportPath=fromServer.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const [{ Client }, { StreamableHTTPClientTransport }]=await Promise.all([
      import(pathToFileURL(sdkClientPath).href),
      import(pathToFileURL(sdkTransportPath).href),
    ]);
    agent=new Client({name:'public-synthetic-bakeoff',version:'1.0.0'});
    await agent.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:5678/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+TOKEN}}}
    ));
    const initial=(await agent.listTools()).tools.map(x=>x.name);
    if (initial.length!==1 || initial[0]!=='vm_status') {
      throw Error('Disconnected server must expose only vm_status');
    }
    const disconnected=await agent.callTool({name:'vm_status',arguments:{}});
    if (disconnected.structuredContent?.connected!==false) {
      throw Error('Disconnected status misreported');
    }

    // Navigate only the official synthetic connection URL to trigger the
    // extension's consent page; never approve a real browser/server.
    const consentTab=await ctx.newPage();
    const connectUrl='https://violentmonkey.github.io/mcp_connect.html?port=5678&token='+TOKEN;
    await consentTab.goto(connectUrl,{waitUntil:'commit',timeout:20000}).catch(()=>{});
    await section.locator('h3[data-status="pending"]').waitFor({state:'visible',timeout:20000});
    const pendingButtons=section.locator('button');
    if (await pendingButtons.count()!==2) throw Error('Expected explicit Approve/Reject controls');
    for (let i=0;i<2;i++) {
      if (!(await pendingButtons.nth(i).textContent()||'').trim()) {
        throw Error('Consent action lacks a readable label');
      }
    }
    const preApproval=(await agent.listTools()).tools.map(x=>x.name);
    if (preApproval.length!==1 || preApproval[0]!=='vm_status') {
      throw Error('MCP must not grant tools merely on navigation');
    }
    await pendingButtons.first().click(); // explicit consent in synthetic profile only
    await waitFor(async()=>{
      const result=await agent.callTool({name:'vm_status',arguments:{}});
      return result.structuredContent?.connected===true;
    },20000);
    await section.locator('h3[data-status="open"]').waitFor({state:'visible',timeout:20000});
    const tools=(await agent.listTools()).tools.map(x=>x.name).sort();
    const expected=['vm_status','scripts_list','scripts_get','tabs_list',
      'tab_scripts','script_logs','scripts_test_match'].sort();
    if (JSON.stringify(tools)!==JSON.stringify(expected)) {
      throw Error('Readonly MCP tool intersection differs from stable 2.50.0: '+tools.join(','));
    }
    const scriptList=await agent.callTool({name:'scripts_list',arguments:{}});
    if (scriptList.isError || scriptList.structuredContent?.scripts?.length!==0) {
      throw Error('Synthetic empty profile did not list zero scripts');
    }
    const tabList=await agent.callTool({name:'tabs_list',arguments:{}});
    if (tabList.isError || tabList.structuredContent?.tabs?.length!==0) {
      throw Error('Tabs were granted without explicit tab consent');
    }
    const disallowed=['scripts_write','scripts_delete','scripts_set_enabled','tab_reload','script_call'];
    if (disallowed.some(name=>tools.includes(name))) {
      throw Error('Readonly connection exposes mutation tool');
    }

    // A read-only tool list alone is insufficient: attempt the actual MCP
    // mutation call and a tab-scoped read with no human grant.
    const sampleCode=[
      '// ==UserScript==', '// @name Workbench MCP Synthetic Fixture',
      '// @namespace https://example.invalid/workbench-mcp',
      '// @match https://example.invalid/synthetic/*',
      '// @grant none', '// ==/UserScript==',
    ].join('\n') + '\nconst VERSION = 1;\n';
    const deniedWrite=await agent.callTool({name:'scripts_write',arguments:{code:sampleCode}});
    if (!deniedWrite.isError) throw Error('Readonly MCP unexpectedly accepted a script write');
    const deniedTab=await agent.callTool({name:'script_logs',arguments:{tabId:7654321}});
    if (!deniedTab.isError) throw Error('Unconsented tab unexpectedly exposed logs');
    const afterDenied=(await agent.callTool({name:'scripts_list',arguments:{}}));
    if (afterDenied.isError || afterDenied.structuredContent?.scripts?.length!==0) {
      throw Error('Denied write changed the empty synthetic profile');
    }
    await section.locator('button').first().click(); // disconnect synthetic server
    await waitFor(async()=>{
      const result=await agent.callTool({name:'vm_status',arguments:{}});
      return result.structuredContent?.connected===false;
    },12000);
    const after=(await agent.listTools()).tools.map(x=>x.name);
    if (after.length!==1 || after[0]!=='vm_status') {
      throw Error('Disconnected server retained a privileged tool');
    }
    await consentTab.close();

    // Separate, explicitly approved writable session. It is scoped to this
    // disposable, initially empty profile and a nonmatching synthetic fixture.
    // We intentionally test a stale write to measure whether the official
    // protocol provides a native expected-revision guard. All state is deleted.
    const writeToken=TOKEN+'-write-only-synthetic';
    writeServerProcess=spawn(process.execPath, [
      '/mcp/packages/server/dist/cli.js', '--transport','http',
      '--host','127.0.0.1','--port','5679','--token',writeToken,
    ],{stdio:['pipe','ignore','ignore']});
    await waitFor(async()=>{
      if (writeServerProcess.exitCode!==null) throw Error('Writable synthetic server exited');
      return (await fetch('http://127.0.0.1:5679/health')).ok;
    },15000);
    writer=new Client({name:'public-synthetic-write-qualification',version:'1.0.0'});
    await writer.connect(new StreamableHTTPClientTransport(
      new URL('http://127.0.0.1:5679/mcp'),
      {requestInit:{headers:{Authorization:'Bearer '+writeToken}}}
    ));
    const beforeWrite=(await writer.listTools()).tools.map(x=>x.name);
    if (beforeWrite.length!==1 || beforeWrite[0]!=='vm_status') {
      throw Error('Writable synthetic server exposed tools before browser approval');
    }
    const secondConsentTab=await ctx.newPage();
    await secondConsentTab.goto(
      'https://violentmonkey.github.io/mcp_connect.html?port=5679&token='+writeToken,
      {waitUntil:'commit',timeout:20000}
    ).catch(()=>{});
    await section.locator('h3[data-status="pending"]').waitFor({state:'visible',timeout:20000});
    if ((await writer.listTools()).tools.map(x=>x.name).join(',')!=='vm_status') {
      throw Error('Writable tools leaked during pending approval');
    }
    await section.locator('button').first().click();
    await waitFor(async()=>{
      const status=await writer.callTool({name:'vm_status',arguments:{}});
      return status.structuredContent?.connected===true;
    },20000);
    await section.locator('h3[data-status="open"]').waitFor({state:'visible',timeout:20000});
    const writableTools=(await writer.listTools()).tools.map(x=>x.name);
    if (!['scripts_list','scripts_get','scripts_write','scripts_delete'].every(x=>writableTools.includes(x))) {
      throw Error('Writable official MCP does not expose required CRUD fixture tools');
    }
    const created=await writer.callTool({name:'scripts_write',arguments:{code:sampleCode}});
    const scriptId=created.structuredContent?.script?.id;
    if (created.isError || created.structuredContent?.created!==true || !Number.isInteger(scriptId) || scriptId<1) {
      throw Error('Synthetic owned fixture create failed');
    }
    const getCode=async()=>{
      const got=await writer.callTool({name:'scripts_get',arguments:{id:scriptId}});
      if (got.isError || typeof got.structuredContent?.script?.code!=='string') {
        throw Error('Cannot read back synthetic fixture source');
      }
      return got.structuredContent.script.code;
    };
    const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
    const first=await getCode();
    if (!first.includes('const VERSION = 1;')) throw Error('Initial synthetic script source drift');
    const firstSha=digest(first);
    const updatedCode=sampleCode.replace('const VERSION = 1;', 'const VERSION = 2;');
    const update=await writer.callTool({name:'scripts_write',arguments:{id:scriptId,code:updatedCode}});
    if (update.isError || update.structuredContent?.created!==false) {
      throw Error('Synthetic managed fixture update failed');
    }
    const second=await getCode();
    if (!second.includes('const VERSION = 2;') || digest(second)===firstSha) {
      throw Error('Updated synthetic source was not committed');
    }
    // Stale source is submitted WITH the current id, but WITHOUT any
    // expected-revision field. This intentionally tests last-write-wins only.
    const stale=await writer.callTool({name:'scripts_write',arguments:{id:scriptId,code:sampleCode}});
    if (stale.isError) throw Error('Upstream unexpectedly rejected stale synthetic write; re-evaluate CAS');
    const overwritten=await getCode();
    if (digest(overwritten)!==firstSha) {
      throw Error('Upstream revision semantics changed; fresh independent review needed');
    }
    const deleted=await writer.callTool({name:'scripts_delete',arguments:{id:scriptId}});
    if (deleted.isError || deleted.structuredContent?.id!==scriptId) {
      throw Error('Synthetic fixture cleanup failed');
    }
    const empty=(await writer.callTool({name:'scripts_list',arguments:{}}));
    if (empty.isError || empty.structuredContent?.scripts?.length!==0) {
      throw Error('Synthetic fixture not deleted after write test');
    }
    await section.locator('button').first().click(); // synthetic Disconnect
    await waitFor(async()=>{
      const s=await writer.callTool({name:'vm_status',arguments:{}});
      return s.structuredContent?.connected===false;
    },12000);
    if ((await writer.listTools()).tools.map(x=>x.name).join(',')!=='vm_status') {
      throw Error('Writable disconnect failed to revoke exposed tools');
    }
    await secondConsentTab.close();
    const evidence = {
      schemaVersion:1, grade:'UPSTREAM_MCP_LIVE_SYNTHETIC_READONLY_BAKEOFF',
      status:'PASS', upstreamExtensionSha:expectedSha, upstreamMcpSha:mcpSourceSha,
      runtimeId:id, manifestVersion:manifest.manifest_version,
      extensionVersion:manifest.version, nodeVersion:process.version,
      profile:'ephemeral-test-data-only',
      checks:{upstreamMcpConsentPanelVisible:true,headingLabeled:true,unconnectedIdle:true,
        explicitSyntheticApprovalRequired:true, toolsBeforeApproval:['vm_status'],
        toolNamesOnApproval:expected, noGrantTabListingObserved:true,
        readonlyNoMutationTools:true, readonlyWriteCallDenied:true,
        ungrantedTabLogReadDenied:true, noInstalledScripts:true,
        disconnectRevokesTools:true, writableSyntheticFixtureCreateUpdateDelete:true,
        staleWriteAcceptedWithoutExpectedRevision:true,
        writableConsentAndDisconnectRequired:true,
        grantsCreated:false,writeToolsInvoked:true,
        nativeHostUsed:false,authenticatedProfileUsed:false},
      promotionAuthorized:false, completeMcpHeadToHead:false,
      syntheticWritesOnly:true, privateSourceUsed:false,
    };
    console.log(JSON.stringify(evidence));
    await page.close();
  } finally {
    await writer?.close().catch(()=>{});
    await agent?.close().catch(()=>{});
    if (writeServerProcess) writeServerProcess.kill('SIGTERM');
    if (serverProcess) serverProcess.kill('SIGTERM');
    await ctx.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
