import browser from '@/common/browser';
import {
  canEstablishDeveloperModePort,
  canRevokeDeveloperModePort,
  createDeveloperModeStatus,
  shouldDisconnectDeveloperMode,
} from '@/common/developer-mode';
import {
  createDevelopmentStateInspectionResult,
  INSPECT_DEVELOPMENT_STATE_RESULT,
  validateDevelopmentStateInspectionEnvelope,
} from '@/common/developer-mode-development-state-inspection';
import {
  createDevelopmentStateResult,
  DEVELOPMENT_STATE_RESULT,
  validateDevelopmentStateEnvelope,
  verifyDevelopmentStateArtifact,
} from '@/common/developer-mode-development-state';
import {
  reconcileManagedDevelopmentState,
} from '@/common/developer-mode-development-state-convergence';
import {
  ManagedArtifactOwnershipError,
  reconcileManagedDevelopmentArtifact,
} from '@/common/developer-mode-managed-artifacts';
import {
  activateManagedDevelopmentLifecycle,
  readManagedDevelopmentLifecycleLedger,
} from '@/common/developer-mode-managed-state';
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
  DEVELOPMENT_STATE_OPERATION,
  INSPECT_DEVELOPMENT_STATE_OPERATION,
  negotiateCapabilities,
  validateHandshakeResponse,
} from '@/common/developer-mode-transport';
import { kDeveloperMode } from '@/common/options-defaults';
import { addOwnCommands, commands } from './init';
import { getOption, hookOptions } from './options';
import storage from './storage';

const HANDSHAKE_TIMEOUT = 5000;
let port;
let lifecycleActivation;
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

function getMutationContext() {
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
  return validateControlledReconcileEnvelope(message, getMutationContext());
}

function assertCurrentDevelopmentState(nativePort, message) {
  if (nativePort !== port) {
    throw new Error('Development-state native session is no longer current.');
  }
  return validateDevelopmentStateEnvelope(message, getMutationContext());
}

function assertCurrentDevelopmentStateInspection(nativePort, message) {
  if (nativePort !== port) {
    throw new Error('Development-state inspection native session is no longer current.');
  }
  return validateDevelopmentStateInspectionEnvelope(message, getMutationContext());
}

async function connect() {
  if (getOption(kDeveloperMode) !== true) {
    throw new Error('Developer Mode must be explicitly enabled before connecting.');
  }
  if (transport.connected) {
    if (lifecycleActivation) await lifecycleActivation;
    return getStatus();
  }
  disconnect();
  const manifest = browser.runtime.getManifest();
  const request = createHandshakeRequest(manifest.version);
  let connectingPort;
  try {
    connectingPort = browser.runtime.connectNative(DEVELOPER_MODE_HOST);
    port = connectingPort;
    const handshake = await waitForHandshake(connectingPort, request);
    if (!canEstablishDeveloperModePort(
      port, connectingPort, getOption(kDeveloperMode))) {
      throw new Error('Developer Mode native handshake generation was superseded.');
    }
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
    connectingPort.onMessage.addListener(
      message => onNativeMessage(connectingPort, message));
    connectingPort.onDisconnect.addListener(
      () => onDisconnect(connectingPort));

    if (negotiatedCapabilities.includes(DEVELOPMENT_STATE_OPERATION)) {
      // Negotiating lifecycle mode is the explicit profile activation point.
      // Migrate/fence the profile before any lifecycle request may converge.
      lifecycleActivation = activateManagedDevelopmentLifecycle({
        storageApi: storage.api,
        commandApi: commands,
      });
      await lifecycleActivation;
      if (!canEstablishDeveloperModePort(
        port, connectingPort, getOption(kDeveloperMode))) {
        throw new Error('Developer Mode lifecycle activation was superseded.');
      }
    }
    return getStatus();
  } catch (err) {
    if (!connectingPort || canRevokeDeveloperModePort(port, connectingPort)) {
      disconnect(String(err?.message || err));
    } else {
      try {
        connectingPort.disconnect();
      } catch {
        // A superseded generation may already be closed by its replacement.
      }
    }
    throw err;
  }
}

function disconnect(error = null) {
  const oldPort = port;
  port = null;
  lifecycleActivation = null;
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
  if (!canRevokeDeveloperModePort(port, disconnectedPort)) return;
  const error = browser.runtime.lastError?.message || 'Native host disconnected.';
  port = null;
  lifecycleActivation = null;
  negotiatedCapabilities = [];
  transport = disconnectedTransport(error);
}

async function onNativeMessage(nativePort, message) {
  if (message?.operation === CONTROLLED_RECONCILE_OPERATION) {
    await onControlledReconcileMessage(nativePort, message);
  } else if (message?.operation === DEVELOPMENT_STATE_OPERATION) {
    await onDevelopmentStateMessage(nativePort, message);
  } else if (message?.operation === INSPECT_DEVELOPMENT_STATE_OPERATION) {
    await onDevelopmentStateInspectionMessage(nativePort, message);
  }
}

