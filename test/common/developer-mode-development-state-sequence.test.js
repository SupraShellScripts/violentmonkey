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
const DESIRED_STATES = ['present-enabled', 'present-disabled', 'absent'];

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

function generatedActions(model) {
  const staleRevision = model.managedRevision === 0 ? null : model.managedRevision - 1;
  const transitions = DESIRED_STATES.filter(state => state !== model.desiredState);
  return [
    {
      label: `replay-null:${model.desiredState}`,
      desiredState: model.desiredState,
      expectedManagedRevision: null,
      result: 'replay',
    },
    {
      label: `replay-wrong-revision:${model.desiredState}`,
      desiredState: model.desiredState,
      expectedManagedRevision: model.managedRevision + 7,
      result: 'replay',
    },
    ...transitions.flatMap(desiredState => [
      {
        label: `transition:${desiredState}`,
        desiredState,
        expectedManagedRevision: model.managedRevision,
        result: 'transition',
      },
      {
        label: `stale:${desiredState}`,
        desiredState,
        expectedManagedRevision: staleRevision,
        result: 'reject',
      },
    ]),
  ];
}

function applyGeneratedAction(model, action) {
  if (action.result !== 'transition') return model;
  return {
    desiredState: action.desiredState,
    managedRevision: model.managedRevision + 1,
  };
}

function generateHistories(depth, model = {
  desiredState: 'present-enabled',
  managedRevision: 0,
}, prefix = []) {
  if (depth === 0) return [prefix];
  return generatedActions(model).flatMap(action => generateHistories(
    depth - 1,
    applyGeneratedAction(model, action),
    [...prefix, action],
  ));
}

function expectCommittedModel(storageApi, model) {
  const ledger = storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY];
  expect(ledger.entries).toHaveLength(1);
  expect(ledger.entries[0]).toMatchObject({
    artifactIdentity: IDENTITY,
    committed: {
      artifactSha256: DIGEST,
      desiredState: model.desiredState,
      managedRevision: model.managedRevision,
      scriptId: model.desiredState === 'absent' ? null : expect.any(Number),
    },
    pending: null,
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

it('matches the lifecycle model across generated replay, transition, and stale histories', async () => {
  const histories = generateHistories(3);
  expect(histories).toHaveLength(216);

  for (const history of histories) {
    const storageApi = createStorage();
    const commandApi = createCommands();
    const initial = await reconcile(storageApi, commandApi, 'present-enabled', null);
    let model = { desiredState: 'present-enabled', managedRevision: 0 };
    let lastPresentScriptId = initial.scriptId;

    for (const action of history) {
      const beforeLedger = clone(storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]);
      const beforeModel = { ...model };
      if (action.result === 'reject') {
        await expect(reconcile(
          storageApi,
          commandApi,
          action.desiredState,
          action.expectedManagedRevision,
        )).rejects.toThrow('Managed lifecycle revision precondition failed.');
        expect(storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]).toEqual(beforeLedger);
      } else {
        const result = await reconcile(
          storageApi,
          commandApi,
          action.desiredState,
          action.expectedManagedRevision,
        );
        model = applyGeneratedAction(model, action);
        expect(result).toMatchObject({
          desiredState: model.desiredState,
          managedRevision: model.managedRevision,
          scriptId: model.desiredState === 'absent' ? null : expect.any(Number),
        });
        if (action.result === 'replay') {
          expect(model).toEqual(beforeModel);
          expect(storageApi.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]).toEqual(beforeLedger);
        } else if (beforeModel.desiredState !== 'absent' && model.desiredState !== 'absent') {
          expect(result.scriptId).toBe(lastPresentScriptId);
        } else if (beforeModel.desiredState === 'absent' && model.desiredState !== 'absent') {
          expect(result.scriptId).not.toBe(lastPresentScriptId);
          lastPresentScriptId = result.scriptId;
        }
        if (model.desiredState !== 'absent') lastPresentScriptId = result.scriptId;
      }
      expectCommittedModel(storageApi, model);
    }
  }
});
