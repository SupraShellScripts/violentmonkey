import { DEVELOPMENT_STATES } from './developer-mode-development-state';
import {
  ManagedArtifactOwnershipError,
  readManagedArtifactStorageLedger,
  validateManagedArtifactOwnershipLedgerV1,
  WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY,
  writeManagedArtifactStorageLedger,
} from './developer-mode-managed-artifacts';

export const WORKBENCH_MANAGED_STATE_SCHEMA_VERSION = 2;
export const WORKBENCH_MANAGED_STATE_MODE = 'lifecycle-v1';

const HEX_64_RE = /^[0-9a-f]{64}$/;
const LEDGER_KEYS = ['schemaVersion', 'mode', 'entries'];
const ENTRY_KEYS = ['artifactIdentity', 'name', 'namespace', 'committed', 'pending'];
const COMMITTED_KEYS = ['artifactSha256', 'scriptId', 'desiredState', 'managedRevision'];
const PENDING_KEYS = ['artifactSha256', 'desiredState', 'fromRevision', 'targetRevision'];

export class ManagedArtifactLifecycleError extends ManagedArtifactOwnershipError {}

function lifecycleError(message) {
  return new ManagedArtifactLifecycleError(message);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw lifecycleError(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw lifecycleError(`${label} has an invalid shape.`);
  }
  return value;
}

function assertString(value, label, pattern) {
  if (typeof value !== 'string' || !value || pattern && !pattern.test(value)) {
    throw lifecycleError(`${label} is invalid.`);
  }
  return value;
}

function assertRevision(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw lifecycleError(`${label} must be ${nullable ? 'null or ' : ''}a non-negative integer.`);
  }
  return value;
}

function assertScriptId(value, desiredState, label) {
  if (desiredState === 'absent') {
    if (value !== null) throw lifecycleError(`${label} must be null for absent state.`);
  } else if (!Number.isSafeInteger(value) || value < 1) {
    throw lifecycleError(`${label} must be a positive integer for present state.`);
  }
}

function cloneCommitted(committed) {
  return committed && { ...committed };
}

function clonePending(pending) {
  return pending && { ...pending };
}

function cloneEntry(entry) {
  return {
    artifactIdentity: entry.artifactIdentity,
    name: entry.name,
    namespace: entry.namespace,
    committed: cloneCommitted(entry.committed),
    pending: clonePending(entry.pending),
  };
}

function cloneLedger(ledger) {
  return {
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: ledger.entries.map(cloneEntry),
  };
}

function validateIdentity(identity) {
  assertExactKeys(identity, ['name', 'namespace'], 'Managed lifecycle userscript identity');
  assertString(identity.name, 'Managed lifecycle userscript name');
  if (typeof identity.namespace !== 'string') {
    throw lifecycleError('Managed lifecycle userscript namespace is invalid.');
  }
  return identity;
}

function validateCommitted(committed) {
  assertExactKeys(committed, COMMITTED_KEYS, 'Managed lifecycle committed state');
  assertString(committed.artifactSha256, 'Committed artifact SHA-256', HEX_64_RE);
  if (!DEVELOPMENT_STATES.includes(committed.desiredState)) {
    throw lifecycleError('Committed desired state is invalid.');
  }
  assertRevision(committed.managedRevision, 'Committed managed revision');
  assertScriptId(committed.scriptId, committed.desiredState, 'Committed script ID');
  return committed;
}

function isRevisionNeutralRepair(pending, committed) {
  return pending.desiredState === committed.desiredState
    && pending.artifactSha256 === committed.artifactSha256
    && pending.fromRevision === committed.managedRevision
    && pending.targetRevision === committed.managedRevision;
}

