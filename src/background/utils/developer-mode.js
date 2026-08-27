import browser from '@/common/browser';
import { createDeveloperModeStatus } from '@/common/developer-mode';
import { kDeveloperMode } from '@/common/options-defaults';
import { addOwnCommands } from './init';
import { getOption } from './options';

addOwnCommands({
  GetDeveloperModeStatus() {
    const manifest = browser.runtime.getManifest();
    return createDeveloperModeStatus({
      enabled: getOption(kDeveloperMode),
      extensionVersion: manifest.version,
      manifestVersion: manifest.manifest_version,
    });
  },
});
