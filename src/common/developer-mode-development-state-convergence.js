import { sha256TextHex } from './developer-mode-reconcile';
import {
  finalizeManagedDevelopmentTransition,
  ManagedArtifactLifecycleError,
  persistManagedDevelopmentLifecycleLedger,
  planManagedDevelopmentPhysicalRepair,
  planManagedDevelopmentTransition,
  readManagedDevelopmentLifecycleLedger,
} from './developer-mode-managed-state';

let lifecycleMutationQueue = Promise.resolve();

function lifecycleError(message) {
  return new ManagedArtifactLifecycleError(message);
}

function validateCommandApi(commandApi) {
  const required = [
    'GetScript', 'GetScriptCode', 'ParseScript', 'UpdateScriptInfo', 'MarkRemoved', 'RemoveScripts',
  ];
  if (!commandApi || required.some(name => typeof commandApi[name] !== 'function')) {
    throw new Error('Managed lifecycle browser command adapter is unavailable.');
  }
}

function scriptIdentityFromMeta(meta) {
  const name = meta?.name;
  const namespace = meta?.namespace || '';
  if (typeof name !== 'string' || !name || typeof namespace !== 'string') {
    throw lifecycleError('Managed lifecycle userscript identity is invalid.');
  }
  return { name, namespace };
}

function sameScriptIdentity(script, identity) {
  return script?.meta?.name === identity.name
    && (script.meta.namespace || '') === identity.namespace;
}

function entryFor(ledger, artifactIdentity) {
  return ledger.entries.find(entry => entry.artifactIdentity === artifactIdentity);
}

function readFlag(value, label) {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  throw lifecycleError(`Managed lifecycle script ${label} state is unavailable.`);
}

async function findIdentityCollisions(commandApi, meta) {
  const [alive, removed] = await Promise.all([
    commandApi.GetScript({ meta }),
    commandApi.GetScript({ meta, removed: true }),
  ]);
  const byId = new Map();
  for (const script of [alive, removed].filter(Boolean)) {
    const id = script?.props?.id;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw lifecycleError('Managed lifecycle identity collision has an invalid script ID.');
    }
    byId.set(id, script);
  }
  return [...byId.values()];
}

async function assertNoIdentityCollision(commandApi, meta, exceptId = null) {
  const collisions = await findIdentityCollisions(commandApi, meta);
  const foreign = collisions.filter(script => script.props.id !== exceptId);
  if (foreign.length) {
    throw lifecycleError('Managed lifecycle refused an unmanaged userscript identity collision.');
  }
}

async function readOwnedScript(commandApi, id, identity) {
  if (id == null) return null;
  const script = await commandApi.GetScript({ id });
  if (script && !sameScriptIdentity(script, identity)) {
    throw lifecycleError('Managed lifecycle owned script ID was repurposed.');
  }
  return script;
}

function parseSource(message, meta, scriptId = null) {
  return {
    ...scriptId && { id: scriptId },
    ...!scriptId && { isNew: true },
    code: message.artifactCode,
    meta,
    errors: null,
    message: '',
    bumpDate: false,
  };
}

async function codeMatches(commandApi, scriptId, digest, hashText) {
  const code = await commandApi.GetScriptCode(scriptId);
  return typeof code === 'string' && await hashText(code) === digest;
}

async function preflightBegin({ plan, message, meta, identity, commandApi }) {
  if (message.request.desiredState === 'absent') {
    const id = plan.entry.committed?.scriptId;
    if (id != null) await readOwnedScript(commandApi, id, identity);
    return;
  }

  const id = plan.entry.committed?.scriptId;
  if (id == null) {
    await assertNoIdentityCollision(commandApi, meta);
    return;
  }

  const owned = await readOwnedScript(commandApi, id, identity);
  if (!owned) {
    await assertNoIdentityCollision(commandApi, meta);
    return;
  }
  if (readFlag(owned.config?.removed, 'removed')) {
    await assertNoIdentityCollision(commandApi, meta, id);
  }
}

async function recoverInstalledCandidate({
  commandApi, meta, identity, digest, hashText,
}) {
  const collisions = await findIdentityCollisions(commandApi, meta);
  if (!collisions.length) return null;
  if (collisions.length !== 1) {
    throw lifecycleError('Pending managed lifecycle recovery found ambiguous identity collisions.');
  }
  const candidate = collisions[0];
  if (!sameScriptIdentity(candidate, identity)
  || readFlag(candidate.config?.removed, 'removed')
  || !await codeMatches(commandApi, candidate.props.id, digest, hashText)) {
    throw lifecycleError('Pending managed lifecycle recovery refused an unowned identity collision.');
  }
  return candidate;
}

async function installPresent({ message, meta, commandApi }) {
  const result = await commandApi.ParseScript(parseSource(message, meta));
  const id = result?.where?.id;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error('Managed lifecycle install returned an invalid script ID.');
  }
  return id;
}

