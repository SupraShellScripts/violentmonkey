import { reconcileManagedDevelopmentState } from '@/common/developer-mode-development-state-convergence';
import {
  WORKBENCH_MANAGED_STATE_MODE,
  WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
} from '@/common/developer-mode-managed-state';
import { WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY } from '@/common/developer-mode-managed-artifacts';

const NAME = 'Controlled Fixture';
const NAMESPACE = 'https://suprashellscripts.github/workbench';
const IDENTITY = 'controlled-fixture';
const DIGEST = 'a'.repeat(64);
const CODE = 'code-a';
const META = { name: NAME, namespace: NAMESPACE };

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function message(desiredState, expectedManagedRevision) {
  return {
    request: {
      artifact: { identity: IDENTITY, sha256: DIGEST },
      desiredState,
      expectedManagedRevision,
    },
    artifactCode: CODE,
  };
}

function createStorage() {
  const data = {
    [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: {
      schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
      mode: WORKBENCH_MANAGED_STATE_MODE,
      entries: [],
    },
  };
  return {
    data,
    async get(keys) {
      return Object.fromEntries(keys.filter(key => key in data).map(key => [key, clone(data[key])]));
    },
    async set(values) {
      Object.assign(data, clone(values));
    },
  };
}

function createCommands() {
  const scripts = new Map();
  const codes = new Map();
  let nextId = 20;
  const sameIdentity = script => script?.meta?.name === NAME
    && (script.meta.namespace || '') === NAMESPACE;
  return {
    scripts,
    async GetScript({ id, removed }) {
      if (id != null) return clone(scripts.get(id));
      return clone([...scripts.values()].find(script => sameIdentity(script)
        && Boolean(script.config.removed) === Boolean(removed)));
    },
    async GetScriptCode(id) {
      return codes.get(id);
    },
    async ParseScript(source) {
      let script = source.id ? scripts.get(source.id) : null;
      if (!script) {
        if (source.isNew && [...scripts.values()].some(candidate => !candidate.config.removed && sameIdentity(candidate))) {
          throw new Error('namespace conflict');
        }
        const id = nextId++;
        script = {
          meta: clone(source.meta),
          config: { enabled: 1, removed: 0 },
          props: { id },
        };
        scripts.set(id, script);
      }
      script.meta = clone(source.meta);
      script.config.removed = 0;
      codes.set(script.props.id, source.code);
      return { where: { id: script.props.id } };
    },
    async UpdateScriptInfo({ id, config }) {
      Object.assign(scripts.get(id).config, config);
    },
    async MarkRemoved({ id, removed }) {
      const script = scripts.get(id);
      if (!script) throw new Error('missing script');
      script.config.removed = removed ? 1 : 0;
    },
    async RemoveScripts(ids) {
      ids.forEach(id => {
        if (scripts.get(id)?.config.removed) {
          scripts.delete(id);
          codes.delete(id);
        }
      });
    },
  };
}

const hashText = async code => code === CODE ? DIGEST : 'f'.repeat(64);

async function reconcile(storageApi, commandApi, desiredState, expectedManagedRevision) {
  return reconcileManagedDevelopmentState({
    message: message(desiredState, expectedManagedRevision),
    meta: META,
    storageApi,
    commandApi,
    hashText,
  });
}

it('keeps absent replay idempotent after disable, re-enable, and a rejected stale transition', async () => {
  const storageApi = createStorage();
  const commandApi = createCommands();

  const enabled = await reconcile(storageApi, commandApi, 'present-enabled', null);
  expect(enabled).toMatchObject({ managedRevision: 0, desiredState: 'present-enabled' });

  const enabledReplay = await reconcile(storageApi, commandApi, 'present-enabled', null);
  expect(enabledReplay).toEqual(enabled);

  const disabled = await reconcile(storageApi, commandApi, 'present-disabled', 0);
  expect(disabled).toMatchObject({ managedRevision: 1, scriptId: enabled.scriptId });

  const disabledReplay = await reconcile(storageApi, commandApi, 'present-disabled', null);
  expect(disabledReplay).toEqual(disabled);

  const reenabled = await reconcile(storageApi, commandApi, 'present-enabled', 1);
  expect(reenabled).toMatchObject({ managedRevision: 2, scriptId: enabled.scriptId });

  await expect(reconcile(storageApi, commandApi, 'absent', 0)).rejects.toThrow(
    'Managed lifecycle revision precondition failed.');

  const absent = await reconcile(storageApi, commandApi, 'absent', 2);
  expect(absent).toEqual({ managedRevision: 3, scriptId: null, desiredState: 'absent' });

  const ledgerAfterAbsent = storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY];
  expect(ledgerAfterAbsent.entries[0]).toMatchObject({
    committed: {
      artifactSha256: DIGEST,
      scriptId: null,
      desiredState: 'absent',
      managedRevision: 3,
    },
    pending: null,
  });

  const absentReplay = await reconcile(storageApi, commandApi, 'absent', null);
  expect(absentReplay).toEqual(absent);
  expect(storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]).toEqual(ledgerAfterAbsent);
});
