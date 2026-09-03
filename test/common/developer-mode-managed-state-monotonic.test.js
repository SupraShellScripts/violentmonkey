import {
  finalizeManagedDevelopmentTransition,
  persistManagedDevelopmentLifecycleLedger,
  planManagedDevelopmentTransition,
  readManagedDevelopmentLifecycleLedger,
  WORKBENCH_MANAGED_STATE_MODE,
  WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
} from '@/common/developer-mode-managed-state';
import { WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY } from '@/common/developer-mode-managed-artifacts';

const NAME = 'Controlled Fixture';
const NAMESPACE = 'https://suprashellscripts.github/workbench';
const IDENTITY = { name: NAME, namespace: NAMESPACE };
const ARTIFACT_IDENTITY = 'controlled-fixture';
const DIGEST = 'a'.repeat(64);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function committedLedger({
  desiredState = 'present-enabled', revision = 2, scriptId = 7,
} = {}) {
  return {
    schemaVersion: WORKBENCH_MANAGED_STATE_SCHEMA_VERSION,
    mode: WORKBENCH_MANAGED_STATE_MODE,
    entries: [{
      artifactIdentity: ARTIFACT_IDENTITY,
      name: NAME,
      namespace: NAMESPACE,
      committed: {
        artifactSha256: DIGEST,
        scriptId: desiredState === 'absent' ? null : scriptId,
        desiredState,
        managedRevision: revision,
      },
      pending: null,
    }],
  };
}

function request(desiredState, expectedManagedRevision) {
  return {
    artifact: { identity: ARTIFACT_IDENTITY, sha256: DIGEST },
    desiredState,
    expectedManagedRevision,
  };
}

function createStorage(initial) {
  let data = clone(initial);
  let staleRead = null;
  let failSet = false;
  let getCount = 0;
  return {
    get getCount() { return getCount; },
    set staleRead(value) { staleRead = clone(value); },
    set failSet(value) { failSet = Boolean(value); },
    get data() { return clone(data); },
    async get(keys) {
      getCount += 1;
      const value = staleRead || data;
      return Object.fromEntries(keys.map(key => [key, clone(value)]));
    },
    async set(values) {
      if (failSet) throw new Error('simulated lifecycle storage failure');
      data = clone(values[WORKBENCH_MANAGED_ARTIFACTS_STORAGE_KEY]);
    },
  };
}

it('keeps the session ledger monotonic when durable storage later returns an older pending value', async () => {
  const storage = createStorage(committedLedger());
  const initial = await readManagedDevelopmentLifecycleLedger(storage);
  expect(storage.getCount).toBe(1);

  const absentPlan = planManagedDevelopmentTransition({
    ledger: initial,
    request: request('absent', 2),
    identity: IDENTITY,
  });
  expect(absentPlan.entry.pending).toMatchObject({
    desiredState: 'absent',
    fromRevision: 2,
    targetRevision: 3,
  });
  await persistManagedDevelopmentLifecycleLedger(storage, absentPlan.ledger);

  const tombstone = finalizeManagedDevelopmentTransition({
    ledger: absentPlan.ledger,
    artifactIdentity: ARTIFACT_IDENTITY,
    desiredState: 'absent',
    artifactSha256: DIGEST,
    scriptId: null,
  });
  await persistManagedDevelopmentLifecycleLedger(storage, tombstone);

  // Reproduce the Firefox observation from issue #90: a later get() can
  // expose the earlier pending snapshot even after the final set resolved.
  storage.staleRead = absentPlan.ledger;
  const observed = await readManagedDevelopmentLifecycleLedger(storage);
  expect(storage.getCount).toBe(1);
  expect(observed).toEqual(tombstone);
  expect(observed.entries[0]).toMatchObject({
    committed: {
      desiredState: 'absent',
      managedRevision: 3,
      scriptId: null,
    },
    pending: null,
  });

  const replay = planManagedDevelopmentTransition({
    ledger: observed,
    request: request('absent', null),
    identity: IDENTITY,
  });
  expect(replay.kind).toBe('replay');
  expect(replay.entry.committed.managedRevision).toBe(3);
});

it('does not advance the session ledger when the durable write fails', async () => {
  const storage = createStorage(committedLedger());
  const initial = await readManagedDevelopmentLifecycleLedger(storage);
  const pending = planManagedDevelopmentTransition({
    ledger: initial,
    request: request('present-disabled', 2),
    identity: IDENTITY,
  }).ledger;

  storage.failSet = true;
  await expect(persistManagedDevelopmentLifecycleLedger(storage, pending))
  .rejects.toThrow('simulated lifecycle storage failure');

  const observed = await readManagedDevelopmentLifecycleLedger(storage);
  expect(storage.getCount).toBe(1);
  expect(observed).toEqual(initial);
  expect(observed.entries[0].pending).toBeNull();
  expect(observed.entries[0].committed.managedRevision).toBe(2);
});
