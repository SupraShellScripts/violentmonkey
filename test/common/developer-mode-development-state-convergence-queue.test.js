import { reconcileManagedDevelopmentState } from '@/common/developer-mode-development-state-convergence';
import {
  WORKBENCH_MANAGED_STATE_MODE,
  WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
} from '@/common/developer-mode-managed-state';
import { WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY } from '@/common/developer-mode-managed-artifacts';

const DIGEST = 'a'.repeat(64);
const META = {
  name: 'Controlled Fixture',
  namespace: 'https://suprashellscripts.github/workbench',
};
const LEDGER = {
  schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
  mode: WORKBENCH_MANAGED_STATE_MODE,
  entries: [{
    artifactIdentity: 'controlled-fixture',
    name: META.name,
    namespace: META.namespace,
    committed: {
      artifactSha256: DIGEST,
      scriptId: null,
      desiredState: 'absent',
      managedRevision: 3,
    },
    pending: null,
  }],
};
const MESSAGE = {
  artifactCode: '// governed',
  request: {
    artifact: { identity: 'controlled-fixture', sha256: DIGEST },
    desiredState: 'absent',
    expectedManagedRevision: null,
  },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function commandApi() {
  return {
    GetScript() {},
    GetScriptCode() {},
    ParseScript() {},
    UpdateScriptInfo() {},
    MarkRemoved() {},
    RemoveScripts() {},
  };
}

function storageApi({ beforeGet } = {}) {
  let gets = 0;
  return {
    get gets() { return gets; },
    async get(keys) {
      gets += 1;
      await beforeGet?.();
      return keys.includes(WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY)
        ? { [WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]: LEDGER }
        : {};
    },
    async set() {
      throw new Error('Exact absent replay must not write lifecycle storage.');
    },
  };
}

test('back-to-back lifecycle requests serialize the whole read/plan/mutate sequence', async () => {
  const entered = deferred();
  const release = deferred();
  const firstStorage = storageApi({
    beforeGet: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  const secondStorage = storageApi();

  const first = reconcileManagedDevelopmentState({
    message: MESSAGE,
    meta: META,
    storageApi: firstStorage,
    commandApi: commandApi(),
  });
  await entered.promise;

  const second = reconcileManagedDevelopmentState({
    message: MESSAGE,
    meta: META,
    storageApi: secondStorage,
    commandApi: commandApi(),
  });
  await Promise.resolve();
  expect(secondStorage.gets).toBe(0);

  release.resolve();
  await expect(first).resolves.toMatchObject({ managedRevision: 3, scriptId: null });
  await expect(second).resolves.toMatchObject({ managedRevision: 3, scriptId: null });
  expect(firstStorage.gets).toBe(1);
  expect(secondStorage.gets).toBe(1);
});
