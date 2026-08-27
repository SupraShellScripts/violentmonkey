import {
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPER_MODE_PROTOCOL_VERSION,
} from './developer-mode-transport';

export { DEVELOPER_MODE_PROTOCOL_VERSION };
export const DEVELOPER_MODE_STATUS_OPERATION = 'developer-mode.status';

export function createDeveloperModeStatus({
  enabled,
  extensionVersion,
  manifestVersion,
  transport,
  negotiatedCapabilities = [],
}) {
  const isEnabled = enabled === true;
  const runtimeNegotiated = negotiatedCapabilities.includes(
    CONTROLLED_RUNTIME_OPERATION);
  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_STATUS_OPERATION,
    enabled: isEnabled,
    extensionVersion,
    manifestVersion,
    capabilities: ['status', 'native-handshake'],
    transport: isEnabled && transport || {
      kind: 'native-messaging',
      connected: false,
    },
    controlledRuntime: {
      available: false,
      negotiated: isEnabled && runtimeNegotiated,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
    limitation: !isEnabled
      ? 'Developer Mode is disabled.'
      : runtimeNegotiated
        ? 'The native host negotiated controlled runtime support, but extension execution authority is not implemented in this slice.'
        : 'Developer Mode is enabled; install and connect a compatible Workbench native host to negotiate capabilities.',
  };
}