function validatePending(pending, committed) {
  assertExactKeys(pending, PENDING_KEYS, 'Managed lifecycle pending transition');
  assertString(pending.artifactSha256, 'Pending artifact SHA-256', HEX_64_RE);
  if (!DEVELOPMENT_STATES.includes(pending.desiredState)) {
    throw lifecycleError('Pending desired state is invalid.');
  }
  assertRevision(pending.fromRevision, 'Pending from revision', { nullable: true });
  assertRevision(pending.targetRevision, 'Pending target revision');

  if (committed) {
    const isTransition = pending.fromRevision === committed.managedRevision
      && pending.targetRevision === committed.managedRevision + 1;
    if (!isTransition && !isRevisionNeutralRepair(pending, committed)) {
      throw lifecycleError('Pending revision boundary does not follow committed state.');
    }
    if (pending.desiredState === 'absent'
    && pending.artifactSha256 !== committed.artifactSha256) {
      throw lifecycleError('Pending absent transition cannot change the authorized artifact digest.');
    }
  } else {
    if (pending.fromRevision !== null || pending.targetRevision !== 0) {
      throw lifecycleError('Initial pending transition must target managed revision 0.');
    }
    if (pending.desiredState === 'absent') {
      throw lifecycleError('Initial managed lifecycle transition cannot be absent.');
    }
  }
  return pending;
}

function validateEntry(entry) {
  assertExactKeys(entry, ENTRY_KEYS, 'Managed lifecycle ledger entry');
  assertString(entry.artifactIdentity, 'Managed lifecycle artifact identity');
  assertString(entry.name, 'Managed lifecycle userscript name');
  if (typeof entry.namespace !== 'string') {
    throw lifecycleError('Managed lifecycle userscript namespace is invalid.');
  }
  if (entry.committed === null && entry.pending === null) {
    throw lifecycleError('Managed lifecycle entry must contain committed or pending state.');
  }
  if (entry.committed !== null) validateCommitted(entry.committed);
  if (entry.pending !== null) validatePending(entry.pending, entry.committed);
  return entry;
}

export function validateManagedDevelopmentLifecycleLedger(value) {
  assertExactKeys(value, LEDGER_KEYS, 'Managed lifecycle ledger');
  if (value.schemaVersion !== WORKBENCH_MANAGED_STATE_SCHEMA_VERSION
  || value.mode !== WORKBENCH_MANAGED_STATE_MODE
  || !Array.isArray(value.entries)) {
    throw lifecycleError('Managed lifecycle ledger version, mode, or entries are invalid.');
  }
  const seen = new Set();
  value.entries.forEach(entry => {
    validateEntry(entry);
    if (seen.has(entry.artifactIdentity)) {
      throw lifecycleError('Managed lifecycle ledger contains duplicate artifact identities.');
    }
    seen.add(entry.artifactIdentity);
  });
  return cloneLedger(value);
}

function emptyLifecycleLedger() {
  return {
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: [],
  };
}

function validateStorageApi(storageApi) {
  if (!storageApi?.get || !storageApi?.set) {
    throw new Error('Managed lifecycle storage adapter is unavailable.');
  }
}

async function readRawLedger(storageApi) {
  validateStorageApi(storageApi);
  return readManagedArtifactStorageLedger(storageApi);
}

export async function readManagedDevelopmentLifecycleLedger(storageApi) {
  const value = await readRawLedger(storageApi);
  if (value == null || value.schemaVersion !== WORKBENCH_MANAGED_STATE_SCHEMA_VERSION) {
    throw lifecycleError('Managed lifecycle mode is not active for this browser profile.');
  }
  return validateManagedDevelopmentLifecycleLedger(value);
}

export async function persistManagedDevelopmentLifecycleLedger(storageApi, ledger) {
  validateStorageApi(storageApi);
  const validated = validateManagedDevelopmentLifecycleLedger(ledger);
  await writeManagedArtifactStorageLedger(storageApi, validated);
  return validated;
}

function sameScriptIdentity(script, entry) {
  return script?.meta?.name === entry.name
    && (script.meta.namespace || '') === entry.namespace;
}

function observedInitialDesiredState(script) {
  if (script?.config?.removed) {
    throw lifecycleError('Removed v1 managed artifact must be repaired before lifecycle activation.');
  }
  if (script?.config?.enabled === 1 || script?.config?.enabled === true) {
    return 'present-enabled';
  }
  if (script?.config?.enabled === 0 || script?.config?.enabled === false) {
    return 'present-disabled';
  }
  throw lifecycleError('Managed artifact enabled state is unavailable for lifecycle migration.');
}

