export const DEVELOPER_MODE_HOST = 'io.github.suprashellscripts.violentmonkey_workbench';
export const DEVELOPER_MODE_HANDSHAKE = 'developer-mode.handshake';
export const DEVELOPER_MODE_PROTOCOL_VERSION = 1;
export const CONTROLLED_RUNTIME_OPERATION = 'runtime.execute-controlled';

export function createHandshakeRequest(extensionVersion) {
  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPER_MODE_HANDSHAKE,
    client: {
      name: 'violentmonkey',
      version: extensionVersion,
    },
    requestedCapabilities: [CONTROLLED_RUNTIME_OPERATION],
  };
}

export function negotiateCapabilities(requestedCapabilities, returnedCapabilities) {
  const requested = new Set(requestedCapabilities);
  return returnedCapabilities.filter((item, index, all) => (
    requested.has(item) && all.indexOf(item) === index
  ));
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
  if (typeof message.sessionId !== 'string' || !message.sessionId) {
    throw new Error('Native host did not establish a session.');
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
