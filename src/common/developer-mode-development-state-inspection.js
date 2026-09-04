import {
  DEVELOPER_MODE_PROTOCOL_VERSION,
  INSPECT_DEVELOPMENT_STATE_OPERATION,
} from './developer-mode-transport';
import { isWorkbenchDevelopmentRuntimeId } from './developer-mode-reconcile';

export const INSPECT_DEVELOPMENT_STATE_RESULT = 'runtime.inspect-development-state.result';

const ENVELOPE_KEYS = ['schemaVersion', 'operation', 'sessionId', 'request'];
const REQUEST_KEYS = ['schemaVersion', 'operation', 'correlationId', 'artifactIdentity'];

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertClosedObject(value, allowedKeys, requiredKeys, label) {
  assertObject(value, label);
  const keys = Object.keys(value);
  if (keys.some(key => !allowedKeys.includes(key))) {
    throw new Error(`${label} contains unsupported properties.`);
  }
  if (requiredKeys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error(`${label} is missing required properties.`);
  }
  return value;
}

function assertString(value, label, pattern) {
  if (typeof value !== 'string' || !value || pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function cloneCommitted(committed) {
  return committed && {
    artifactSha256: committed.artifactSha256,
    scriptId: committed.scriptId,
    desiredState: committed.desiredState,
    managedRevision: committed.managedRevision,
  };
}

function clonePending(pending) {
  return pending && {
    artifactSha256: pending.artifactSha256,
    desiredState: pending.desiredState,
    fromRevision: pending.fromRevision,
    targetRevision: pending.targetRevision,
  };
}

export function validateDevelopmentStateInspectionEnvelope(message, context) {
  assertClosedObject(
    message, ENVELOPE_KEYS, ENVELOPE_KEYS, 'Development-state inspection envelope');
  if (message.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || message.operation !== INSPECT_DEVELOPMENT_STATE_OPERATION) {
    throw new Error('Development-state inspection protocol is incompatible.');
  }

  const {
    sessionId, runtimeId, negotiatedCapabilities, developerModeEnabled, transportConnected,
  } = assertObject(context, 'Development-state inspection context');
  if (developerModeEnabled !== true || transportConnected !== true) {
    throw new Error('Developer Mode transport is not active.');
  }
  assertString(sessionId, 'Active Developer Mode session ID', /^[0-9a-f]{32}$/);
  if (message.sessionId !== sessionId) {
    throw new Error('Development-state inspection session does not match the active native session.');
  }
  if (!isWorkbenchDevelopmentRuntimeId(runtimeId)) {
    throw new Error('Development-state inspection is restricted to a qualified Workbench development build.');
  }
  if (!Array.isArray(negotiatedCapabilities)
  || !negotiatedCapabilities.includes(INSPECT_DEVELOPMENT_STATE_OPERATION)) {
    throw new Error('Development-state inspection capability was not negotiated.');
  }

  const request = assertClosedObject(
    message.request, REQUEST_KEYS, REQUEST_KEYS, 'Development-state inspection request');
  if (request.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || request.operation !== INSPECT_DEVELOPMENT_STATE_OPERATION) {
    throw new Error('Development-state inspection request protocol is incompatible.');
  }
  assertString(request.correlationId, 'Development-state inspection correlation ID');
  assertString(request.artifactIdentity, 'Development-state inspection artifact identity');
  if (request.artifactIdentity.length > 256) {
    throw new Error('Development-state inspection artifact identity is too long.');
  }
  return message;
}

export function createDevelopmentStateInspectionResult({
  message, status, entry = null, error = null,
}) {
  if (!['observed', 'blocked', 'error'].includes(status)) {
    throw new Error('Development-state inspection result status is invalid.');
  }

  let managed = null;
  let identity = null;
  let committed = null;
  let pending = null;

  if (status === 'observed') {
    if (error !== null) {
      throw new Error('Observed development-state inspection requires error=null.');
    }
    managed = entry !== null;
    if (entry !== null) {
      assertObject(entry, 'Managed lifecycle inspection entry');
      if (entry.artifactIdentity !== message.request.artifactIdentity) {
        throw new Error('Managed lifecycle inspection entry identity does not match the request.');
      }
      if (typeof entry.name !== 'string' || typeof entry.namespace !== 'string') {
        throw new Error('Managed lifecycle inspection userscript identity is invalid.');
      }
      identity = { name: entry.name, namespace: entry.namespace };
      committed = cloneCommitted(entry.committed);
      pending = clonePending(entry.pending);
    }
  } else {
    if (entry !== null) {
      throw new Error('Blocked/failed development-state inspection cannot return managed state.');
    }
    const expectedError = status === 'blocked' ? 'request-blocked' : 'inspection-failed';
    if (error !== expectedError) {
      throw new Error(`Development-state inspection ${status} result requires error=${expectedError}.`);
    }
  }

  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: INSPECT_DEVELOPMENT_STATE_RESULT,
    correlationId: message.request.correlationId,
    sessionId: message.sessionId,
    status,
    artifactIdentity: message.request.artifactIdentity,
    managed,
    identity,
    committed,
    pending,
    runtimeExecuteControlled: false,
    browserExecution: false,
    postconditionObserved: false,
    error,
  };
}
