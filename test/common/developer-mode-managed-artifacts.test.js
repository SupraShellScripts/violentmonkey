import { webcrypto } from 'crypto';
import {
  ManagedArtifactOwnershipError,
  reconcileManagedDevelopmentArtifact,
  WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY,
} from '@/common/developer-mode-managed-artifacts';
import { sha256TextHex } from '@/common/developer-mode-reconcile';

const NAME = 'Controlled Fixture';
const NAMESPACE = 'https://suprashellscripts.github/workbench';
const META = { name: NAME, namespace: NAMESPACE };

async function buildMessage(code = '/* governed */') {
  return {
    artifactCode: code,
    request: {
      artifact: {
        identity: 'controlled-fixture',
        sha256: await sha256TextHex(code, webcrypto),
      },
    },
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createStorage(initial = {}, { failSetAt = 0 } = {}) {
  const data = clone(initial) || {};
  let setCount = 0;
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, clone(data[key])]));
    },
    async set(values) {
      setCount += 1;
      if (setCount === failSetAt) throw new Error('simulated storage failure');
      Object.assign(data, clone(values));
    },
  };
}

function createCommands(seed = []) {
  const scripts = new Map();
  const codes = new Map();
  const parseCalls = [];
  let nextId = 1;

  function add({ id = nextId++, meta = META, code = '/* existing */', removed = false }) {
    nextId = Math.max(nextId, id + 1);
    scripts.set(id, {
      meta: clone(meta),
      config: { enabled: 1, removed: removed ? 1 : 0 },
      custom: {},
      props: { id },
    });
    codes.set(id, code);
    return id;
  }
  seed.forEach(add);

  const api = {
    scripts,
    codes,
    parseCalls,
    add,
    GetScript({ id, meta, removed = false }) {
      if (id) return clone(scripts.get(id));
      return clone([...scripts.values()].find(script => (
        Boolean(script.config.removed) === removed
        && script.meta.name === meta.name
        && (script.meta.namespace || '') === (meta.namespace || '')
      )));
    },
    GetScriptCode(id) {
      return codes.get(id);
    },
    ParseScript(source) {
      parseCalls.push(clone(source));
      let id = source.id;
      if (id) {
        const script = scripts.get(id);
        if (!script) throw new Error('missing explicit script');
        script.meta = clone(source.meta);
        script.config.removed = 0;
      } else {
        id = add({ meta: source.meta, code: source.code });
      }
      codes.set(id, source.code);
      return { where: { id } };
    },
  };
  return api;
}

const hashText = text => sha256TextHex(text, webcrypto);

async function reconcile(message, storageApi, commandApi, meta = META) {
  return reconcileManagedDevelopmentArtifact({
    message, meta, storageApi, commandApi, hashText,
  });
}

function ledger(storage) {
  return storage.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY];
}

test.each([
  ['alive', false],
  ['removed', true],
])('unmanaged %s userscript identity collision blocks before mutation', async (label, removed) => {
  const message = await buildMessage();
  const storage = createStorage();
  const commands = createCommands([{ removed, code: message.artifactCode }]);

  await expect(reconcile(message, storage, commands)).rejects.toBeInstanceOf(
    ManagedArtifactOwnershipError);
  expect(commands.parseCalls).toHaveLength(0);
  expect(ledger(storage)).toBeUndefined();
});

test('fresh install creates ownership and second reconcile keeps the same script ID', async () => {
  const message = await buildMessage();
  const storage = createStorage();
  const commands = createCommands();

  const first = await reconcile(message, storage, commands);
  const second = await reconcile(message, storage, commands);

  expect(first.where.id).toBe(1);
  expect(second.where.id).toBe(1);
  expect(commands.parseCalls).toHaveLength(2);
  expect(commands.parseCalls[0]).not.toHaveProperty('id');
  expect(commands.parseCalls[0].isNew).toBe(true);
  expect(commands.parseCalls[1].id).toBe(1);
  expect(commands.parseCalls[1]).not.toHaveProperty('isNew');
  expect(ledger(storage)).toEqual({
    schemaVersion: 1,
    entries: [{
      state: 'managed',
      artifactIdentity: 'controlled-fixture',
      name: NAME,
      namespace: NAMESPACE,
      artifactSha256: message.request.artifact.sha256,
      scriptId: 1,
    }],
  });
});