async function convergePresent({ plan, message, meta, identity, commandApi, hashText }) {
  const digest = message.request.artifact.sha256;
  const desiredEnabled = message.request.desiredState === 'present-enabled';
  const committedId = plan.entry.committed?.scriptId ?? null;
  let id = committedId;
  let script = await readOwnedScript(commandApi, committedId, identity);

  if (!script && plan.kind === 'recover') {
    const candidate = await recoverInstalledCandidate({
      commandApi, meta, identity, digest, hashText,
    });
    if (candidate) {
      script = candidate;
      id = candidate.props.id;
    }
  }

  if (!script) {
    await assertNoIdentityCollision(commandApi, meta);
    id = await installPresent({ message, meta, commandApi });
    script = await readOwnedScript(commandApi, id, identity);
    if (!script) throw new Error('Managed lifecycle installed script could not be observed.');
  }

  if (readFlag(script.config?.removed, 'removed')) {
    await assertNoIdentityCollision(commandApi, meta, id);
    await commandApi.MarkRemoved({ id, removed: false });
    script = await readOwnedScript(commandApi, id, identity);
    if (!script || readFlag(script.config?.removed, 'removed')) {
      throw new Error('Managed lifecycle could not restore the owned script.');
    }
  }

  if (!await codeMatches(commandApi, id, digest, hashText)) {
    const result = await commandApi.ParseScript(parseSource(message, meta, id));
    if (result?.where?.id !== id) {
      throw new Error('Managed lifecycle update changed the owned script ID unexpectedly.');
    }
    script = await readOwnedScript(commandApi, id, identity);
    if (!script) throw new Error('Managed lifecycle updated script could not be observed.');
  }

  if (readFlag(script.config?.enabled, 'enabled') !== desiredEnabled) {
    await commandApi.UpdateScriptInfo({ id, config: { enabled: desiredEnabled ? 1 : 0 } });
    script = await readOwnedScript(commandApi, id, identity);
    if (!script || readFlag(script.config?.enabled, 'enabled') !== desiredEnabled) {
      throw new Error('Managed lifecycle could not converge the owned script enabled state.');
    }
  }

  return id;
}

async function convergeAbsent({ plan, identity, commandApi }) {
  const id = plan.entry.committed?.scriptId ?? null;
  if (id == null) return null;
  const script = await readOwnedScript(commandApi, id, identity);
  if (!script) return null;

  if (!readFlag(script.config?.removed, 'removed')) {
    await commandApi.MarkRemoved({ id, removed: true });
  }
  await commandApi.RemoveScripts([id]);
  if (await commandApi.GetScript({ id })) {
    throw new Error('Managed lifecycle owned script remained after removal.');
  }
  return null;
}

async function reconcileOne({ message, meta, storageApi, commandApi, hashText }) {
  validateCommandApi(commandApi);
  if (!message?.request?.artifact?.identity || typeof message.artifactCode !== 'string') {
    throw lifecycleError('Managed lifecycle reconcile input is incomplete.');
  }

  const identity = scriptIdentityFromMeta(meta);
  let ledger = await readManagedDevelopmentLifecycleLedger(storageApi);
  let plan = planManagedDevelopmentTransition({ ledger, request: message.request, identity });

  if (plan.kind === 'begin') {
    await preflightBegin({ plan, message, meta, identity, commandApi });
    ledger = await persistManagedDevelopmentLifecycleLedger(storageApi, plan.ledger);
    plan = { ...plan, ledger, entry: entryFor(ledger, message.request.artifact.identity) };
  } else if (plan.kind === 'replay' && message.request.desiredState !== 'absent') {
    const id = plan.entry.committed.scriptId;
    const owned = await readOwnedScript(commandApi, id, identity);
    if (!owned) {
      await assertNoIdentityCollision(commandApi, meta);
      plan = planManagedDevelopmentPhysicalRepair({
        ledger: plan.ledger,
        request: message.request,
        identity,
      });
      ledger = await persistManagedDevelopmentLifecycleLedger(storageApi, plan.ledger);
      plan = { ...plan, ledger, entry: entryFor(ledger, message.request.artifact.identity) };
    }
  }

  const scriptId = message.request.desiredState === 'absent'
    ? await convergeAbsent({ plan, identity, commandApi })
    : await convergePresent({ plan, message, meta, identity, commandApi, hashText });

  if (plan.kind === 'replay') {
    return {
      managedRevision: plan.entry.committed.managedRevision,
      scriptId,
      desiredState: message.request.desiredState,
    };
  }

  const finalized = finalizeManagedDevelopmentTransition({
    ledger: plan.ledger,
    artifactIdentity: message.request.artifact.identity,
    desiredState: message.request.desiredState,
    artifactSha256: message.request.artifact.sha256,
    scriptId,
  });
  ledger = await persistManagedDevelopmentLifecycleLedger(storageApi, finalized);
  const committed = entryFor(ledger, message.request.artifact.identity)?.committed;
  return {
    managedRevision: committed.managedRevision,
    scriptId: committed.scriptId,
    desiredState: committed.desiredState,
  };
}

export function reconcileManagedDevelopmentState({
  message,
  meta,
  storageApi,
  commandApi,
  hashText = sha256TextHex,
}) {
  const run = () => reconcileOne({ message, meta, storageApi, commandApi, hashText });
  const result = lifecycleMutationQueue.then(run, run);
  lifecycleMutationQueue = result.catch(() => undefined);
  return result;
}
