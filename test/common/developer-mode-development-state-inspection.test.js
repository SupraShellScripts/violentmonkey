import {
  createDevelopmentStateInspectionResult,
  INSPECT_DEVELOPMENT_STATE_RESULT,
  validateDevelopmentStateInspectionEnvelope,
} from '@/common/developer-mode-development-state-inspection';
import {
  DEVELOPMENT_STATE_OPERATION,
  INSPECT_DEVELOPMENT_STATE_OPERATION,
} from '@/common/developer-mode-transport';
import { WORKBENCH_FIREFOX_DEV_ID } from '@/common/developer-mode-reconcile';

const SESSION_ID = '0123456789abcdef0123456789abcdef';

function buildMessage(overrides = {}) {
  return {
    schemaVersion: 1,
    operation: INSPECT_DEVELOPMENT_STATE_OPERATION,
    sessionId: SESSION_ID,
    request: {
      schemaVersion: 1,
      operation: INSPECT_DEVELOPMENT_STATE_OPERATION,
      correlationId: 'corr-inspect-1',
      artifactIdentity: 'controlled-fixture',
    },
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    runtimeId: WORKBENCH_FIREFOX_DEV_ID,
    negotiatedCapabilities: [INSPECT_DEVELOPMENT_STATE_OPERATION],
    developerModeEnabled: true,
    transportConnected: true,
    ...overrides,
  };
}

function managedEntry(overrides = {}) {
  return {
    artifactIdentity: 'controlled-fixture',
    name: 'Controlled Fixture',
    namespace: 'https://suprashellscripts.github/workbench',
    committed: {
      artifactSha256: 'a'.repeat(64),
      scriptId: 7,
      desiredState: 'present-enabled',
      managedRevision: 3,
    },
    pending: {
      artifactSha256: 'b'.repeat(64),
      desiredState: 'present-disabled',
      fromRevision: 3,
      targetRevision: 4,
    },
    ...overrides,
  };
}

test('inspection validates exact live session and independent capability', () => {
  const message = buildMessage();
  expect(validateDevelopmentStateInspectionEnvelope(message, context())).toBe(message);
  expect(validateDevelopmentStateInspectionEnvelope(message, context({
    negotiatedCapabilities: [
      DEVELOPMENT_STATE_OPERATION,
      INSPECT_DEVELOPMENT_STATE_OPERATION,
    ],
  }))).toBe(message);
});

test.each([
  ['missing capability', { negotiatedCapabilities: [DEVELOPMENT_STATE_OPERATION] }],
  ['stale session', { sessionId: 'fedcba9876543210fedcba9876543210' }],
  ['wrong runtime', { runtimeId: 'not-the-qualified-workbench-runtime' }],
  ['disabled mode', { developerModeEnabled: false }],
  ['disconnected transport', { transportConnected: false }],
])('inspection fails closed for %s', (_label, overrides) => {
  expect(() => validateDevelopmentStateInspectionEnvelope(
    buildMessage(), context(overrides))).toThrow();
});

test('inspection request is closed-schema and bounded to one artifact identity', () => {
  const extraEnvelope = buildMessage({ unexpected: true });
  expect(() => validateDevelopmentStateInspectionEnvelope(extraEnvelope, context())).toThrow();

  const extraRequest = buildMessage();
  extraRequest.request.unexpected = true;
  expect(() => validateDevelopmentStateInspectionEnvelope(extraRequest, context())).toThrow();

  const oversized = buildMessage();
  oversized.request.artifactIdentity = 'x'.repeat(257);
  expect(() => validateDevelopmentStateInspectionEnvelope(oversized, context())).toThrow(/too long/i);
});

test('managed inspection returns only approved ledger projection and non-execution claims', () => {
  const entry = managedEntry({
    secret: 'must-not-leak',
    committed: {
      ...managedEntry().committed,
      extra: 'must-not-leak',
    },
    pending: {
      ...managedEntry().pending,
      extra: 'must-not-leak',
    },
  });
  const result = createDevelopmentStateInspectionResult({
    message: buildMessage(),
    status: 'observed',
    entry,
  });
  expect(result).toEqual({
    schemaVersion: 1,
    operation: INSPECT_DEVELOPMENT_STATE_RESULT,
    correlationId: 'corr-inspect-1',
    sessionId: SESSION_ID,
    status: 'observed',
    artifactIdentity: 'controlled-fixture',
    managed: true,
    identity: {
      name: 'Controlled Fixture',
      namespace: 'https://suprashellscripts.github/workbench',
    },
    committed: {
      artifactSha256: 'a'.repeat(64),
      scriptId: 7,
      desiredState: 'present-enabled',
      managedRevision: 3,
    },
    pending: {
      artifactSha256: 'b'.repeat(64),
      desiredState: 'present-disabled',
      fromRevision: 3,
      targetRevision: 4,
    },
    runtimeExecuteControlled: false,
    browserExecution: false,
    postconditionObserved: false,
    error: null,
  });
  expect(JSON.stringify(result)).not.toMatch(/must-not-leak/);
});

test('unknown artifact returns structured managed=false without inventory fallback', () => {
  const result = createDevelopmentStateInspectionResult({
    message: buildMessage(),
    status: 'observed',
    entry: null,
  });
  expect(result).toMatchObject({
    status: 'observed',
    artifactIdentity: 'controlled-fixture',
    managed: false,
    identity: null,
    committed: null,
    pending: null,
    runtimeExecuteControlled: false,
    browserExecution: false,
    postconditionObserved: false,
    error: null,
  });
});

test.each([
  ['blocked', 'request-blocked'],
  ['error', 'inspection-failed'],
])('failed inspection result exposes no managed state: %s', (status, error) => {
  const result = createDevelopmentStateInspectionResult({
    message: buildMessage(),
    status,
    error,
  });
  expect(result).toMatchObject({
    status,
    managed: null,
    identity: null,
    committed: null,
    pending: null,
    runtimeExecuteControlled: false,
    browserExecution: false,
    postconditionObserved: false,
    error,
  });
});
