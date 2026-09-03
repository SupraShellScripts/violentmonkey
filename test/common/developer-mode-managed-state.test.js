import {
  ManagedArtifactOwnershipError,
  reconcileManagedDevelopmentArtifact,
  WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY,
} from '@/common/developer-mode-managed-artifacts';
import {
  activateManagedDevelopmentLifecycle,
  finalizeManagedDevelopmentTransition,
  ManagedArtifactLifecycleError,
  persistManagedDevelopmentLifecycleLedger,
  planManagedDevelopmentTransition,
  readManagedDevelopmentLifecycleLedger,
  validateManagedDevelopmentLifecycleLedger,
  WORKBENCH_MANAGED_STATE_MODE,
  WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
} from '@/common/developer-mode-managed-state';

const NAME = 'Controlled Fixture';
const NAMESPACE = 'https://suprashellscripts.github/workbench';
const IDENTITY = { name: NAME, namespace: NAMESPACE };
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createStorage(initial, { failSet = false } = {}) {
  const data = initial === undefined ? {} : {
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
      if (failSet) throw new Error('simulated lifecycle storage failure');
      Object.assign(data, clone(values));
    },
  };
}

function v1Entry({
  state = 'managed', id = 7, digest = DIGEST_A, name = NAME, namespace = NAMESPACE,
} = {}) {
  return {
    state,
    artifactIdentity: 'controlled-fixture',
    name,
    namespace,
    artifactSha256: digest,
    scriptId: state === 'installing' ? null : id,
  };
}

function v1Ledger(entries = [v1Entry()]) {
  return { schemaVersion: 1, entries: clone(entries) };
}

function script(id = 7, { enabled = 1, removed = 0, name = NAME, namespace = NAMESPACE } = {}) {
  return {
    meta: { name, namespace },
    config: { enabled, removed },
    props: { id },
  };
}

function migrationCommands(scripts = new Map([[7, script()]])) {
  const calls = [];
  return {
    calls,
    async GetScript({ id }) {
      calls.push(['GetScript', id]);
      return clone(scripts.get(id));
    },
  };
}

function lifecycleRequest({
  desiredState = 'present-enabled', digest = DIGEST_A, expectedManagedRevision = null,
} = {}) {
  return {
    artifact: { identity: 'controlled-fixture', sha256: digest },
    desiredState,
    expectedManagedRevision,
  };
}

function committedLedger({
  desiredState = 'present-enabled', digest = DIGEST_A, revision = 0, scriptId = 7,
} = {}) {
  return {
    schemaVersion: 2,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: [{
      artifactIdentity: 'controlled-fixture',
      name: NAME,
      namespace: NAMESPACE,
      committed: {
        artifactSha256: digest,
        scriptId: desiredState === 'absent' ? null : scriptId,
        desiredState,
        managedRevision: revision,
      },
      pending: null,
    }],
  };
}

function legacyMessage() {
  return {
    request: {
      artifact: { identity: 'controlled-fixture', sha256: DIGEST_A },
    },
    artifactCode: '/* governed */',
  };
}

test('empty profile lifecycle activation writes one schema-v2 mode fence', async () => {
  const storage = createStorage();
  const commands = migrationCommands(new Map());
  const ledger = await activateManagedDevelopmentLifecycle({ storageApi: storage, commandApi: commands });
  expect(ledger).toEqual({
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: [],
  });
  expect(storage.setCount).toBe(1);
  await expect(readManagedDevelopmentLifecycleLedger(storage)).resolves.toEqual(ledger);

  const again = await activateManagedDevelopmentLifecycle({ storageApi: storage, commandApi: commands });
  expect(again).toEqual(ledger);
  expect(storage.setCount).toBe(1);
});

test.each([
  [1, 'present-enabled'],
  [0, 'present-disabled'],
  [true, 'present-enabled'],
  [false, 'present-disabled'],
])('v1 managed ownership migrates to revision zero from observed enabled=%s', async (
  enabled, desiredState,
) => {
  const storage = createStorage(v1Ledger());
  const commands = migrationCommands(new Map([[7, script(7, { enabled })]]));
  const ledger = await activateManagedDevelopmentLifecycle({ storageApi: storage, commandApi: commands });
  expect(ledger.entries[0]).toEqual({
    artifactIdentity: 'controlled-fixture',
    name: NAME,
    namespace: NAMESPACE,
    committed: {
      artifactSha256: DIGEST_A,
      scriptId: 7,
      desiredState,
      managedRevision: 0,
    },
    pending: null,
  });
});

