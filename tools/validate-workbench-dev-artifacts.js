#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  CHROMIUM_EXTENSION_ID,
  CHROMIUM_PUBLIC_KEY,
  FIREFOX_DEV_ID,
  WORKBENCH_DEV_NAME,
  deriveChromiumExtensionId,
} = require('../scripts/workbench-dev-identity');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const firefox = readJson('dist/manifest.json');
assert(
  firefox.name === WORKBENCH_DEV_NAME,
  `Firefox development artifact has wrong name: ${firefox.name}`,
);
assert(
  firefox.browser_specific_settings?.gecko?.id === FIREFOX_DEV_ID,
  `Firefox development artifact has wrong ID: ${firefox.browser_specific_settings?.gecko?.id}`,
);
assert(
  firefox.key == null,
  'Firefox development artifact must not contain a Chromium manifest key.',
);
assert(
  firefox.permissions?.includes('nativeMessaging'),
  'Firefox development artifact must retain nativeMessaging permission.',
);

const chromium = readJson('dist-mv3/manifest.json');
assert(
  chromium.manifest_version === 3,
  `Chromium development artifact must be MV3, found ${chromium.manifest_version}`,
);
assert(
  chromium.name === WORKBENCH_DEV_NAME,
  `Chromium development artifact has wrong name: ${chromium.name}`,
);
assert(
  chromium.key === CHROMIUM_PUBLIC_KEY,
  'Chromium development artifact does not contain the pinned public manifest key.',
);
assert(
  chromium.browser_specific_settings == null,
  'Chromium development artifact must not retain Firefox browser_specific_settings.',
);
assert(
  chromium.permissions?.includes('nativeMessaging'),
  'Chromium development artifact must retain nativeMessaging permission.',
);
assert(
  deriveChromiumExtensionId(chromium.key) === CHROMIUM_EXTENSION_ID,
  'Chromium development artifact public key does not derive the pinned extension ID.',
);

const evidence = {
  schemaVersion: 1,
  status: 'success',
  firefox: {
    manifestVersion: firefox.manifest_version,
    extensionId: FIREFOX_DEV_ID,
    name: firefox.name,
  },
  chromium: {
    manifestVersion: chromium.manifest_version,
    extensionId: CHROMIUM_EXTENSION_ID,
    name: chromium.name,
  },
};

fs.writeFileSync(
  'dist/workbench-identity.json',
  `${JSON.stringify(evidence, null, 2)}\n`,
);
fs.writeFileSync(
  'dist-mv3/workbench-identity.json',
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence));
