import {
  reconcileManagedDevelopmentState,
} from '@/common/developer-mode-development-state-convergence';
import {
  ManagedArtifactLifecycleError,
  WORKBENCH_MANAGED_STATE_MODE,
  WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
} from '@/common/developer-mode-managed-state';
import { WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY } from '@/common/developer-mode-managed-artifacts';

const NAME = 'Controlled Fixture';
const NAMESPACE = 'https://suprashellscripts.github/workbench';
const IDENTITY = 'controlled-fixture';
const META = { name: NAME, namespace: NAMESPACE };
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const CODE_A = 'code-a';
const CODE_B = 'code-b';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function entry({
  desiredState = 'present-enabled', digest = DIGEST_A, id = 7, revision = 0, pending = null,
} = {}) {
  return {
    artifactIdentity: IDENTITY,
    name: NAME,
    namespace: NAMESPACE,
    committed: desiredState == null ? null : {
      artifactSha256: digest,
      scriptId: desiredState === 'absent' ? null : id,
      desiredState,
      managedRevision: revision,
    },
    pending: clone(pending),
  };
}

function ledger(entries = []) {
  return {
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: clone(entries),
  };
}

function message({
  desiredState = 'present-enabled', digest = DIGEST_A, expectedManagedRevision = null,
  code = CODE_A,
} = {}) {
  return {
    request: {
      artifact: { identity: IDENTITY, sha256: digest },
      desiredState,
      expectedManagedRevision,
    },
    artifactCode: code,
  };
}

function script(id, {
  enabled = 1, removed = 0, name = NAME, namespace = NAMESPACE,
} = {}) {
  return {
    meta: { name, namespace },
    config: { enabled, removed },
    props: { id },
  };
}

function createStorage(initial, events = []) {
  const data = {
    [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: clone(initial),
  };
  let setCount = 0;
  return {
    data,
    get setCount() { return setCount; },
    async get(keys) {
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, clone(data[key])]));
    },
    async set(values) {
      setCount += 1;
      Object.assign(data, clone(values));
      const current = data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY];
      const currentEntry = current.entries.find(item => item.artifactIdentity === IDENTITY);
      events.push(['storage:set', clone(currentEntry)]);
    },
  };
}

function createCommands({ scripts = [], codes = {}, nextId = 20 } = {}, events = []) {
  const byId = new Map(scripts.map(item => [item.props.id, clone(item)]));
  const codeById = new Map(Object.entries(codes).map(([id, code]) => [+id, code]));
  const calls = [];
  const record = (name, value) => {
    calls.push([name, clone(value)]);
    events.push([name, clone(value)]);
  };
  const matches = (candidate, meta) => candidate.meta.name === meta.name
    && (candidate.meta.namespace || '') === (meta.namespace || '');

  return {
    calls,
    byId,
    codeById,
    async GetScript({ id, meta, removed }) {
      if (id != null) return clone(byId.get(id));
      return clone([...byId.values()].find(candidate => matches(candidate, meta)
        && Boolean(candidate.config.removed) === Boolean(removed)));
    },
    async GetScriptCode(id) {
      return codeById.get(id);
    },
    async ParseScript(source) {
      record('ParseScript', source);
      let current = source.id && byId.get(source.id);
      if (!current) {
        const aliveCollision = [...byId.values()].find(candidate => !candidate.config.removed
          && matches(candidate, source.meta));
        if (source.isNew && aliveCollision) throw new Error('namespace conflict');
        const id = nextId++;
        current = script(id, { enabled: 1, removed: 0 });
        byId.set(id, current);
      }
      current.meta = clone(source.meta);
      current.config.removed = 0;
      codeById.set(current.props.id, source.code);
      return { where: { id: current.props.id }, isNew: !source.id };
    },
    async UpdateScriptInfo({ id, config }) {
      record('UpdateScriptInfo', { id, config });
      Object.assign(byId.get(id).config, config);
    },
    async MarkRemoved({ id, removed }) {
      record('MarkRemoved', { id, removed });
      const current = byId.get(id);
      if (!current) throw new Error('missing script');
      current.config.removed = removed ? 1 : 0;
    },
    async RemoveScripts(ids) {
      record('RemoveScripts', ids);
      ids.forEach(id => {
        const current = byId.get(id);
        if (current?.config.removed) {
          byId.delete(id);
          codeById.delete(id);
        }
      });
    },
  };
}

const hashText = async code => {
  if (code === CODE_A) return DIGEST_A;
  if (code === CODE_B) return DIGEST_B;
  return 'f'.repeat(64);
};

it('persists initial pending intent before guarded ParseScript install and finalizes revision zero', async () => {
  const events = [];
  const storageApi = createStorage(ledger(), events);
  const commandApi = createCommands({}, events);

  const result = await reconcileManagedDevelopmentState({
    message: message(), meta: META, storageApi, commandApi, hashText,
  });

  expect(result).toEqual({
    managedRevision: 0,
    scriptId: 20,
    desiredState: 'present-enabled',
  });
  const parse = commandApi.calls.find(([name]) => name === 'ParseScript')[1];
  expect(parse.isNew).toBe(true);
  expect(parse.reloadTab).toBeUndefined();
  expect(events.findIndex(([name]) => name === 'storage:set'))
    .toBeLessThan(events.findIndex(([name]) => name === 'ParseScript'));
  expect(storageApi.setCount).toBe(2);
});

