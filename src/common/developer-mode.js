import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  DEVELOPMENT_STATE_OPERATION,
  INSPECT_DEVELOPMENT_STATE_OPERATION,
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
  return candidatePort != null
    && developerModeEnabled === true
    && isCurrentDeveloperModePort(currentPort, candidatePort);
}

export function canRevokeDeveloperModePort(currentPort, candidatePort) {
  return candidatePort != null
    && isCurrentDeveloperModePort(currentPort, candidatePort);
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
  const lifecycleNegotiated = negotiatedCapabilities.includes(
    DEVELOPMENT_STATE_OPERATION);
  const inspectionNegotiated = negotiatedCapabilities.includes(
    INSPECT_DEVELOPMENT_STATE_OPERATION);
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
    developmentState: {
      available: isEnabled && lifecycleNegotiated,
      negotiated: isEnabled && lifecycleNegotiated,
      operation: DEVELOPMENT_STATE_OPERATION,
    },
    developmentStateInspection: {
      available: isEnabled && inspectionNegotiated,
      negotiated: isEnabled && inspectionNegotiated,
      operation: INSPECT_DEVELOPMENT_STATE_OPERATION,
    },
    controlledRuntime: {
      available: false,
      negotiated: isEnabled && runtimeNegotiated,
      operation: CONTROLLED_RUNTIME_OPERATION,
    },
    limitation: !isEnabled
      ? 'Developer Mode is disabled.'
      : lifecycleNegotiated
        ? 'Development-state lifecycle is available for qualified development artifacts; browser execution and postcondition authority remain unavailable.'
        : reconcileNegotiated
          ? 'Controlled reconcile is available for qualified development artifacts; browser execution and postcondition authority remain unavailable.'
          : inspectionNegotiated
            ? 'Read-only managed development-state inspection is available; mutation, browser execution, and postcondition authority remain unavailable.'
            : runtimeNegotiated
              ? 'The native host negotiated controlled runtime support, but extension execution authority is not implemented in this slice.'
              : 'Developer Mode is enabled; install and connect a compatible Workbench native host to negotiate capabilities.',
  };
}
