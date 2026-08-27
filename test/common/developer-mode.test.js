import {
  createDeveloperModeStatus,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  DEVELOPER_MODE_STATUS_OPERATION,
} from '@/common/developer-mode';

const buildStatus = enabled => createDeveloperModeStatus({
  enabled,
  extensionVersion: '2.46.0',
  manifestVersion: 3,
});

test('Developer Mode is fail-closed unless explicitly enabled', () => {
  for (const value of [undefined, null, false, 0, 'true']) {
    const status = buildStatus(value);
    expect(status.enabled).toBe(false);
    expect(status.transport).toEqual({ kind: 'none', connected: false });
    expect(status.controlledRuntime.available).toBe(false);
  }
});

test('enabled foundation reports only implemented capabilities', () => {
  const status = buildStatus(true);
  expect(status).toMatchObject({
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: true,
    extensionVersion: '2.46.0',
    manifestVersion: 3,
    capabilities: ['status'],
    transport: { kind: 'none', connected: false },
    controlledRuntime: {
      available: false,
      operation: 'runtime.execute-controlled',
    },
  });
  expect(status.limitation).toMatch(/not implemented/i);
});
