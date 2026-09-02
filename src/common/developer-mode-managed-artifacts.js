import { sha256TextHex } from './developer-mode-reconcile';

export const WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY = 'vmwb:managed-artifacts:v1';
export const WORKBENCH_MANAGED_ARTIFACTS_SCHEMA_VERSION = 1;

const HEX_64_RE = /^[0-9a-f]{64}$/;
const ENTRY_KEYS = [
  'state', 'artifactIdentity', 'name', 'namespace', 'artifactSha256', 'scriptId',
];

export class ManagedArtifactOwnershipError extends Error {}

function ownershipError(message) {
  return new ManagedArtifactOwnershipError(message);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw ownershipError(`${label} must be an object.`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw ownershipError(`${label} has an invalid shape.`);
  }
}

function scriptIdentityFromMeta(meta) {
  const name = meta?.name;
  const namespace = meta?.namespace || '';
  if (typeof name !== 'string' || !name) {
    throw ownershipError('Managed artifact userscript name is invalid.');
  }
  if (typeof namespace !== 'string') {
    throw ownershipError('Managed artifact userscript namespace is invalid.');
  }
  return { name, namespace };
}

function sameScriptIdentity(script, identity) {
  return script?.meta?.name === identity.name
    && (script.meta.namespace || '') === identity.namespace;
}

function validateEntry(entry) {
  assertExactKeys(entry, ENTRY_KEYS, 'Managed artifact ledger entry');
  if (!['installing', 'managed'].includes(entry.state)
  || typeof entry.artifactIdentity !== 'string' || !entry.artifactIdentity
  || typeof entry.name !== 'string' || !entry.name
  || typeof entry.namespace !== 'string'
  || typeof entry.artifactSha256 !== 'string' || !HEX_64_RE.test(entry.artifactSha256)) {
    throw ownershipError('Managed artifact ledger entry is invalid.');
  }
  if (entry.state === 'installing' && entry.scriptId !== null) {
    throw ownershipError('Installing managed artifact entry must have scriptId=null.');
  }
  if (entry.state === 'managed'
  && (!Number.isInteger(entry.scriptId) || entry.scriptId < 1)) {
    throw ownershipError('Managed artifact entry must have a positive script ID.');
  }
  return entry;
}

function emptyLedger() {
  return { schemaVersion: WORKBENCH_MANAGED_ARTIFACTS_SCHEMA_VERSION, entries: [] };
}

function validateLedger(value) {
  if (value == null) return emptyLedger();
  assertExactKeys(value, ['schemaVersion', 'entries'], 'Managed artifact ledger');
  if (value.schemaVersion !== WORKBENCH_MANAGED_ARTIFACTS_SCHEMA_VERSION
  || !Array.isArray(value.entries)) {
    throw ownershipError('Managed artifact ledger version or entries are invalid.');
  }
  const seen = new Set();
  value.entries.forEach(entry => {
    validateEntry(entry);
    if (seen.has(entry.artifactIdentity)) {
      throw ownershipError('Managed artifact ledger contains duplicate artifact identities.');
    }
    seen.add(entry.artifactIdentity);
  });
  return {
    schemaVersion: WORKBENCH_MANAGED_ARTIFACTS_SCHEMA_VERSION,
    entries: value.entries.map(entry => ({ ...entry })),
  };
}

async function readLedger(storageApi) {
  const stored = await storageApi.get([WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]);
  return validateLedger(stored?.[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]);
}

