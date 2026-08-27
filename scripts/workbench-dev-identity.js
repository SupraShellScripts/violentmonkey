const crypto = require('crypto');

const WORKBENCH_DEV_ENV = 'VMWB_DEV_IDENTITY';
const WORKBENCH_DEV_BROWSER_ENV = 'VMWB_DEV_BROWSER';
const WORKBENCH_DEV_NAME = 'Violentmonkey Workbench Dev';
const FIREFOX_DEV_ID = 'violentmonkey-workbench-dev@suprashellscripts.github';

// Public SPKI only. No private key material is required or retained for
// deterministic unpacked-development identity.
const CHROMIUM_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAiYt6e9lgHyTp9hRRQkVVQHDxDtImxg51FQji5b3qixMLqtO6TIBLpGy2yVqH073477+ppHrLjzEW19A19hhiXJb6bpuQ01QaO/XeYbuDP41jmCWt4gfiPUUDkUgNCP2ZX2AM/st5WsGXcNp/FtTwgAU6PxW3UczGjRLUm48vH1NXsPKqhj/x2m9SvAx9d/wUQUkrfS5Wk+DI4+dZMr3RsSk1Iarbpw4oo1deuF4t4c7d4gabl2OwV3Ng9/xSQBcFZQ4RpdE/Z0TXQrp1ZxbmNwPajO/MxZoOyIROKs/VjqvkbSZz0HoScIkRw+15XCNZFPaiEFpZsYfo0js5N1xbpQIDAQAB';
const EXPECTED_CHROMIUM_EXTENSION_ID = 'mlooodbpjdohbedafmodnmelbmdgmngk';

function deriveChromiumExtensionId(publicKeyBase64) {
  const publicKey = Buffer.from(publicKeyBase64, 'base64');
  if (!publicKey.length || publicKey.toString('base64') !== publicKeyBase64) {
    throw new Error('Workbench Chromium development key must be canonical base64.');
  }
  const digest = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...digest].map(byte => {
    const high = String.fromCharCode(97 + (byte >> 4));
    const low = String.fromCharCode(97 + (byte & 0x0f));
    return high + low;
  }).join('');
}

const CHROMIUM_EXTENSION_ID = deriveChromiumExtensionId(CHROMIUM_PUBLIC_KEY);
if (CHROMIUM_EXTENSION_ID !== EXPECTED_CHROMIUM_EXTENSION_ID) {
  throw new Error('Workbench Chromium development identity does not match its pinned public key.');
}

function getWorkbenchDevBrowser(env = process.env) {
  if (env[WORKBENCH_DEV_ENV] !== '1') return null;
  const browser = env[WORKBENCH_DEV_BROWSER_ENV];
  if (browser !== 'firefox' && browser !== 'chromium') {
    throw new Error(`${WORKBENCH_DEV_BROWSER_ENV} must be firefox or chromium when ${WORKBENCH_DEV_ENV}=1.`);
  }
  return browser;
}

function applyWorkbenchDevIdentity(manifest, browser) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Workbench development identity requires a manifest object.');
  }
  manifest.name = WORKBENCH_DEV_NAME;
  const action = manifest.action || manifest.browser_action;
  if (action) action.default_title = WORKBENCH_DEV_NAME;

  if (browser === 'firefox') {
    const gecko = manifest.browser_specific_settings?.gecko;
    if (!gecko) {
      throw new Error('Firefox Workbench development build requires browser_specific_settings.gecko.');
    }
    gecko.id = FIREFOX_DEV_ID;
    delete manifest.key;
  } else if (browser === 'chromium') {
    manifest.key = CHROMIUM_PUBLIC_KEY;
    delete manifest.browser_specific_settings;
  } else {
    throw new Error(`Unsupported Workbench development browser: ${browser}`);
  }
  return manifest;
}

exports.WORKBENCH_DEV_ENV = WORKBENCH_DEV_ENV;
exports.WORKBENCH_DEV_BROWSER_ENV = WORKBENCH_DEV_BROWSER_ENV;
exports.WORKBENCH_DEV_NAME = WORKBENCH_DEV_NAME;
exports.FIREFOX_DEV_ID = FIREFOX_DEV_ID;
exports.CHROMIUM_PUBLIC_KEY = CHROMIUM_PUBLIC_KEY;
exports.CHROMIUM_EXTENSION_ID = CHROMIUM_EXTENSION_ID;
exports.deriveChromiumExtensionId = deriveChromiumExtensionId;
exports.getWorkbenchDevBrowser = getWorkbenchDevBrowser;
exports.applyWorkbenchDevIdentity = applyWorkbenchDevIdentity;
