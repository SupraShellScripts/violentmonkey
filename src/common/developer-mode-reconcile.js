import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
  DEVELOPER_MODE_PROTOCOL_VERSION,
} from './developer-mode-transport';

export const CONTROLLED_RECONCILE_RESULT = 'runtime.reconcile-controlled.result';
export const WORKBENCH_FIREFOX_DEV_ID = 'violentmonkey-workbench-dev@suprashellscripts.github';
export const WORKBENCH_CHROMIUM_DEV_ID = 'mlooodbpjdohbedafmodnmelbmdgmngk';
export const MAX_CONTROLLED_ARTIFACT_BYTES = 512 * 1024;

const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const USER_SCRIPTS_ISSUE_RE = /^SupraShellScripts\/userscripts-private#[1-9][0-9]*$/;
const BROWSER_PARITY_ISSUE_RE = /^SemperSupra\/BrowserParity-private#[1-9][0-9]*$/;
const POSTCONDITION_KINDS = new Set(['dom-text', 'dom-attribute', 'custom-event']);
const QUALIFIED_STATES = new Set(['QUALIFIED', 'DETERMINISTIC']);
const RECONCILE_ENVELOPE_KEYS = [
  'schemaVersion', 'operation', 'sessionId', 'request', 'artifactCode',
];
const REQUEST_KEYS = [
  'schemaVersion', 'operation', 'correlationId', 'artifact', 'sourceAuthority',
  'qualification', 'target', 'profile', 'postcondition', 'adapter',
];
const ARTIFACT_KEYS = ['identity', 'version', 'path', 'sha256', 'declaredMatches'];
const SOURCE_KEYS = ['repository', 'commit', 'artifactSha256', 'issue'];
const QUALIFICATION_KEYS = ['repository', 'commit', 'issue', 'evidenceId', 'state'];
const TARGET_KEYS = ['requestedMatches'];
const PROFILE_KEYS = ['scope', 'ephemeral', 'identifier'];
const POSTCONDITION_KEYS = ['kind', 'selector', 'expected'];

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertClosedObject(value, allowedKeys, requiredKeys, label) {
  assertObject(value, label);
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !allowedKeys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported properties.`);
  const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new Error(`${label} is missing required properties.`);
  return value;
}

function assertString(value, label, pattern) {
  if (typeof value !== 'string' || !value || pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || !value.length
  || value.some(item => typeof item !== 'string' || !item)
  || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique non-empty strings.`);
  }
  return value;
}

function assertOptionalString(value, label, pattern) {
  if (value == null) return;
  assertString(value, label, pattern);
}

function assertSafeUserscriptPath(value) {
  assertString(value, 'Artifact path');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized)
  || normalized.split('/').includes('..') || !normalized.endsWith('.user.js')) {
    throw new Error('Artifact path must be a relative userscript path without traversal.');
  }
}

function equalStringSets(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(item => rightSet.has(item));
}

function validateControlledRuntimeRequest(request) {
  assertClosedObject(request, REQUEST_KEYS, REQUEST_KEYS, 'Controlled runtime request');
  if (request.schemaVersion !== 1 || request.operation !== CONTROLLED_RUNTIME_OPERATION) {
    throw new Error('Controlled runtime request protocol is incompatible.');
  }
  assertString(request.correlationId, 'Controlled runtime correlation ID');

  const artifact = assertClosedObject(
    request.artifact, ARTIFACT_KEYS, ARTIFACT_KEYS, 'Controlled runtime artifact');
  assertString(artifact.identity, 'Artifact identity');
  assertString(artifact.version, 'Artifact version');
  assertSafeUserscriptPath(artifact.path);
  assertString(artifact.sha256, 'Artifact SHA-256', HEX_64_RE);
  assertStringArray(artifact.declaredMatches, 'Artifact declared matches');

  const source = assertClosedObject(
    request.sourceAuthority, SOURCE_KEYS, SOURCE_KEYS.slice(0, 3), 'Source authority');
  if (source.repository !== 'SupraShellScripts/userscripts-private') {
    throw new Error('Source authority repository is not allowed.');
  }
  assertString(source.commit, 'Source authority commit', HEX_40_RE);
  assertString(source.artifactSha256, 'Source authority artifact SHA-256', HEX_64_RE);
  assertOptionalString(source.issue, 'Source authority issue', USER_SCRIPTS_ISSUE_RE);
  if (source.artifactSha256 !== artifact.sha256) {
    throw new Error('Source authority and artifact digests diverge.');
  }

  const qualification = assertClosedObject(
    request.qualification, QUALIFICATION_KEYS,
    ['repository', 'commit', 'state'], 'Qualification');
  if (qualification.repository !== 'SemperSupra/BrowserParity-private') {
    throw new Error('Qualification repository is not allowed.');
  }
  assertString(qualification.commit, 'Qualification commit', HEX_40_RE);
  assertOptionalString(qualification.issue, 'Qualification issue', BROWSER_PARITY_ISSUE_RE);
  assertOptionalString(qualification.evidenceId, 'Qualification evidence ID');
  if (!QUALIFIED_STATES.has(qualification.state)) {
    throw new Error('Qualification state is not trusted for controlled reconcile.');
  }

  const target = assertClosedObject(
    request.target, TARGET_KEYS, TARGET_KEYS, 'Controlled runtime target');
  assertStringArray(target.requestedMatches, 'Requested matches');
  const declaredSet = new Set(artifact.declaredMatches);
  if (target.requestedMatches.some(item => !declaredSet.has(item))) {
    throw new Error('Requested match scope exceeds the declared artifact scope.');
  }

  const profile = assertClosedObject(
    request.profile, PROFILE_KEYS, ['scope', 'ephemeral'], 'Controlled runtime profile');
  if (profile.scope !== 'development' || profile.ephemeral !== true) {
    throw new Error('Controlled reconcile requires an ephemeral development profile.');
  }
  if (Object.prototype.hasOwnProperty.call(profile, 'identifier')
  && profile.identifier !== null) {
    assertString(profile.identifier, 'Profile identifier');
  }

  const postcondition = assertClosedObject(
    request.postcondition, POSTCONDITION_KEYS, POSTCONDITION_KEYS, 'Postcondition');
  if (!POSTCONDITION_KINDS.has(postcondition.kind)) {
    throw new Error('Postcondition kind is unsupported.');
  }
  assertString(postcondition.selector, 'Postcondition selector');

  if (request.adapter !== 'violentmonkey') {
    throw new Error('Controlled reconcile requires the Violentmonkey adapter.');
  }
  return request;
}