test('schema-v2 activation permanently fences the legacy reconcile mutator', async () => {
  const storage = createStorage(v1Ledger());
  const migration = migrationCommands();
  await activateManagedDevelopmentLifecycle({ storageApi: storage, commandApi: migration });

  const parseCalls = [];
  const commandApi = {
    GetScript() { return null; },
    GetScriptCode() { return ''; },
    ParseScript(source) { parseCalls.push(source); return { where: { id: 1 } }; },
  };
  await expect(reconcileManagedDevelopmentArtifact({
    message: legacyMessage(),
    meta: IDENTITY,
    storageApi: storage,
    commandApi,
  })).rejects.toBeInstanceOf(ManagedArtifactOwnershipError);
  expect(parseCalls).toHaveLength(0);
  expect(storage.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY].schemaVersion).toBe(2);
});

test.each([
  ['pending v1 install', v1Ledger([v1Entry({ state: 'installing' })]), script()],
  ['missing owned script', v1Ledger(), null],
  ['repurposed identity', v1Ledger(), script(7, { name: 'Repurposed' })],
  ['soft-removed owned script', v1Ledger(), script(7, { removed: 1 })],
  ['missing enabled state', v1Ledger(), script(7, { enabled: null })],
])('unsafe v1 migration fails closed without replacing the ledger: %s', async (
  label, oldLedger, ownedScript,
) => {
  const storage = createStorage(oldLedger);
  const scripts = new Map();
  if (ownedScript) scripts.set(7, ownedScript);
  await expect(activateManagedDevelopmentLifecycle({
    storageApi: storage,
    commandApi: migrationCommands(scripts),
  })).rejects.toBeInstanceOf(ManagedArtifactLifecycleError);
  expect(storage.setCount).toBe(0);
  expect(storage.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]).toEqual(oldLedger);
});

test('failed lifecycle-mode storage write leaves the validated v1 ledger authoritative', async () => {
  const original = v1Ledger();
  const storage = createStorage(original, { failSet: true });
  await expect(activateManagedDevelopmentLifecycle({
    storageApi: storage,
    commandApi: migrationCommands(),
  })).rejects.toThrow('simulated lifecycle storage failure');
  expect(storage.data[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]).toEqual(original);
});

test('fresh present transition creates only bounded pending intent at revision zero', () => {
  const ledger = { schemaVersion: 2, mode: WORKBENCH_MANAGED_STATE_MODE, entries: [] };
  const plan = planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest(),
    identity: IDENTITY,
  });
  expect(plan.kind).toBe('begin');
  expect(plan.entry).toEqual({
    artifactIdentity: 'controlled-fixture',
    name: NAME,
    namespace: NAMESPACE,
    committed: null,
    pending: {
      artifactSha256: DIGEST_A,
      desiredState: 'present-enabled',
      fromRevision: null,
      targetRevision: 0,
    },
  });
  expect(ledger.entries).toHaveLength(0);
});

test('fresh absent or revisioned fresh ownership attempts fail closed', () => {
  const ledger = { schemaVersion: 2, mode: WORKBENCH_MANAGED_STATE_MODE, entries: [] };
  expect(() => planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest({ desiredState: 'absent' }),
    identity: IDENTITY,
  })).toThrow(/absent/i);
  expect(() => planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest({ expectedManagedRevision: 0 }),
    identity: IDENTITY,
  })).toThrow(/expectedManagedRevision=null/i);
});

test('first successful present transition finalizes revision zero idempotently', () => {
  const start = { schemaVersion: 2, mode: WORKBENCH_MANAGED_STATE_MODE, entries: [] };
  const plan = planManagedDevelopmentTransition({
    ledger: start, request: lifecycleRequest(), identity: IDENTITY,
  });
  const finalized = finalizeManagedDevelopmentTransition({
    ledger: plan.ledger,
    artifactIdentity: 'controlled-fixture',
    desiredState: 'present-enabled',
    artifactSha256: DIGEST_A,
    scriptId: 7,
  });
  expect(finalized.entries[0].committed).toEqual({
    artifactSha256: DIGEST_A,
    scriptId: 7,
    desiredState: 'present-enabled',
    managedRevision: 0,
  });
  expect(finalized.entries[0].pending).toBeNull();
  expect(finalizeManagedDevelopmentTransition({
    ledger: finalized,
    artifactIdentity: 'controlled-fixture',
    desiredState: 'present-enabled',
    artifactSha256: DIGEST_A,
    scriptId: 7,
  })).toEqual(finalized);
});

test('exact committed replay is revision-neutral even with a stale expected revision', () => {
  const ledger = committedLedger({ revision: 4 });
  const plan = planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest({ expectedManagedRevision: 1 }),
    identity: IDENTITY,
  });
  expect(plan.kind).toBe('replay');
  expect(plan.ledger).toEqual(ledger);
  expect(plan.entry.committed.managedRevision).toBe(4);
});