test('managed code drift is reconciled while metadata repurposing blocks', async () => {
  const firstMessage = await buildMessage('/* v1 */');
  const nextMessage = await buildMessage('/* v2 */');
  const storage = createStorage();
  const commands = createCommands();
  await reconcile(firstMessage, storage, commands);

  commands.codes.set(1, '/* local drift */');
  const updated = await reconcile(nextMessage, storage, commands);
  expect(updated.where.id).toBe(1);
  expect(commands.codes.get(1)).toBe('/* v2 */');

  commands.scripts.get(1).meta = { name: 'Repurposed', namespace: NAMESPACE };
  await expect(reconcile(nextMessage, storage, commands)).rejects.toBeInstanceOf(
    ManagedArtifactOwnershipError);
  expect(commands.parseCalls).toHaveLength(2);
});

test('hard-deleted managed script is recreated only when its identity is unoccupied', async () => {
  const message = await buildMessage();
  const storage = createStorage();
  const commands = createCommands();
  await reconcile(message, storage, commands);

  commands.scripts.delete(1);
  commands.codes.delete(1);
  const recreated = await reconcile(message, storage, commands);
  expect(recreated.where.id).toBe(2);
  expect(ledger(storage).entries[0].scriptId).toBe(2);

  commands.scripts.delete(2);
  commands.codes.delete(2);
  commands.add({ id: 9, meta: META, code: '/* unmanaged replacement */' });
  await expect(reconcile(message, storage, commands)).rejects.toBeInstanceOf(
    ManagedArtifactOwnershipError);
  expect(commands.codes.get(9)).toBe('/* unmanaged replacement */');
});

test('pending ownership recovers only the exact previously authorized bytes', async () => {
  const message = await buildMessage('/* pending exact */');
  const storage = createStorage({}, { failSetAt: 2 });
  const commands = createCommands();

  await expect(reconcile(message, storage, commands)).rejects.toThrow('simulated storage failure');
  expect(commands.scripts.get(1)).toBeTruthy();
  expect(ledger(storage).entries[0]).toMatchObject({
    state: 'installing',
    artifactSha256: message.request.artifact.sha256,
    scriptId: null,
  });

  const recovered = await reconcile(message, storage, commands);
  expect(recovered.where.id).toBe(1);
  expect(ledger(storage).entries[0]).toMatchObject({ state: 'managed', scriptId: 1 });
});

test('pending ownership never adopts same-identity bytes that differ from the pending digest', async () => {
  const message = await buildMessage('/* authorized */');
  const storage = createStorage({
    [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: {
      schemaVersion: 1,
      entries: [{
        state: 'installing',
        artifactIdentity: message.request.artifact.identity,
        name: NAME,
        namespace: NAMESPACE,
        artifactSha256: message.request.artifact.sha256,
        scriptId: null,
      }],
    },
  });
  const commands = createCommands([{ meta: META, code: '/* different */' }]);

  await expect(reconcile(message, storage, commands)).rejects.toBeInstanceOf(
    ManagedArtifactOwnershipError);
  expect(commands.parseCalls).toHaveLength(0);
  expect(ledger(storage).entries[0].state).toBe('installing');
});

test('ownership ledger stays separate from governed source and ParseScript payload', async () => {
  const message = await buildMessage('// governed source remains byte-for-byte');
  const storage = createStorage();
  const commands = createCommands();

  await reconcile(message, storage, commands);
  expect(commands.codes.get(1)).toBe(message.artifactCode);
  expect(commands.parseCalls[0]).toEqual({
    isNew: true,
    code: message.artifactCode,
    meta: META,
    errors: null,
    message: '',
    bumpDate: false,
  });
  expect(JSON.stringify(commands.parseCalls[0])).not.toContain('vmwb:managed-artifacts');
  expect(Object.keys(storage.data)).toContain(WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY);
});

test('malformed or duplicate ledger authority fails closed', async () => {
  const message = await buildMessage();
  const duplicate = {
    state: 'managed', artifactIdentity: 'controlled-fixture', name: NAME, namespace: NAMESPACE,
    artifactSha256: message.request.artifact.sha256, scriptId: 1,
  };
  const storage = createStorage({
    [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: {
      schemaVersion: 1,
      entries: [duplicate, { ...duplicate }],
    },
  });

  await expect(reconcile(message, storage, createCommands())).rejects.toBeInstanceOf(
    ManagedArtifactOwnershipError);
});
