const fs = require('fs');
const yaml = require('js-yaml');
const {
  CHROMIUM_EXTENSION_ID,
  CHROMIUM_PUBLIC_KEY,
  FIREFOX_DEV_ID,
  WORKBENCH_DEV_NAME,
  applyWorkbenchDevIdentity,
  deriveChromiumExtensionId,
  getWorkbenchDevBrowser,
} = require('../../scripts/workbench-dev-identity');

const UPSTREAM_FIREFOX_ID = '{aecec67f-0d10-4fa7-b7c7-609a2db280cf}';

function withBuildEnvironment(values, callback) {
  const names = ['MV3', 'VMWB_DEV_IDENTITY', 'VMWB_DEV_BROWSER'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    names.forEach(name => delete process.env[name]);
    Object.entries(values).forEach(([name, value]) => {
      process.env[name] = value;
    });
    jest.resetModules();
    return callback(require('../../scripts/manifest-helper'));
  } finally {
    names.forEach(name => {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    });
    jest.resetModules();
  }
}

test('pinned Chromium public key deterministically derives the Workbench extension ID', () => {
  expect(deriveChromiumExtensionId(CHROMIUM_PUBLIC_KEY)).toBe(CHROMIUM_EXTENSION_ID);
  expect(CHROMIUM_EXTENSION_ID).toBe('mlooodbpjdohbedafmodnmelbmdgmngk');
  expect(CHROMIUM_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
});

test('development identity is fail-closed and requires an explicit browser', () => {
  expect(getWorkbenchDevBrowser({})).toBeNull();
  expect(() => getWorkbenchDevBrowser({ VMWB_DEV_IDENTITY: '1' }))
  .toThrow(/must be firefox or chromium/);
  expect(() => getWorkbenchDevBrowser({
    VMWB_DEV_IDENTITY: '1',
    VMWB_DEV_BROWSER: 'edge',
  })).toThrow(/must be firefox or chromium/);
});

test('Firefox development identity replaces only the development artifact identity', () => {
  const manifest = {
    name: '__MSG_extName__',
    browser_action: { default_title: '__MSG_extName__' },
    key: 'foreign-key',
    browser_specific_settings: {
      gecko: {
        id: UPSTREAM_FIREFOX_ID,
        strict_min_version: '68.0',
      },
    },
  };
  applyWorkbenchDevIdentity(manifest, 'firefox');
  expect(manifest.name).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.browser_action.default_title).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.browser_specific_settings.gecko.id).toBe(FIREFOX_DEV_ID);
  expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe('68.0');
  expect(manifest.key).toBeUndefined();
});

test('Chromium development identity removes Firefox authority and pins the public key', () => {
  const manifest = {
    name: '__MSG_extName__',
    action: { default_title: '__MSG_extName__' },
    browser_specific_settings: { gecko: { id: UPSTREAM_FIREFOX_ID } },
  };
  applyWorkbenchDevIdentity(manifest, 'chromium');
  expect(manifest.name).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.action.default_title).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.key).toBe(CHROMIUM_PUBLIC_KEY);
  expect(manifest.browser_specific_settings).toBeUndefined();
});

test('ordinary build manifest retains the upstream Firefox identity', () => {
  const manifest = withBuildEnvironment({}, ({ buildManifest }) => buildManifest());
  expect(manifest.browser_specific_settings.gecko.id).toBe(UPSTREAM_FIREFOX_ID);
  expect(manifest.key).toBeUndefined();
});

test('Firefox Workbench build manifest gets the standalone development identity', () => {
  const manifest = withBuildEnvironment({
    VMWB_DEV_IDENTITY: '1',
    VMWB_DEV_BROWSER: 'firefox',
  }, ({ buildManifest }) => buildManifest());
  expect(manifest.name).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.browser_specific_settings.gecko.id).toBe(FIREFOX_DEV_ID);
  expect(manifest.key).toBeUndefined();
});

test('Chromium MV3 Workbench build manifest gets the deterministic development ID key', () => {
  const manifest = withBuildEnvironment({
    MV3: '1',
    VMWB_DEV_IDENTITY: '1',
    VMWB_DEV_BROWSER: 'chromium',
  }, ({ buildManifest }) => buildManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.name).toBe(WORKBENCH_DEV_NAME);
  expect(manifest.key).toBe(CHROMIUM_PUBLIC_KEY);
  expect(manifest.browser_specific_settings).toBeUndefined();
});

test('canonical source manifest remains upstream-compatible', () => {
  const source = yaml.load(fs.readFileSync('src/manifest.yml', 'utf8'));
  expect(source.browser_specific_settings.gecko.id).toBe(UPSTREAM_FIREFOX_ID);
  expect(source.key).toBeUndefined();
});