export async function activateManagedDevelopmentLifecycle({ storageApi, commandApi }) {
  validateStorageApi(storageApi);
  if (!commandApi?.GetScript) {
    throw new Error('Managed lifecycle command adapter is unavailable.');
  }

  const raw = await readRawLedger(storageApi);
  if (raw?.schemaVersion === WORKBENCH_MANAGED_STATE_SCHEMA_VERSION) {
    return validateManagedDevelopmentLifecycleLedger(raw);
  }

  const v1 = validateManagedArtifactOwnershipLedgerV1(raw);
  if (v1.entries.some(entry => entry.state === 'installing')) {
    throw lifecycleError('Pending v1 ownership installation must be recovered before lifecycle activation.');
  }

  const entries = [];
  for (const entry of v1.entries) {
    const script = await commandApi.GetScript({ id: entry.scriptId });
    if (!script || script?.props?.id !== entry.scriptId || !sameScriptIdentity(script, entry)) {
      throw lifecycleError('V1 managed ownership must resolve to its original userscript before migration.');
    }
    entries.push({
      artifactIdentity: entry.artifactIdentity,
      name: entry.name,
      namespace: entry.namespace,
      committed: {
        artifactSha256: entry.artifactSha256,
        scriptId: entry.scriptId,
        desiredState: observedInitialDesiredState(script),
        managedRevision: 0,
      },
      pending: null,
    });
  }

  const lifecycle = validateManagedDevelopmentLifecycleLedger({
    ...emptyLifecycleLedger(),
    entries,
  });
  await writeManagedArtifactStorageLedger(storageApi, lifecycle);
  return lifecycle;
}

function requestTransitionFields(request) {
  const artifactIdentity = request?.artifact?.identity;
  const artifactSha256 = request?.artifact?.sha256;
  const desiredState = request?.desiredState;
  const expectedManagedRevision = request?.expectedManagedRevision;
  assertString(artifactIdentity, 'Lifecycle request artifact identity');
  assertString(artifactSha256, 'Lifecycle request artifact SHA-256', HEX_64_RE);
  if (!DEVELOPMENT_STATES.includes(desiredState)) {
    throw lifecycleError('Lifecycle request desired state is invalid.');
  }
  assertRevision(expectedManagedRevision, 'Expected managed revision', { nullable: true });
  return { artifactIdentity, artifactSha256, desiredState, expectedManagedRevision };
}

function replaceEntry(ledger, entry) {
  return {
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: [
      ...ledger.entries.filter(item => item.artifactIdentity !== entry.artifactIdentity),
      cloneEntry(entry),
    ],
  };
}

function sameEntryIdentity(entry, artifactIdentity, identity) {
  return entry.artifactIdentity === artifactIdentity
    && entry.name === identity.name
    && entry.namespace === identity.namespace;
}

function sameTarget(pending, desiredState, artifactSha256) {
  return pending.desiredState === desiredState
    && pending.artifactSha256 === artifactSha256;
}

