import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPER_MODE_PROTOCOL_VERSION,
} from './developer-mode-transport';

export { DEVELOPER_MODE_PROTOCOL_VERSION };
export const DEVELOPER_MODE_STATUS_OPERATION = 'developer-mode.status';

export function shouldDisconnectDeveloperMode(value) {
  return value !== true;
}

export function isCurrentDeveloperModePort(currentPort, eventPort) {
  return currentPort === eventPort;
}

export function canEstablishDeveloperModePort(
  currentPort, candidatePort, developerModeEnabled,
) {
  return developerModeEnabled === true
    && isCurrentDeveloperModePort(currentPort, candidatePort);
}

export function canRevokeDeveloperModePort(currentPort, candidatePort) {
  return isCurrentDeveloperModePort(currentPort, candidatePort);
}

export function createDeveloperModeStatus({
  enabled,
  extensionVersion,
  manifestVersion,
  transport,
  negotiatedCapabilities = [],
}) {
  const isEnabled = enabled === true;
  const reconcileNegotiated = negotiatedCapabilities.includes(
    CONTROLLED_RECONCILE_OPERATION);
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
    controlledReconcile: {
      available: isEnabled && reconcileNegotiated,
      negotiated: isEnabled && reconcileNegotiated,
      operation: CONTROLLED_RECONCILE_OPERATION,
    },
    controlledRuntime: {
      available: false,
      negotiated: isEnabled && runtimeNegotiated,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
    limitation: !isEnabled
      ? 'Developer Mode is disabled.'
      : reconcileNegotiated
        ? 'Controlled reconcile is available for qualified development artifacts; browser execution and postcondition authority remain unavailable.'
        : runtimeNegotiated
          ? 'The native host negotiated controlled runtime support, but extension execution authority is not implemented in this slice.'
          : 'Developer Mode is enabled; install and connect a compatible Workbench native host to negotiate capabilities.',
  };
}