it('persists a revisioned pending transition before changing enabled state', async () => {
  const events = [];
  const storageApi = createStorage(ledger([entry()]), events);
  const commandApi = createCommands({ scripts: [script(7)], codes: { 7: CODE_A } }, events);

  const result = await reconcileManagedDevelopmentState({
    message: message({ desiredState: 'present-disabled', expectedManagedRevision: 0 }),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  });

  expect(result.managedRevision).toBe(1);
  expect(commandApi.byId.get(7).config.enabled).toBe(0);
  expect(events.findIndex(([name]) => name === 'storage:set'))
    .toBeLessThan(events.findIndex(([name]) => name === 'UpdateScriptInfo'));
});

it('recovers an already soft-removed pending absence without replaying unsafe MarkRemoved', async () => {
  const pending = {
    artifactSha256: DIGEST_A,
    desiredState: 'absent',
    fromRevision: 0,
    targetRevision: 1,
  };
  const storageApi = createStorage(ledger([entry({ pending })]));
  const commandApi = createCommands({
    scripts: [script(7, { removed: 1 })],
    codes: { 7: CODE_A },
  });

  const result = await reconcileManagedDevelopmentState({
    message: message({ desiredState: 'absent', expectedManagedRevision: 0 }),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  });

  expect(result).toEqual({ managedRevision: 1, scriptId: null, desiredState: 'absent' });
  expect(commandApi.calls.some(([name]) => name === 'MarkRemoved')).toBe(false);
  expect(commandApi.calls.some(([name]) => name === 'RemoveScripts')).toBe(true);
});

it('repairs hard deletion with a revision-neutral pending record before recreating ownership', async () => {
  const events = [];
  const storageApi = createStorage(ledger([entry({ revision: 4 })]), events);
  const commandApi = createCommands({ nextId: 30 }, events);

  const result = await reconcileManagedDevelopmentState({
    message: message(), meta: META, storageApi, commandApi, hashText,
  });

  expect(result).toEqual({
    managedRevision: 4,
    scriptId: 30,
    desiredState: 'present-enabled',
  });
  const pendingWrite = events.find(([name, value]) => name === 'storage:set' && value?.pending);
  expect(pendingWrite[1].pending).toEqual({
    artifactSha256: DIGEST_A,
    desiredState: 'present-enabled',
    fromRevision: 4,
    targetRevision: 4,
  });
  expect(events.indexOf(pendingWrite)).toBeLessThan(events.findIndex(([name]) => name === 'ParseScript'));
});

it('recovers a revision-neutral recreation by digest without incrementing revision', async () => {
  const repairPending = {
    artifactSha256: DIGEST_A,
    desiredState: 'present-enabled',
    fromRevision: 4,
    targetRevision: 4,
  };
  const storageApi = createStorage(ledger([entry({ revision: 4, pending: repairPending })]));
  const commandApi = createCommands({
    scripts: [script(30)],
    codes: { 30: CODE_A },
  });

  const result = await reconcileManagedDevelopmentState({
    message: message(), meta: META, storageApi, commandApi, hashText,
  });

  expect(result).toEqual({
    managedRevision: 4,
    scriptId: 30,
    desiredState: 'present-enabled',
  });
  expect(commandApi.calls.some(([name]) => name === 'ParseScript')).toBe(false);
});

it('repairs an owned soft-removal in place and preserves the managed revision', async () => {
  const storageApi = createStorage(ledger([entry({
    desiredState: 'present-disabled', revision: 2,
  })]));
  const commandApi = createCommands({
    scripts: [script(7, { enabled: 0, removed: 1 })],
    codes: { 7: CODE_A },
  });

  const result = await reconcileManagedDevelopmentState({
    message: message({ desiredState: 'present-disabled' }),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  });

  expect(result.managedRevision).toBe(2);
  expect(commandApi.byId.get(7).config.removed).toBe(0);
  expect(commandApi.calls).toContainEqual(['MarkRemoved', { id: 7, removed: false }]);
});

it('leaves an unmanaged same-identity script untouched on exact absent replay', async () => {
  const storageApi = createStorage(ledger([entry({ desiredState: 'absent', revision: 2 })]));
  const unmanaged = script(99);
  const commandApi = createCommands({ scripts: [unmanaged], codes: { 99: CODE_B } });

  const result = await reconcileManagedDevelopmentState({
    message: message({ desiredState: 'absent' }),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  });

  expect(result).toEqual({ managedRevision: 2, scriptId: null, desiredState: 'absent' });
  expect(commandApi.byId.get(99)).toEqual(unmanaged);
  expect(commandApi.calls).toEqual([]);
});

it('blocks tombstone recreation on unmanaged identity collision before pending persistence', async () => {
  const storageApi = createStorage(ledger([entry({ desiredState: 'absent', revision: 2 })]));
  const commandApi = createCommands({ scripts: [script(99)], codes: { 99: CODE_B } });

  await expect(reconcileManagedDevelopmentState({
    message: message({
      desiredState: 'present-enabled',
      digest: DIGEST_B,
      expectedManagedRevision: 2,
      code: CODE_B,
    }),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  })).rejects.toBeInstanceOf(ManagedArtifactLifecycleError);

  expect(storageApi.setCount).toBe(0);
  expect(commandApi.calls).toEqual([]);
});

it('repairs owned code drift through the same script ID without requesting a tab reload', async () => {
  const storageApi = createStorage(ledger([entry()]));
  const commandApi = createCommands({ scripts: [script(7)], codes: { 7: CODE_B } });

  const result = await reconcileManagedDevelopmentState({
    message: message(), meta: META, storageApi, commandApi, hashText,
  });

  expect(result.managedRevision).toBe(0);
  const parse = commandApi.calls.find(([name]) => name === 'ParseScript')[1];
  expect(parse.id).toBe(7);
  expect(parse.isNew).toBeUndefined();
  expect(parse.reloadTab).toBeUndefined();
  expect(commandApi.codeById.get(7)).toBe(CODE_A);
});
