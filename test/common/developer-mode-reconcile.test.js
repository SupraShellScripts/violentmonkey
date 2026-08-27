import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
} from '@/common/developer-mode-transport';
import {
  createControlledReconcileResult,
  isWorkbenchDevelopmentRuntimeId,
  sha256TextHex,
  validateControlledReconcileEnvelope,
  validateControlledUserscriptMetadata,
  verifyControlledReconcileArtifact,
  WORKBENCH_CHROMIUM_DEV_ID,
  WORKBENCH_FIREFOX_DEV_ID,
} from '@/common/developer-mode-reconcile';

const SESSION_ID = '0123456789abcdef0123456789abcdef';
const MATCH = 'https://fixture.invalid/*';
const CODE = `// ==UserScript==
// @name Controlled Fixture
// @namespace https://suprashellscripts.github/workbench
// @version 1.0.0
// @match ${MATCH}
// ==/UserScript==
(() => {})();`;

async function buildMessage(overrides = {}) {
  const digest = await sha256TextHex(CODE);
  const request = {
    schemaVersion: 1,
    operation: CONTROLLED_RUNTIME_OPERATION,
    correlationId: 'corr-1',
    artifact: {
      identity: 'controlled-fixture',
      version: '1.0.0',
      path: 'fixtures/controlled.user.js',
      sha256: digest,
      declaredMatches: [MATCH],
    },
    sourceAuthority: {
      repository: 'SupraShellScripts/userscripts-private',
      commit: 'a'.repeat(40),
      artifactSha256: digest,
      issue: 'SupraShellScripts/userscripts-private#82',
    },
    qualification: {
      repository: 'SemperSupra/BrowserParity-private',
      commit: 'b'.repeat(40),
      issue: 'SemperSupra/BrowserParity-private#56',
      evidenceId: 'fixture-pass',
      state: 'QUALIFIED',
    },
    target: { requestedMatches: [MATCH] },
    profile: { scope: 'development', ephemeral: true, identifier: 'ephemeral-fixture' },
    postcondition: { kind: 'dom-text', selector: '#result', expected: 'applied' },
    adapter: 'violentmonkey',
  };
  return {
    schemaVersion: 1,
    operation: CONTROLLED_RECONCILE_OPERATION,
    sessionId: SESSION_ID,
    request,
    artifactCode: CODE,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    runtimeId: WORKBENCH_FIREFOX_DEV_ID,
    negotiatedCapabilities: [CONTROLLED_RECONCILE_OPERATION],
    developerModeEnabled: true,
    transportConnected: true,
    ...overrides,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('only qualified Workbench development runtime IDs are accepted', () => {
  expect(WORKBENCH_FIREFOX_DEV_ID).toBe(
    'violentmonkey-workbench-dev@suprashellscripts.github');
  expect(WORKBENCH_CHROMIUM_DEV_ID).toBe('mlooodbpjdohbedafmodnmelbmdgmngk');
  expect(isWorkbenchDevelopmentRuntimeId(WORKBENCH_FIREFOX_DEV_ID)).toBe(true);
  expect(isWorkbenchDevelopmentRuntimeId(WORKBENCH_CHROMIUM_DEV_ID)).toBe(true);
  expect(isWorkbenchDevelopmentRuntimeId('{aecec67f-0d10-4fa7-b7c7-609a2db280cf}')).toBe(false);
  expect(isWorkbenchDevelopmentRuntimeId('unrelated-extension')).toBe(false);
});

test('valid controlled reconcile envelope preserves the governed request', async () => {
  const message = await buildMessage();
  expect(validateControlledReconcileEnvelope(message, context())).toBe(message);
  await expect(verifyControlledReconcileArtifact(message)).resolves.toMatch(/^[0-9a-f]{64}$/);
  const deterministic = clone(message);
  deterministic.request.qualification.state = 'DETERMINISTIC';
  expect(validateControlledReconcileEnvelope(deterministic, context())).toBe(deterministic);
});

test.each([
  ['Developer Mode disabled', { developerModeEnabled: false }],
  ['transport disconnected', { transportConnected: false }],
  ['wrong session', { sessionId: 'different-session' }],
  ['unqualified runtime ID', { runtimeId: 'violentmonkey-upstream' }],
  ['capability not negotiated', { negotiatedCapabilities: [] }],
])('authority gate fails closed: %s', async (label, patch) => {
  const message = await buildMessage();
  expect(() => validateControlledReconcileEnvelope(message, context(patch))).toThrow();
});

test('outer envelope is closed and session-bound', async () => {
  const message = await buildMessage();
  expect(() => validateControlledReconcileEnvelope(
    { ...message, unexpected: true }, context())).toThrow(/unsupported/i);
  expect(() => validateControlledReconcileEnvelope(
    { ...message, sessionId: 'stale-session' }, context())).toThrow(/session/i);
});

test.each([
  ['source repository', request => { request.sourceAuthority.repository = 'other/repo'; }],
  ['source commit', request => { request.sourceAuthority.commit = 'mutable-main'; }],
  ['qualification repository', request => { request.qualification.repository = 'other/repo'; }],
  ['drifted qualification', request => { request.qualification.state = 'DRIFTED'; }],
  ['non-ephemeral profile', request => { request.profile.ephemeral = false; }],
  ['non-development profile', request => { request.profile.scope = 'production'; }],
  ['wrong adapter', request => { request.adapter = 'mock'; }],
  ['unknown nested field', request => { request.artifact.extra = true; }],
  ['absolute artifact path', request => { request.artifact.path = 'C:\\tmp\\bad.user.js'; }],
  ['traversing artifact path', request => { request.artifact.path = '../bad.user.js'; }],
  ['non-userscript artifact path', request => { request.artifact.path = 'fixtures/bad.js'; }],
])('embedded authority request rejects %s', async (label, mutate) => {
  const message = await buildMessage();
  const changed = clone(message);
  mutate(changed.request);
  expect(() => validateControlledReconcileEnvelope(changed, context())).toThrow();
});

test('requested match scope may not exceed declared artifact scope', async () => {
  const message = await buildMessage();
  message.request.target.requestedMatches.push('https://other.invalid/*');
  expect(() => validateControlledReconcileEnvelope(message, context())).toThrow(/scope/i);
});

test('artifact and source authority digests must be identical before hashing bytes', async () => {
  const message = await buildMessage();
  message.request.sourceAuthority.artifactSha256 = 'c'.repeat(64);
  expect(() => validateControlledReconcileEnvelope(message, context())).toThrow(/digests diverge/i);
});

test('artifact bytes are independently SHA-256 verified', async () => {
  const message = await buildMessage();
  message.artifactCode += '\n// drift';
  validateControlledReconcileEnvelope(message, context());
  await expect(verifyControlledReconcileArtifact(message)).rejects.toThrow(/bytes/i);
});

test('oversized artifact fails before mutation', async () => {
  const message = await buildMessage({ artifactCode: 'x'.repeat(512 * 1024 + 1) });
  expect(() => validateControlledReconcileEnvelope(message, context())).toThrow(/size limit/i);
});

test('metadata must exactly match governed version and declared scope', async () => {
  const message = await buildMessage();
  const meta = {
    name: 'Controlled Fixture',
    version: '1.0.0',
    match: [MATCH],
    include: [],
    require: [],
    resources: {},
  };
  expect(validateControlledUserscriptMetadata(meta, message.request)).toBe(meta);

  expect(() => validateControlledUserscriptMetadata(
    { ...meta, version: '1.0.1' }, message.request)).toThrow(/version/i);
  expect(() => validateControlledUserscriptMetadata(
    { ...meta, match: ['https://other.invalid/*'] }, message.request)).toThrow(/scope/i);
  expect(() => validateControlledUserscriptMetadata(
    { ...meta, match: [MATCH, MATCH] }, message.request)).toThrow(/unique/i);
});

test('controlled reconcile rejects dependency acquisition', async () => {
  const message = await buildMessage();
  const base = {
    name: 'Controlled Fixture', version: '1.0.0', match: [MATCH], include: [],
    require: [], resources: {},
  };
  expect(() => validateControlledUserscriptMetadata(
    { ...base, require: ['https://cdn.invalid/dep.js'] }, message.request)).toThrow(/dependency/i);
  expect(() => validateControlledUserscriptMetadata(
    { ...base, resources: { icon: 'https://cdn.invalid/icon.png' } }, message.request)).toThrow(/dependency/i);
  expect(() => validateControlledUserscriptMetadata(
    { ...base, icon: 'https://cdn.invalid/icon.png' }, message.request)).toThrow(/dependency/i);
  expect(validateControlledUserscriptMetadata(
    { ...base, icon: 'data:image/png;base64,AA==' }, message.request)).toBeTruthy();
});

test('reconcile result cannot imply browser execution or postcondition observation', async () => {
  const message = await buildMessage();
  expect(createControlledReconcileResult({
    message,
    status: 'reconciled',
    scriptId: 7,
  })).toEqual({
    schemaVersion: 1,
    operation: 'runtime.reconcile-controlled.result',
    correlationId: 'corr-1',
    sessionId: SESSION_ID,
    status: 'reconciled',
    artifact: {
      identity: 'controlled-fixture',
      version: '1.0.0',
      sha256: message.request.artifact.sha256,
    },
    scriptId: 7,
    browserExecution: false,
    postconditionObserved: false,
    error: null,
  });
  expect(() => createControlledReconcileResult({
    message,
    status: 'reconciled',
    scriptId: null,
  })).toThrow(/positive script ID/i);
});