test('different transition requires current revision and persists one-step pending intent', () => {
  const ledger = committedLedger();
  expect(() => planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest({
      desiredState: 'present-disabled', expectedManagedRevision: 9,
    }),
    identity: IDENTITY,
  })).toThrow(/revision precondition/i);

  const plan = planManagedDevelopmentTransition({
    ledger,
    request: lifecycleRequest({
      desiredState: 'present-disabled', expectedManagedRevision: 0,
    }),
    identity: IDENTITY,
  });
  expect(plan.kind).toBe('begin');
  expect(plan.entry.pending).toEqual({
    artifactSha256: DIGEST_A,
    desiredState: 'present-disabled',
    fromRevision: 0,
    targetRevision: 1,
  });
});

test('identical pending transition recovers while different pending intent fails closed', () => {
  const first = planManagedDevelopmentTransition({
    ledger: committedLedger(),
    request: lifecycleRequest({ desiredState: 'present-disabled', expectedManagedRevision: 0 }),
    identity: IDENTITY,
  });
  const retry = planManagedDevelopmentTransition({
    ledger: first.ledger,
    request: lifecycleRequest({ desiredState: 'present-disabled', expectedManagedRevision: 0 }),
    identity: IDENTITY,
  });
  expect(retry.kind).toBe('recover');
  expect(retry.ledger).toEqual(first.ledger);

  expect(() => planManagedDevelopmentTransition({
    ledger: first.ledger,
    request: lifecycleRequest({ desiredState: 'absent', expectedManagedRevision: 0 }),
    identity: IDENTITY,
  })).toThrow(/different.*pending/i);
});

test('absent creates a digest-bound tombstone and blocks stale recreation', () => {
  const enabled = committedLedger({ revision: 1 });
  expect(() => planManagedDevelopmentTransition({
    ledger: enabled,
    request: lifecycleRequest({
      desiredState: 'absent', digest: DIGEST_B, expectedManagedRevision: 1,
    }),
    identity: IDENTITY,
  })).toThrow(/currently committed artifact digest/i);

  const absentPlan = planManagedDevelopmentTransition({
    ledger: enabled,
    request: lifecycleRequest({ desiredState: 'absent', expectedManagedRevision: 1 }),
    identity: IDENTITY,
  });
  const tombstone = finalizeManagedDevelopmentTransition({
    ledger: absentPlan.ledger,
    artifactIdentity: 'controlled-fixture',
    desiredState: 'absent',
    artifactSha256: DIGEST_A,
    scriptId: null,
  });
  expect(tombstone.entries[0].committed).toEqual({
    artifactSha256: DIGEST_A,
    scriptId: null,
    desiredState: 'absent',
    managedRevision: 2,
  });

  const repeat = planManagedDevelopmentTransition({
    ledger: tombstone,
    request: lifecycleRequest({ desiredState: 'absent', expectedManagedRevision: 0 }),
    identity: IDENTITY,
  });
  expect(repeat.kind).toBe('replay');
  expect(repeat.entry.committed.managedRevision).toBe(2);

  expect(() => planManagedDevelopmentTransition({
    ledger: tombstone,
    request: lifecycleRequest({ desiredState: 'present-enabled', expectedManagedRevision: 1 }),
    identity: IDENTITY,
  })).toThrow(/revision precondition/i);

  const recreate = planManagedDevelopmentTransition({
    ledger: tombstone,
    request: lifecycleRequest({
      desiredState: 'present-enabled', digest: DIGEST_B, expectedManagedRevision: 2,
    }),
    identity: IDENTITY,
  });
  expect(recreate.entry.pending).toEqual({
    artifactSha256: DIGEST_B,
    desiredState: 'present-enabled',
    fromRevision: 2,
    targetRevision: 3,
  });
});

test('malformed v2 ledgers and finalization mismatches fail closed', async () => {
  const duplicate = committedLedger();
  duplicate.entries.push(clone(duplicate.entries[0]));
  expect(() => validateManagedDevelopmentLifecycleLedger(duplicate))
  .toThrow(/duplicate/i);

  const badPending = committedLedger();
  badPending.entries[0].pending = {
    artifactSha256: DIGEST_A,
    desiredState: 'present-disabled',
    fromRevision: 0,
    targetRevision: 9,
  };
  expect(() => validateManagedDevelopmentLifecycleLedger(badPending))
  .toThrow(/revision boundary/i);

  await expect(persistManagedDevelopmentLifecycleLedger(
    createStorage(), badPending,
  )).rejects.toBeInstanceOf(ManagedArtifactLifecycleError);

  const pending = planManagedDevelopmentTransition({
    ledger: committedLedger(),
    request: lifecycleRequest({ desiredState: 'present-disabled', expectedManagedRevision: 0 }),
    identity: IDENTITY,
  }).ledger;
  expect(() => finalizeManagedDevelopmentTransition({
    ledger: pending,
    artifactIdentity: 'controlled-fixture',
    desiredState: 'absent',
    artifactSha256: DIGEST_A,
    scriptId: null,
  })).toThrow(/does not match/i);
});