export function isWorkbenchDevelopmentRuntimeId(runtimeId) {
  return runtimeId === WORKBENCH_FIREFOX_DEV_ID || runtimeId === WORKBENCH_CHROMIUM_DEV_ID;
}

export function validateControlledReconcileEnvelope(message, context) {
  assertClosedObject(
    message, RECONCILE_ENVELOPE_KEYS, RECONCILE_ENVELOPE_KEYS, 'Controlled reconcile envelope');
  if (message.schemaVersion !== DEVELOPER_MODE_PROTOCOL_VERSION
  || message.operation !== CONTROLLED_RECONCILE_OPERATION) {
    throw new Error('Controlled reconcile protocol is incompatible.');
  }
  const {
    sessionId, runtimeId, negotiatedCapabilities, developerModeEnabled, transportConnected,
  } = assertObject(context, 'Controlled reconcile context');
  if (developerModeEnabled !== true || transportConnected !== true) {
    throw new Error('Developer Mode transport is not active.');
  }
  assertString(sessionId, 'Active Developer Mode session ID', /^[0-9a-f]{32}$/);
  if (message.sessionId !== sessionId) {
    throw new Error('Controlled reconcile session does not match the active native session.');
  }
  if (!isWorkbenchDevelopmentRuntimeId(runtimeId)) {
    throw new Error('Controlled reconcile is restricted to a qualified Workbench development build.');
  }
  if (!Array.isArray(negotiatedCapabilities)
  || !negotiatedCapabilities.includes(CONTROLLED_RECONCILE_OPERATION)) {
    throw new Error('Controlled reconcile capability was not negotiated.');
  }
  if (typeof message.artifactCode !== 'string' || !message.artifactCode) {
    throw new Error('Controlled reconcile artifact code is missing.');
  }
  if (new TextEncoder().encode(message.artifactCode).byteLength > MAX_CONTROLLED_ARTIFACT_BYTES) {
    throw new Error('Controlled reconcile artifact exceeds the development size limit.');
  }
  validateControlledRuntimeRequest(message.request);
  return message;
}

export async function sha256TextHex(text, cryptoImpl = globalThis.crypto) {
  const subtle = cryptoImpl?.subtle;
  if (typeof subtle?.digest !== 'function') {
    throw new Error('Controlled reconcile requires WebCrypto SHA-256 support.');
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyControlledReconcileArtifact(message, cryptoImpl = globalThis.crypto) {
  const digest = await sha256TextHex(message.artifactCode, cryptoImpl);
  if (digest !== message.request.artifact.sha256
  || digest !== message.request.sourceAuthority.artifactSha256) {
    throw new Error('Controlled reconcile artifact bytes do not match the authorized SHA-256.');
  }
  return digest;
}

export function validateControlledUserscriptMetadata(meta, request) {
  assertObject(meta, 'Userscript metadata');
  assertString(meta.name, 'Userscript name');
  if (meta.version !== request.artifact.version) {
    throw new Error('Userscript metadata version does not match the authorized artifact version.');
  }
  if (Array.isArray(meta.require) && meta.require.length
  || meta.resources && Object.keys(meta.resources).length
  || meta.icon && !String(meta.icon).startsWith('data:')) {
    throw new Error('Controlled reconcile does not allow external dependency acquisition.');
  }
  const matches = [...(meta.match || []), ...(meta.include || [])];
  if (!matches.length || matches.some(item => typeof item !== 'string' || !item)
  || new Set(matches).size !== matches.length) {
    throw new Error('Userscript declared match metadata must contain unique non-empty entries.');
  }
  if (!equalStringSets(matches, request.artifact.declaredMatches)) {
    throw new Error('Userscript metadata match scope differs from the authorized artifact scope.');
  }
  return meta;
}

export function createControlledReconcileResult({
  message, status, scriptId = null, error = null,
}) {
  if (!['reconciled', 'blocked', 'error'].includes(status)) {
    throw new Error('Controlled reconcile result status is invalid.');
  }
  if (status === 'reconciled' && (!Number.isInteger(scriptId) || scriptId <= 0)) {
    throw new Error('Successful controlled reconcile requires a positive script ID.');
  }
  return {
    schemaVersion: DEVELOPER_MODE_PROTOCOL_VERSION,
    operation: CONTROLLED_RECONCILE_RESULT,
    correlationId: message.request.correlationId,
    sessionId: message.sessionId,
    status,
    artifact: {
      identity: message.request.artifact.identity,
      version: message.request.artifact.version,
      sha256: message.request.artifact.sha256,
    },
    scriptId,
    browserExecution: false,
    postconditionObserved: false,
    error,
  };
}
