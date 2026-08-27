export const DEVELOPER_MODE_PROTOCOL_VERSION = 1;
export const DEVELOPER_MODE_STATUS_OPERATION = 'developer-mode.status';

/**
 * Reports only capabilities implemented by this extension build.
 * Enabling Developer Mode does not imply that a native host is installed.
 */
export function createDeveloperModeStatus({
  enabled,
  extensionVersion,
  manifestVersion,
}) {
  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: enabled === true,
    extensionVersion,
    manifestVersion,
    capabilities: ['status'],
    transport: {
      kind: 'none',
      connected: false,
    },
    controlledRuntime: {
      available: false,
      operation: 'runtime.execute-controlled',
    },
    limitation: enabled
      ? 'Developer Mode is enabled, but native messaging and controlled browser execution are not implemented in this foundation slice.'
      : 'Developer Mode is disabled.',
  };
}
