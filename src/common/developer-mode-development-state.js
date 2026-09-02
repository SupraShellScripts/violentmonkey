import {
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPER_MODE_PROTOCOL_VERSION,
  DEVELOPMENT_STATE_OPERATION,
} from './developer-mode-transport';
import {
  isWorkbenchDevelopmentRuntimeId,
  MAX_CONTROLLED_ARTIFACT_BYTES,
  validateControlledRuntimeRequest,
  verifyControlledReconcileArtifact,
} from './developer-mode-reconcile';

export const DEVELOPMENT_STATE_RESULT = 'runtime.reconcile-development-state.result';
export const DEVELOPMENT_STATES = Object.freeze([
  'present-enabled',
  'present-disabled',
  'absent',
]);

const ENVELOPE_KEYS = [
  'schemaVersion', 'operation', 'sessionId', 'request', 'artifactCode',
];
const REQUEST_KEYS = [
  'schemaVersion', 'operation', 'correlationId', 'artifact', 'sourceAuthority',
  'qualification', 'target', 'profile', 'postcondition', 'adapter',
  'desiredState', 'expectedManagedRevision',
];

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

function assertNullableRevision(value, label) {
  if (value == null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be null or a non-negative integer.`);
  }
  return value;
}

function controlledCompatibilityRequest(request) {
  return {
    schemaVersion: request.schemaVersion,
    operation: CONTROLLED_RUNTIME_OPERATION,
    correlationId: request.correlationId,
    artifact: request.artifact,
    sourceAuthority: request.sourceAuthority,
    qualification: request.qualification,
    target: request.target,
    profile: request.profile,
    postcondition: request.postcondition,
    adapter: request.adapter,
  };
}

export function validateDevelopmentStateEnvelope(message, context) {
  assertClosedObject(message, ENVELOPE_KEYS, ENVELOPE_KEYS, 'Development-state envelope');
  if (message.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || message.operation !== DEVELOPMENT_STATE_OPERATION) {
    throw new Error('Development-state protocol is incompatible.');
  }

  const {
    sessionId, runtimeId, negotiatedCapabilities, developerModeEnabled, transportConnected,
  } = assertObject(context, 'Development-state context');
  if (developerModeEnabled !== true || transportConnected !== true) {
    throw new Error('Developer Mode transport is not active.');
  }
  assertString(sessionId, 'Active Developer Mode session ID', /^[0-9a-f]{32}$/);
  if (message.sessionId !== sessionId) {
    throw new Error('Development-state session does not match the active native session.');
  }
  if (!isWorkbenchDevelopmentRuntimeId(runtimeId)) {
    throw new Error('Development-state reconcile is restricted to a qualified Workbench development build.');
  }
  if (!Array.isArray(negotiatedCapabilities)
  || !negotiatedCapabilities.includes(DEVELOPMENT_STATE_OPERATION)
  || negotiatedCapabilities.includes('runtime.reconcile-controlled')) {
    throw new Error('Development-state capability was not exclusively negotiated.');
  }

  const request = assertClosedObject(
    message.request, REQUEST_KEYS, REQUEST_KEYS, 'Development-state request');
  if (request.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || request.operation !== DEVELOPMENT_STATE_OPERATION) {
    throw new Error('Development-state request protocol is incompatible.');
  }
  assertString(request.correlationId, 'Development-state correlation ID');
  if (!DEVELOPMENT_STATES.includes(request.desiredState)) {
    throw new Error('Development-state desiredState is unsupported.');
  }
  assertNullableRevision(request.expectedManagedRevision, 'expectedManagedRevision');

  if (typeof message.artifactCode !== 'string' || !message.artifactCode) {
    throw new Error('Development-state artifact code is missing.');
  }
  if (new TextEncoder().encode(message.artifactCode).byteLength > MAX_CONTROLLED_ARTIFACT_BYTES) {
    throw new Error('Development-state artifact exceeds the development size limit.');
  }

  // Lifecycle adds intent/revision but deliberately reuses the qualified
  // governed request policy for source, qualification, profile, adapter,
  // artifact identity/digest, and match scope.
  validateControlledRuntimeRequest(controlledCompatibilityRequest(request));
  return message;
}

export function verifyDevelopmentStateArtifact(message, cryptoImpl = globalThis.crypto) {
  return verifyControlledReconcileArtifact(message, cryptoImpl);
}

export function createDevelopmentStateResult({
  message, status, managedRevision = null, scriptId = null, error = null,
}) {
  if (!['converged', 'blocked', 'error'].includes(status)) {
    throw new Error('Development-state result status is invalid.');
  }
  assertNullableRevision(managedRevision, 'managedRevision');
  const desiredState = message.request.desiredState;
  if (!DEVELOPMENT_STATES.includes(desiredState)) {
    throw new Error('Development-state result desiredState is invalid.');
  }

  if (status === 'converged') {
    if (managedRevision == null) {
      throw new Error('Converged development-state result requires managedRevision.');
    }
    if (desiredState === 'absent') {
      if (scriptId !== null) throw new Error('Converged absent state requires scriptId=null.');
    } else if (!Number.isSafeInteger(scriptId) || scriptId <= 0) {
      throw new Error('Converged present state requires a positive script ID.');
    }
    if (error !== null) throw new Error('Converged development-state result requires error=null.');
  } else {
    if (scriptId !== null) throw new Error('Blocked/failed development-state result requires scriptId=null.');
    const expectedError = status === 'blocked' ? 'request-blocked' : 'reconcile-failed';
    if (error !== expectedError) {
      throw new Error(`Development-state ${status} result requires error=${expectedError}.`);
    }
  }

  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: DEVELOPMENT_STATE_RESULT,
    correlationId: message.request.correlationId,
    sessionId: message.sessionId,
    status,
    artifact: {
      identity: message.request.artifact.identity,
      version: message.request.artifact.version,
      sha256: message.request.artifact.sha256,
    },
    desiredState,
    managedRevision,
    scriptId,
    browserExecution: false,
    postconditionObserved: false,
    error,
  };
}