export function planManagedDevelopmentTransition({ ledger, request, identity }) {
  const validated = validateManagedDevelopmentLifecycleLedger(ledger);
  validateIdentity(identity);
  const {
    artifactIdentity, artifactSha256, desiredState, expectedManagedRevision,
  } = requestTransitionFields(request);
  const entry = validated.entries.find(item => item.artifactIdentity === artifactIdentity);

  if (!entry) {
    if (desiredState === 'absent') {
      throw lifecycleError('Cannot establish managed ownership with an absent transition.');
    }
    if (expectedManagedRevision !== null) {
      throw lifecycleError('Initial managed transition requires expectedManagedRevision=null.');
    }
    const pending = {
      artifactSha256,
      desiredState,
      fromRevision: null,
      targetRevision: 0,
    };
    const nextEntry = {
      artifactIdentity,
      name: identity.name,
      namespace: identity.namespace,
      committed: null,
      pending,
    };
    const nextLedger = validateManagedDevelopmentLifecycleLedger(
      replaceEntry(validated, nextEntry));
    return { kind: 'begin', entry: cloneEntry(nextEntry), ledger: nextLedger };
  }

  if (!sameEntryIdentity(entry, artifactIdentity, identity)) {
    throw lifecycleError('Managed lifecycle artifact identity was repurposed.');
  }

  if (entry.pending) {
    const repair = entry.committed && isRevisionNeutralRepair(entry.pending, entry.committed);
    if (!sameTarget(entry.pending, desiredState, artifactSha256)
    || !repair && entry.pending.fromRevision !== expectedManagedRevision) {
      throw lifecycleError('A different managed lifecycle transition is already pending.');
    }
    return { kind: 'recover', entry: cloneEntry(entry), ledger: validated };
  }

  const committed = entry.committed;
  if (committed.desiredState === desiredState
  && committed.artifactSha256 === artifactSha256) {
    return { kind: 'replay', entry: cloneEntry(entry), ledger: validated };
  }

  if (expectedManagedRevision !== committed.managedRevision) {
    throw lifecycleError('Managed lifecycle revision precondition failed.');
  }
  if (desiredState === 'absent' && artifactSha256 !== committed.artifactSha256) {
    throw lifecycleError('Absent transition must use the currently committed artifact digest.');
  }

  const pending = {
    artifactSha256,
    desiredState,
    fromRevision: committed.managedRevision,
    targetRevision: committed.managedRevision + 1,
  };
  const nextEntry = { ...entry, pending };
  const nextLedger = validateManagedDevelopmentLifecycleLedger(
    replaceEntry(validated, nextEntry));
  return { kind: 'begin', entry: cloneEntry(nextEntry), ledger: nextLedger };
}

export function planManagedDevelopmentPhysicalRepair({ ledger, request, identity }) {
  const validated = validateManagedDevelopmentLifecycleLedger(ledger);
  validateIdentity(identity);
  const {
    artifactIdentity, artifactSha256, desiredState,
  } = requestTransitionFields(request);
  if (desiredState === 'absent') {
    throw lifecycleError('Absent managed state does not require ownership recreation.');
  }
  const entry = validated.entries.find(item => item.artifactIdentity === artifactIdentity);
  if (!entry || !sameEntryIdentity(entry, artifactIdentity, identity)
  || !entry.committed || entry.pending
  || entry.committed.desiredState !== desiredState
  || entry.committed.artifactSha256 !== artifactSha256) {
    throw lifecycleError('Managed lifecycle physical repair requires exact committed intent.');
  }
  const pending = {
    artifactSha256,
    desiredState,
    fromRevision: entry.committed.managedRevision,
    targetRevision: entry.committed.managedRevision,
  };
  const nextEntry = { ...entry, pending };
  const nextLedger = validateManagedDevelopmentLifecycleLedger(
    replaceEntry(validated, nextEntry));
  return { kind: 'repair', entry: cloneEntry(nextEntry), ledger: nextLedger };
}

export function finalizeManagedDevelopmentTransition({
  ledger, artifactIdentity, desiredState, artifactSha256, scriptId,
}) {
  const validated = validateManagedDevelopmentLifecycleLedger(ledger);
  assertString(artifactIdentity, 'Managed lifecycle artifact identity');
  assertString(artifactSha256, 'Managed lifecycle artifact SHA-256', HEX_64_RE);
  if (!DEVELOPMENT_STATES.includes(desiredState)) {
    throw lifecycleError('Managed lifecycle desired state is invalid.');
  }
  assertScriptId(scriptId, desiredState, 'Managed lifecycle script ID');

  const entry = validated.entries.find(item => item.artifactIdentity === artifactIdentity);
  if (!entry) throw lifecycleError('Managed lifecycle entry is missing during finalization.');

  if (!entry.pending) {
    const committed = entry.committed;
    if (committed
    && committed.desiredState === desiredState
    && committed.artifactSha256 === artifactSha256
    && committed.scriptId === scriptId) {
      return validated;
    }
    throw lifecycleError('Managed lifecycle transition is not pending.');
  }
  if (!sameTarget(entry.pending, desiredState, artifactSha256)) {
    throw lifecycleError('Managed lifecycle finalization does not match the pending transition.');
  }

  const committed = {
    artifactSha256,
    scriptId,
    desiredState,
    managedRevision: entry.pending.targetRevision,
  };
  const nextEntry = { ...entry, committed, pending: null };
  return validateManagedDevelopmentLifecycleLedger(replaceEntry(validated, nextEntry));
}