async function writeLedger(storageApi, ledger) {
  await storageApi.set({ [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: ledger });
}

function replaceEntry(ledger, entry) {
  const entries = ledger.entries.filter(item => item.artifactIdentity !== entry.artifactIdentity);
  entries.push(entry);
  return { schemaVersion: WORKBENCH_MANAGED_ARTIFACTS_SCHEMA_VERSION, entries };
}

function makeEntry(state, request, identity, scriptId = null, digest = request.artifact.sha256) {
  return {
    state,
    artifactIdentity: request.artifact.identity,
    name: identity.name,
    namespace: identity.namespace,
    artifactSha256: digest,
    scriptId,
  };
}

async function findIdentityCollisions(commandApi, meta) {
  const [alive, removed] = await Promise.all([
    commandApi.GetScript({ meta }),
    commandApi.GetScript({ meta, removed: true }),
  ]);
  const byId = new Map();
  [alive, removed].filter(Boolean).forEach(script => {
    const id = script?.props?.id;
    if (!Number.isInteger(id) || id < 1) {
      throw ownershipError('Managed artifact identity collision has an invalid script ID.');
    }
    byId.set(id, script);
  });
  return [...byId.values()];
}

function assertEntryIdentity(entry, request, identity) {
  if (entry.artifactIdentity !== request.artifact.identity
  || entry.name !== identity.name
  || entry.namespace !== identity.namespace) {
    throw ownershipError('Managed artifact identity was repurposed.');
  }
}

async function persistInstalling(storageApi, ledger, request, identity) {
  const entry = makeEntry('installing', request, identity);
  const next = replaceEntry(ledger, entry);
  await writeLedger(storageApi, next);
  return { ledger: next, entry };
}

async function persistManaged(storageApi, ledger, request, identity, scriptId, digest) {
  const entry = makeEntry('managed', request, identity, scriptId, digest);
  const next = replaceEntry(ledger, entry);
  await writeLedger(storageApi, next);
  return { ledger: next, entry };
}

function parseSource(message, meta, scriptId) {
  return {
    ...scriptId && { id: scriptId },
    code: message.artifactCode,
    meta,
    errors: null,
    message: '',
    bumpDate: false,
  };
}

async function installAndOwn({
  message, meta, identity, ledger, storageApi, commandApi,
}) {
  ({ ledger } = await persistInstalling(storageApi, ledger, message.request, identity));
  const reconciled = await commandApi.ParseScript(parseSource(message, meta));
  const scriptId = reconciled?.where?.id;
  if (!Number.isInteger(scriptId) || scriptId < 1) {
    throw new Error('Controlled reconcile mutation returned an invalid script ID.');
  }
  await persistManaged(
    storageApi, ledger, message.request, identity, scriptId, message.request.artifact.sha256);
  return reconciled;
}

async function recoverInstalling({
  message, meta, identity, ledger, entry, storageApi, commandApi, hashText,
}) {
  assertEntryIdentity(entry, message.request, identity);
  const collisions = await findIdentityCollisions(commandApi, meta);
  if (collisions.length > 1) {
    throw ownershipError('Pending managed artifact recovery found ambiguous script identity collisions.');
  }
  if (!collisions.length) {
    return installAndOwn({ message, meta, identity, ledger, storageApi, commandApi });
  }
  const candidate = collisions[0];
  if (!sameScriptIdentity(candidate, identity)) {
    throw ownershipError('Pending managed artifact recovery found a repurposed script identity.');
  }
  const code = await commandApi.GetScriptCode(candidate.props.id);
  if (typeof code !== 'string' || await hashText(code) !== entry.artifactSha256) {
    throw ownershipError('Pending managed artifact recovery refused an unowned identity collision.');
  }
  ({ ledger } = await persistManaged(
    storageApi, ledger, message.request, identity, candidate.props.id, entry.artifactSha256));
  return reconcileManaged({
    message, meta, identity, ledger,
    entry: ledger.entries.find(item => item.artifactIdentity === message.request.artifact.identity),
    storageApi, commandApi,
  });
}

async function reconcileManaged({
  message, meta, identity, ledger, entry, storageApi, commandApi,
}) {
  assertEntryIdentity(entry, message.request, identity);
  const owned = await commandApi.GetScript({ id: entry.scriptId });
  if (!owned) {
    const collisions = await findIdentityCollisions(commandApi, meta);
    if (collisions.length) {
      throw ownershipError('Managed artifact script is absent but its userscript identity is occupied.');
    }
    return installAndOwn({ message, meta, identity, ledger, storageApi, commandApi });
  }
  if (!sameScriptIdentity(owned, identity)) {
    throw ownershipError('Managed artifact script ID was repurposed.');
  }
  const reconciled = await commandApi.ParseScript(parseSource(message, meta, entry.scriptId));
  const scriptId = reconciled?.where?.id;
  if (scriptId !== entry.scriptId) {
    throw new Error('Controlled reconcile changed the owned script ID unexpectedly.');
  }
  await persistManaged(
    storageApi, ledger, message.request, identity, scriptId, message.request.artifact.sha256);
  return reconciled;
}

export async function reconcileManagedDevelopmentArtifact({
  message,
  meta,
  storageApi,
  commandApi,
  hashText = sha256TextHex,
}) {
  if (!message?.request?.artifact?.identity || !message.request.artifact.sha256) {
    throw ownershipError('Managed artifact request identity is missing.');
  }
  if (!storageApi?.get || !storageApi?.set
  || !commandApi?.GetScript || !commandApi?.GetScriptCode || !commandApi?.ParseScript) {
    throw new Error('Managed artifact persistence or command adapter is unavailable.');
  }

  const identity = scriptIdentityFromMeta(meta);
  let ledger = await readLedger(storageApi);
  let entry = ledger.entries.find(
    item => item.artifactIdentity === message.request.artifact.identity);

  if (!entry) {
    const collisions = await findIdentityCollisions(commandApi, meta);
    if (collisions.length) {
      throw ownershipError('Controlled reconcile refused to adopt an unmanaged userscript identity collision.');
    }
    return installAndOwn({ message, meta, identity, ledger, storageApi, commandApi });
  }

  if (entry.state === 'installing') {
    return recoverInstalling({
      message, meta, identity, ledger, entry, storageApi, commandApi, hashText,
    });
  }
  return reconcileManaged({ message, meta, identity, ledger, entry, storageApi, commandApi });
}
