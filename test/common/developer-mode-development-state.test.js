import { webcrypto } from 'crypto';
import {
  CONTROLLED_RECONCILE_OPERATION,
  DEVELOPMENT_STATE_OPERATION,
} from '@/common/developer-mode-transport';
import {
  createDevelopmentStateResult,
  DEVELOPMENT_STATE_RESULT,
  DEVELOPMENT_STATES,
  validateDevelopmentStateEnvelope,
  verifyDevelopmentStateArtifact,
} from '@/common/developer-mode-development-state';
import {
  sha256TextHex,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function buildMessage(desiredState = 'present-enabled', expectedManagedRevision = null) {
  const digest = await sha256TextHex(CODE, webcrypto);
  return {
    schemaVersion: 1,
    operation: DEVELOPMENT_STATE_OPERATION,
    sessionId: SESSION_ID,
    request: {
      schemaVersion: 1,
      operation: DEVELOPMENT_STATE_OPERATION,
      correlationId: 'corr-lifecycle-1',
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
      desiredState,
      expectedManagedRevision,
    },
    artifactCode: CODE,
  };
}

function context(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    runtimeId: WORKBENCH_FIREFOX_DEV_ID,
    negotiatedCapabilities: [DEVELOPMENT_STATE_OPERATION],
    developerModeEnabled: true,
    transportConnected: true,
    ...overrides,
  };
}

test('dormant lifecycle contract has exactly three desired states', () => {
  expect(DEVELOPMENT_STATE_RESULT).toBe('runtime.reconcile-development-state.result');
  expect(DEVELOPMENT_STATES).toEqual([
    'present-enabled',
    'present-disabled',
    'absent',
  ]);
});

test.each([
  ['present-enabled', null],
  ['present-enabled', 0],
  ['present-disabled', 1],
  ['absent', 2],
])('valid governed lifecycle envelope: %s revision %s', async (state, revision) => {
  const message = await buildMessage(state, revision);
  expect(validateDevelopmentStateEnvelope(message, context())).toBe(message);
  await expect(verifyDevelopmentStateArtifact(message, webcrypto))
  .resolves.toMatch(/^[0-9a-f]{64}$/);
});

test.each([
  ['Developer Mode disabled', { developerModeEnabled: false }],
  ['transport disconnected', { transportConnected: false }],
  ['wrong session', { sessionId: 'different-session' }],
  ['unqualified runtime', { runtimeId: 'violentmonkey-upstream' }],
  ['no lifecycle capability', { negotiatedCapabilities: [] }],
  ['legacy only', { negotiatedCapabilities: [CONTROLLED_RECONCILE_OPERATION] }],
  ['both mutation modes', {
    negotiatedCapabilities: [DEVELOPMENT_STATE_OPERATION, CONTROLLED_RECONCILE_OPERATION],
  }],
])('lifecycle authority gate fails closed: %s', async (label, patch) => {
  const message = await buildMessage();
  expect(() => validateDevelopmentStateEnvelope(message, context(patch))).toThrow();
});

test.each([
  ['unsupported desired state', request => { request.desiredState = 'removed'; }],
  ['negative revision', request => { request.expectedManagedRevision = -1; }],
  ['fractional revision', request => { request.expectedManagedRevision = 1.5; }],
  ['string revision', request => { request.expectedManagedRevision = '1'; }],
  ['source repository', request => { request.sourceAuthority.repository = 'other/repo'; }],
  ['qualification state', request => { request.qualification.state = 'DRIFTED'; }],
  ['scope widening', request => {
    request.target.requestedMatches.push('https://other.invalid/*');
  }],
  ['production profile', request => { request.profile.scope = 'production'; }],
  ['wrong adapter', request => { request.adapter = 'mock'; }],
])('lifecycle request rejects %s', async (label, mutate) => {
  const message = await buildMessage();
  const changed = clone(message);
  mutate(changed.request);
  expect(() => validateDevelopmentStateEnvelope(changed, context())).toThrow();
});

test('lifecycle request is closed and never accepts controller script IDs', async () => {
  const message = await buildMessage();
  message.request.scriptId = 7;
  expect(() => validateDevelopmentStateEnvelope(message, context())).toThrow(/unsupported/i);
});

test('lifecycle artifact bytes remain independently digest-bound', async () => {
  const message = await buildMessage();
  message.artifactCode += '\n// drift';
  validateDevelopmentStateEnvelope(message, context());
  await expect(verifyDevelopmentStateArtifact(message, webcrypto)).rejects.toThrow(/bytes/i);
});

test('converged present and absent results preserve non-execution claims', async () => {
  const present = await buildMessage('present-enabled', null);
  expect(createDevelopmentStateResult({
    message: present,
    status: 'converged',
    managedRevision: 0,
    scriptId: 7,
  })).toEqual({
    schemaVersion: 1,
    operation: DEVELOPMENT_STATE_RESULT,
    correlationId: present.request.correlationId,
    sessionId: SESSION_ID,
    status: 'converged',
    artifact: {
      identity: present.request.artifact.identity,
      version: present.request.artifact.version,
      sha256: present.request.artifact.sha256,
    },
    desiredState: 'present-enabled',
    managedRevision: 0,
    scriptId: 7,
    browserExecution: false,
    postconditionObserved: false,
    error: null,
  });

  const absent = await buildMessage('absent', 0);
  expect(createDevelopmentStateResult({
    message: absent,
    status: 'converged',
    managedRevision: 1,
  }).scriptId).toBeNull();
});

test('lifecycle result contract rejects ambiguous success/failure shapes', async () => {
  const present = await buildMessage();
  const absent = await buildMessage('absent', 0);
  expect(() => createDevelopmentStateResult({
    message: present, status: 'converged', scriptId: 7,
  })).toThrow(/managedRevision/i);
  expect(() => createDevelopmentStateResult({
    message: present, status: 'converged', managedRevision: 0,
  })).toThrow(/positive script ID/i);
  expect(() => createDevelopmentStateResult({
    message: absent, status: 'converged', managedRevision: 1, scriptId: 7,
  })).toThrow(/scriptId=null/i);
  expect(() => createDevelopmentStateResult({
    message: present, status: 'blocked', error: 'wrong-error',
  })).toThrow(/request-blocked/i);
  expect(() => createDevelopmentStateResult({
    message: present, status: 'error', error: 'wrong-error',
  })).toThrow(/reconcile-failed/i);
});

test('blocked and error results remain non-mutating result shapes', async () => {
  const message = await buildMessage();
  expect(createDevelopmentStateResult({
    message,
    status: 'blocked',
    error: 'request-blocked',
  })).toMatchObject({
    status: 'blocked', scriptId: null, browserExecution: false,
    postconditionObserved: false, error: 'request-blocked',
  });
  expect(createDevelopmentStateResult({
    message,
    status: 'error',
    error: 'reconcile-failed',
  })).toMatchObject({
    status: 'error', scriptId: null, browserExecution: false,
    postconditionObserved: false, error: 'reconcile-failed',
  });
});
