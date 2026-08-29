import browser from '@/common/browser';
import {
  createDeveloperModeStatus,
  isCurrentDeveloperModePort,
  shouldDisconnectDeveloperMode,
} from '@/common/developer-mode';
import {
  createControlledReconcileResult,
  CONTROLLED_RECONCILE_RESULT,
  validateControlledReconcileEnvelope,
  validateControlledUserscriptMetadata,
  verifyControlledReconcileArtifact,
} from '@/common/developer-mode-reconcile';
import {
  CONTROLLED_RECONCILE_OPERATION,
  createHandshakeRequest,
  DEVELOPER_MODE_HOST,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  negotiateCapabilities,
  validateHandshakeResponse,
} from '@/common/developer-mode-transport';
import { kDeveloperMode } from '@/common/options-defaults';
import { addOwnCommands, commands } from './init';
import { getOption, hookOptions } from './options';

const HANDSHAKE_TIMEOUT = 5000;
let port;
let negotiatedCapabilities = [];
let transport = disconnectedTransport();

addOwnCommands({
  ConnectDeveloperMode: connect,
  DisconnectDeveloperMode: disconnect,
  GetDeveloperModeStatus: getStatus,
});

// Removing the explicit opt-in revokes the native session immediately;
// masking the connection in status is not sufficient isolation.
hookOptions(changes => {
  if (Object.prototype.hasOwnProperty.call(changes, kDeveloperMode)
  && shouldDisconnectDeveloperMode(changes[kDeveloperMode])) {
    disconnect();
  }
});

function disconnectedTransport(error = null) {
  return {
    kind: 'native-messaging',
    connected: false,
    host: DEVELOPER_MODE_HOST,
    error,
  };
}

function getStatus() {
  const manifest = browser.runtime.getManifest();
  return createDeveloperModeStatus({
    enabled: getOption(kDeveloperMode),
    extensionVersion: manifest.version,
    manifestVersion: manifest.manifest_version,
    transport,
    negotiatedCapabilities,
  });
}

function getReconcileContext() {
  return {
    sessionId: transport.sessionId,
    runtimeId: browser.runtime.id,
    negotiatedCapabilities,
    developerModeEnabled: getOption(kDeveloperMode),
    transportConnected: transport.connected,
  };
}

function assertCurrentReconcile(nativePort, message) {
  if (nativePort !== port) {
    throw new Error('Controlled reconcile native session is no longer current.');
  }
  return validateControlledReconcileEnvelope(message, getReconcileContext());
}

async function connect() {
  if (getOption(kDeveloperMode) !== true) {
    throw new Error('Developer Mode must be explicitly enabled before connecting.');
  }
  if (transport.connected) return getStatus();
  disconnect();
  const manifest = browser.runtime.getManifest();
  const request = createHandshakeRequest(manifest.version);
  try {
    port = browser.runtime.connectNative(DEVELOPER_MODE_HOST);
    const handshake = await waitForHandshake(port, request);
    negotiatedCapabilities = negotiateCapabilities(
      request.requestedCapabilities, handshake.capabilities);
    transport = {
      kind: 'native-messaging',
      connected: true,
      host: DEVELOPER_MODE_HOST,
      hostVersion: handshake.host.version,
      sessionId: handshake.sessionId,
      error: null,
    };
    const establishedPort = port;
    establishedPort.onMessage.addListener(
      message => onNativeMessage(establishedPort, message));
    establishedPort.onDisconnect.addListener(
      () => onDisconnect(establishedPort));
    return getStatus();
  } catch (err) {
    disconnect(String(err?.message || err));
    throw err;
  }
}

function disconnect(error = null) {
  const oldPort = port;
  port = null;
  negotiatedCapabilities = [];
  transport = disconnectedTransport(error);
  try {
    oldPort?.disconnect();
  } catch {
    // The browser may already have closed an unavailable native host.
  }
  return getStatus();
}

function onDisconnect(disconnectedPort) {
  // Port events may be delivered after a reconnect. A stale generation must
  // never revoke the newer session or its negotiated capability state.
  if (!isCurrentDeveloperModePort(port, disconnectedPort)) return;
  const error = browser.runtime.lastError?.message || 'Native host disconnected.';
  port = null;
  negotiatedCapabilities = [];
  transport = disconnectedTransport(error);
}

async function onNativeMessage(nativePort, message) {
  if (message?.operation !== CONTROLLED_RECONCILE_OPERATION) return;
  let phase = 'authorization';
  let result;
  try {
    assertCurrentReconcile(nativePort, message);
    await verifyControlledReconcileArtifact(message);
    // SHA-256 is asynchronous, so re-check the exact session and negotiated
    // capability before any parser/database operation.
    assertCurrentReconcile(nativePort, message);

    const parsed = commands.ParseMeta?.(message.artifactCode);
    if (!parsed?.meta || parsed.errors?.length) {
      throw new Error('Controlled userscript metadata failed Violentmonkey validation.');
    }
    validateControlledUserscriptMetadata(parsed.meta, message.request);
    assertCurrentReconcile(nativePort, message);

    phase = 'mutation';
    const reconciled = await commands.ParseScript({
      code: message.artifactCode,
      meta: parsed.meta,
      errors: null,
      message: '',
      bumpDate: false,
    });
    result = createControlledReconcileResult({
      message,
      status: 'reconciled',
      scriptId: reconciled?.where?.id ?? null,
    });
  } catch (err) {
    result = createBlockedReconcileResult(message, phase, err);
  }
  try {
    nativePort.postMessage(result);
  } catch {
    // A disconnect revokes the transport. A later idempotent reconcile can
    // establish authoritative state if an in-flight DB transaction completed.
  }
}

function createBlockedReconcileResult(message, phase, err) {
  try {
    return createControlledReconcileResult({
      message,
      status: phase === 'mutation' ? 'error' : 'blocked',
      error: phase === 'mutation' ? 'reconcile-failed' : 'request-blocked',
    });
  } catch {
    return {
      schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
      operation: CONTROLLED_RECONCILE_RESULT,
      correlationId: typeof message?.request?.correlationId === 'string'
        ? message.request.correlationId : null,
      sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
      status: 'blocked',
      artifact: null,
      scriptId: null,
      browserExecution: false,
      postconditionObserved: false,
      error: err ? 'request-blocked' : null,
    };
  }
}

function waitForHandshake(nativePort, request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(
      reject, new Error('Native host handshake timed out.')), HANDSHAKE_TIMEOUT);
    const onMessage = message => {
      try {
        finish(resolve, validateHandshakeResponse(message));
      } catch (err) {
        finish(reject, err);
      }
    };
    const onEarlyDisconnect = () => finish(
      reject, new Error(browser.runtime.lastError?.message
        || 'Native host disconnected during handshake.'));
    const finish = (callback, value) => {
      clearTimeout(timer);
      nativePort.onMessage.removeListener(onMessage);
      nativePort.onDisconnect.removeListener(onEarlyDisconnect);
      callback(value);
    };
    nativePort.onMessage.addListener(onMessage);
    nativePort.onDisconnect.addListener(onEarlyDisconnect);
    nativePort.postMessage(request);
  });
}
