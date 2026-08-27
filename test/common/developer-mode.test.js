import {
  createDeveloperModeStatus,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  DEVELOPER_MODE_STATUS_OPERATION,
  shouldDisconnectDeveloperMode,
} from '@/common/developer-mode';
import { CONTROLLED_RUNTIME_OPERATION } from '@/common/developer-mode-transport';

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
      negotiatedCapabilities: [CONTROLLED_RUNTIME_OPERATION],
    });
    expect(status.enabled).toBe(false);
    expect(status.transport).toEqual({
      kind: 'native-messaging',
      connected: false,
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

test('enabled foundation reports only implemented capabilities', () => {
  const transport = {
    kind: 'native-messaging',
    connected: true,
    host: 'io.github.suprashellscripts.violentmonkey_workbench',
    sessionId: 'ephemeral-session',
  };
  const status = buildStatus(true, {
    transport,
    negotiatedCapabilities: [CONTROLLED_RUNTIME_OPERATION],
  });
  expect(status).toMatchObject({
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: true,
    extensionVersion: '2.46.0',
    manifestVersion: 3,
    capabilities: ['status', 'native-handshake'],
    transport,
    controlledRuntime: {
      available: false,
      negotiated: true,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
  });
  expect(status.limitation).toMatch(/not implemented/i);
});
