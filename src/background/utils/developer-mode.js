import browser from '@/common/browser';
import { createDeveloperModeStatus } from '@/common/developer-mode';
import {
  createHandshakeRequest,
  DEVELOPER_MODE_HOST,
  validateHandshakeResponse,
} from '@/common/developer-mode-transport';
import { kDeveloperMode } from '@/common/options-defaults';
import { addOwnCommands } from './init';
import { getOption } from './options';

const HANDSHAKE_TIMEOUT = 5000;
let port;
let negotiatedCapabilities = [];
let transport = disconnectedTransport();

addOwnCommands({
  ConnectDeveloperMode: connect,
  DisconnectDeveloperMode: disconnect,
  GetDeveloperModeStatus: getStatus,
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

async function connect() {
  if (getOption(kDeveloperMode) !== true) {
    throw new Error('Developer Mode must be explicitly enabled before connecting.');
  }
  if (transport.connected) return getStatus();
  disconnect();
  const manifest = browser.runtime.getManifest();
  try {
    port = browser.runtime.connectNative(DEVELOPER_MODE_HOST);
    const handshake = await waitForHandshake(
      port, createHandshakeRequest(manifest.version));
    negotiatedCapabilities = handshake.capabilities;
    transport = {
      kind: 'native-messaging',
      connected: true,
      host: DEVELOPER_MODE_HOST,
      hostVersion: handshake.host.version,
      sessionId: handshake.sessionId,
      error: null,
    };
    port.onDisconnect.addListener(onDisconnect);
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

function onDisconnect() {
  const error = browser.runtime.lastError?.message || 'Native host disconnected.';
  port = null;
  negotiatedCapabilities = [];
  transport = disconnectedTransport(error);
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
