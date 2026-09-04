import {
  canEstablishDeveloperModePort,
  canRevokeDeveloperModePort,
  createDeveloperModeStatus,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  DEVELOPER_MODE_STATUS_OPERATION,
  isCurrentDeveloperModePort,
  shouldDisconnectDeveloperMode,
} from '@/common/developer-mode';
import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPMENT_STATE_OPERATION,
} from '@/common/developer-mode-transport';

const buildStatus = (enabled, extra = {}) => createDeveloperModeStatus({
  enabled,
  extensionVersion: '2.46.0',
  manifestVersion: 3,
  ...extra,
});

test('Developer Mode is fail-closed unless explicitly enabled', () => {
  for (const value of [undefined, null, false, 0, 'true']) {
    const status = buildStatus(value, {
      transport: { kind: 'native-messaging', connected: true },
      negotiatedCapabilities: [
        CONTROLLED_RECONCILE_OPERATION,
        DEVELOPMENT_STATE_OPERATION,
        CONTROLLED_RUNTIME_OPERATION,
      ],
    });
    expect(status.enabled).toBe(false);
    expect(status.transport).toEqual({
      kind: 'native-messaging',
      connected: false,
    });
    expect(status.controlledReconcile).toMatchObject({
      available: false,
      negotiated: false,
    });
    expect(status.developmentState).toMatchObject({
      available: false,
      negotiated: false,
    });
    expect(status.controlledRuntime).toMatchObject({
      available: false,
      negotiated: false,
    });
  }
});

test('Developer Mode disable transitions revoke an active session', () => {
  expect(shouldDisconnectDeveloperMode(true)).toBe(false);
  for (const value of [undefined, null, false, 0, 'true']) {
    expect(shouldDisconnectDeveloperMode(value)).toBe(true);
  }
});

test('stale native-port events cannot revoke the current port generation', () => {
  const oldPort = {};
  const currentPort = {};
  expect(isCurrentDeveloperModePort(currentPort, currentPort)).toBe(true);
  expect(isCurrentDeveloperModePort(currentPort, oldPort)).toBe(false);
  expect(isCurrentDeveloperModePort(null, oldPort)).toBe(false);
});

test('stale handshake generations cannot establish or revoke newer state', () => {
  const oldPort = {};
  const currentPort = {};

  expect(canEstablishDeveloperModePort(oldPort, oldPort, true)).toBe(true);
  expect(canRevokeDeveloperModePort(oldPort, oldPort)).toBe(true);

  expect(canEstablishDeveloperModePort(currentPort, oldPort, true)).toBe(false);
  expect(canRevokeDeveloperModePort(currentPort, oldPort)).toBe(false);

  expect(canEstablishDeveloperModePort(currentPort, currentPort, false)).toBe(false);
  expect(canEstablishDeveloperModePort(currentPort, currentPort, 'true')).toBe(false);

  expect(canEstablishDeveloperModePort(null, null, true)).toBe(false);
  expect(canRevokeDeveloperModePort(null, null)).toBe(false);
});

test('development-state lifecycle can be available while execution remains unavailable', () => {
  const transport = {
    kind: 'native-messaging',
    connected: true,
    host: 'io.github.suprashellscripts.violentmonkey_workbench',
    sessionId: 'ephemeral-session',
  };
  const status = buildStatus(true, {
    transport,
    negotiatedCapabilities: [DEVELOPMENT_STATE_OPERATION],
  });
  expect(status).toMatchObject({
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: true,
    extensionVersion: '2.46.0',
    manifestVersion: 3,
    capabilities: ['status', 'native-handshake'],
    transport,
    controlledReconcile: {
      available: false,
      negotiated: false,
      operation: CONTROLLED_RECONCILE_OPERATION,
    },
    developmentState: {
      available: true,
      negotiated: true,
      operation: DEVELOPMENT_STATE_OPERATION,
    },
    controlledRuntime: {
      available: false,
      negotiated: false,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
  });
  expect(status.limitation).toMatch(/lifecycle.*execution.*remain unavailable/i);
});

test('reconcile can be available while lifecycle and full execution remain unavailable', () => {
  const transport = {
    kind: 'native-messaging',
    connected: true,
    host: 'io.github.suprashellscripts.violentmonkey_workbench',
    sessionId: 'ephemeral-session',
  };
  const status = buildStatus(true, {
    transport,
    negotiatedCapabilities: [CONTROLLED_RECONCILE_OPERATION],
  });
  expect(status).toMatchObject({
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: true,
    extensionVersion: '2.46.0',
    manifestVersion: 3,
    capabilities: ['status', 'native-handshake'],
    transport,
    controlledReconcile: {
      available: true,
      negotiated: true,
      operation: CONTROLLED_RECONCILE_OPERATION,
    },
    developmentState: {
      available: false,
      negotiated: false,
      operation: DEVELOPMENT_STATE_OPERATION,
    },
    controlledRuntime: {
      available: false,
      negotiated: false,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
  });
  expect(status.limitation).toMatch(/execution.*remain unavailable/i);
});

test('negotiated execute capability still does not make full runtime available', () => {
  const status = buildStatus(true, {
    transport: { kind: 'native-messaging', connected: true },
    negotiatedCapabilities: [CONTROLLED_RUNTIME_OPERATION],
  });
  expect(status.controlledReconcile.available).toBe(false);
  expect(status.developmentState.available).toBe(false);
  expect(status.controlledRuntime).toEqual({
    available: false,
    negotiated: true,
    operation: CONTROLLED_RUNTIME_OPERATION,
  });
  expect(status.limitation).toMatch(/not implemented/i);
});