async function onControlledReconcileMessage(nativePort, message) {
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
    const reconciled = await reconcileManagedDevelopmentArtifact({
      message,
      meta: parsed.meta,
      storageApi: storage.api,
      commandApi: commands,
    });
    result = createControlledReconcileResult({
      message,
      status: 'reconciled',
      scriptId: reconciled?.where?.id ?? null,
    });
  } catch (err) {
    if (err instanceof ManagedArtifactOwnershipError) phase = 'authorization';
    result = createBlockedReconcileResult(message, phase, err);
  }
  postNativeResult(nativePort, result);
}

async function onDevelopmentStateMessage(nativePort, message) {
  let phase = 'authorization';
  let result;
  try {
    if (lifecycleActivation) await lifecycleActivation;
    assertCurrentDevelopmentState(nativePort, message);
    await verifyDevelopmentStateArtifact(message);
    assertCurrentDevelopmentState(nativePort, message);

    const parsed = commands.ParseMeta?.(message.artifactCode);
    if (!parsed?.meta || parsed.errors?.length) {
      throw new Error('Development-state userscript metadata failed Violentmonkey validation.');
    }
    validateControlledUserscriptMetadata(parsed.meta, message.request);
    assertCurrentDevelopmentState(nativePort, message);

    phase = 'mutation';
    const converged = await reconcileManagedDevelopmentState({
      message,
      meta: parsed.meta,
      storageApi: storage.api,
      commandApi: commands,
    });
    result = createDevelopmentStateResult({
      message,
      status: 'converged',
      managedRevision: converged.managedRevision,
      scriptId: converged.scriptId,
    });
  } catch (err) {
    if (err instanceof ManagedArtifactOwnershipError) phase = 'authorization';
    result = createBlockedDevelopmentStateResult(message, phase, err);
  }
  postNativeResult(nativePort, result);
}

async function onDevelopmentStateInspectionMessage(nativePort, message) {
  let phase = 'authorization';
  let result;
  try {
    if (lifecycleActivation) await lifecycleActivation;
    assertCurrentDevelopmentStateInspection(nativePort, message);
    phase = 'observation';
    const ledger = await readManagedDevelopmentLifecycleLedger(storage.api);
    // Observation is asynchronous. Revalidate the exact native generation and
    // negotiated inspection authority before returning ledger-derived facts.
    assertCurrentDevelopmentStateInspection(nativePort, message);
    const entry = ledger.entries.find(
      item => item.artifactIdentity === message.request.artifactIdentity) || null;
    result = createDevelopmentStateInspectionResult({
      message,
      status: 'observed',
      entry,
    });
  } catch (err) {
    result = createBlockedDevelopmentStateInspectionResult(message, phase, err);
  }
  postNativeResult(nativePort, result);
}

function postNativeResult(nativePort, result) {
  try {
    nativePort.postMessage(result);
  } catch {
    // Disconnect revokes transport. A later idempotent request can establish
    // authoritative state if an already-authorized DB mutation completed.
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

function createBlockedDevelopmentStateResult(message, phase, err) {
  try {
    return createDevelopmentStateResult({
      message,
      status: phase === 'mutation' ? 'error' : 'blocked',
      error: phase === 'mutation' ? 'reconcile-failed' : 'request-blocked',
    });
  } catch {
    return {
      schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
      operation: DEVELOPMENT_STATE_RESULT,
      correlationId: typeof message?.request?.correlationId === 'string'
        ? message.request.correlationId : null,
      sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
      status: 'blocked',
      artifact: null,
      desiredState: typeof message?.request?.desiredState === 'string'
        ? message.request.desiredState : null,
      managedRevision: null,
      scriptId: null,
      browserExecution: false,
      postconditionObserved: false,
      error: err ? 'request-blocked' : null,
    };
  }
}

function createBlockedDevelopmentStateInspectionResult(message, phase, err) {
  try {
    return createDevelopmentStateInspectionResult({
      message,
      status: phase === 'observation' ? 'error' : 'blocked',
      error: phase === 'observation' ? 'inspection-failed' : 'request-blocked',
    });
  } catch {
    return {
      schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
      operation: INSPECT_DEVELOPMENT_STATE_RESULT,
      correlationId: typeof message?.request?.correlationId === 'string'
        ? message.request.correlationId : null,
      sessionId: typeof message?.sessionId === 'string' ? message.sessionId : null,
      status: 'blocked',
      artifactIdentity: typeof message?.request?.artifactIdentity === 'string'
        ? message.request.artifactIdentity : null,
      managed: null,
      identity: null,
      committed: null,
      pending: null,
      runtimeExecuteControlled: false,
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
