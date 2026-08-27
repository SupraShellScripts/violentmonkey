import {
  CONTROLLED_RECONCILE_OPERATION,
  CONTROLLED_RUNTIME_OPERATION,
  createHandshakeRequest,
  DEVELOPER_MODE_HANDSHAKE,
  DEVELOPER_MODE_HOST,
  negotiateCapabilities,
  validateHandshakeResponse,
} from '@/common/developer-mode-transport';

test('handshake request targets one fixed native host contract', () => {
  expect(DEVELOPER_MODE_HOST).toBe(
    'io.github.suprashellscripts.violentmonkey_workbench');
  expect(createHandshakeRequest('2.46.0')).toEqual({
    schemaVersion: 1,
    operation: DEVELOPER_MODE_HANDSHAKE,
    client: { name: 'violentmonkey', version: '2.46.0' },
    requestedCapabilities: [
      CONTROLLED_RECONCILE_OPERATION,
      CONTROLLED_RUNTIME_OPERATION,
    ],
  });
});

test('valid handshake establishes a copied capability session', () => {
  const source = {
    schemaVersion: 1,
    operation: DEVELOPER_MODE_HANDSHAKE,
    host: { name: 'violentmonkey-workbench', version: '0.1.0' },
    sessionId: 'ephemeral-session',
    capabilities: [CONTROLLED_RECONCILE_OPERATION],
  };
  const result = validateHandshakeResponse(source);
  expect(result).toEqual({
    host: source.host,
    sessionId: 'ephemeral-session',
    capabilities: [CONTROLLED_RECONCILE_OPERATION],
  });
  expect(result.capabilities).not.toBe(source.capabilities);
});

test('capability negotiation cannot widen requested authority', () => {
  expect(negotiateCapabilities(
    [CONTROLLED_RECONCILE_OPERATION, CONTROLLED_RUNTIME_OPERATION],
    ['unrequested.operation', CONTROLLED_RECONCILE_OPERATION,
      CONTROLLED_RECONCILE_OPERATION],
  )).toEqual([CONTROLLED_RECONCILE_OPERATION]);
  expect(negotiateCapabilities(
    [CONTROLLED_RECONCILE_OPERATION, CONTROLLED_RUNTIME_OPERATION],
    ['unrequested.operation'],
  )).toEqual([]);
  expect(negotiateCapabilities(
    [CONTROLLED_RECONCILE_OPERATION],
    [CONTROLLED_RUNTIME_OPERATION],
  )).toEqual([]);
});

test.each([
  null,
  {},
  { schemaVersion: 2, operation: DEVELOPER_MODE_HANDSHAKE },
  {
    schemaVersion: 1,
    operation: DEVELOPER_MODE_HANDSHAKE,
    host: { name: 'unexpected-host', version: '0.1.0' },
    sessionId: 'session',
    capabilities: [],
  },
  {
    schemaVersion: 1,
    operation: DEVELOPER_MODE_HANDSHAKE,
    host: { name: 'violentmonkey-workbench', version: '0.1.0' },
    sessionId: '',
    capabilities: [],
  },
  {
    schemaVersion: 1,
    operation: DEVELOPER_MODE_HANDSHAKE,
    host: { name: 'violentmonkey-workbench', version: '0.1.0' },
    sessionId: 'session',
    capabilities: [7],
  },
])('malformed or incompatible handshake fails closed: %#', response => {
  expect(() => validateHandshakeResponse(response)).toThrow();
});
