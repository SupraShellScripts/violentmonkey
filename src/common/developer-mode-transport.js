export const DEVELOPER_MODE_HOST = 'io.github.suprashellscripts.violentmonkey_workbench';
export const DEVELOPER_MODE_HANDSHAKE = 'developer-mode.handshake';
export const DEVELOPER_MODE_PROTOCOL_VERSION = 1;
export const CONTROLLED_RECONCILE_OPERATION = 'runtime.reconcile-controlled';
export const DEVELOPMENT_STATE_OPERATION = 'runtime.reconcile-development-state';
export const INSPECT_DEVELOPMENT_STATE_OPERATION = 'runtime.inspect-development-state';
export const CONTROLLED_RUNTIME_OPERATION = 'runtime.execute-controlled';

export function createHandshakeRequest(extensionVersion) {
  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_HANDSHAKE,
    client: {
      name: 'violentmonkey',
      version: extensionVersion,
    },
    // Request both mutation generations plus the independent read-only
    // inspection capability. Negotiation rejects co-advertised mutation
    // generations; runtime.execute-controlled remains requested only as a
    // negative capability boundary and is not implemented.
    requestedCapabilities: [
      CONTROLLED_RECONCILE_OPERATION,
      DEVELOPMENT_STATE_OPERATION,
      INSPECT_DEVELOPMENT_STATE_OPERATION,
      CONTROLLED_RUNTIME_OPERATION,
    ],
  };
}

export function negotiateCapabilities(requestedCapabilities, returnedCapabilities) {
  const requested = new Set(requestedCapabilities);
  const negotiated = returnedCapabilities.filter((item, index, all) => (
    requested.has(item) && all.indexOf(item) === index
  ));
  if (negotiated.includes(CONTROLLED_RECONCILE_OPERATION)
  && negotiated.includes(DEVELOPMENT_STATE_OPERATION)) {
    throw new Error('Legacy controlled reconcile and development-state lifecycle capabilities are mutually exclusive.');
  }
  return negotiated;
}

export function validateHandshakeResponse(message) {
  if (!message || typeof message !== 'object') {
    throw new Error('Native host returned a non-object handshake.');
  }
  if (message.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || message.operation !== DEVELOPER_MODE_HANDSHAKE) {
    throw new Error('Native host protocol version or operation is incompatible.');
  }
  if (message.host?.name !== 'violentmonkey-workbench'
  || typeof message.host.version !== 'string'
  || !message.host.version) {
    throw new Error('Native host identity is invalid.');
  }
  if (typeof message.sessionId !== 'string'
  || !/^[0-9a-f]{32}$/.test(message.sessionId)) {
    throw new Error('Native host session identity is invalid.');
  }
  if (!Array.isArray(message.capabilities)
  || message.capabilities.some(item => typeof item !== 'string')) {
    throw new Error('Native host capabilities are invalid.');
  }
  return {
    host: { ...message.host },
    sessionId: message.sessionId,
    capabilities: [...message.capabilities],
  };
}
