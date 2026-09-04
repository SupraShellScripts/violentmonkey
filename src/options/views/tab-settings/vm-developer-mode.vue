<template>
  <section class="developer-mode mb-1c">
    <h3 v-text="i18n('labelDeveloperMode')" />
    <tooltip :content="i18n('labelDeveloperModeHint')" align="start">
      <setting-check :name="kDeveloperMode" :label="i18n('labelDeveloperModeEnable')" />
    </tooltip>
    <div class="ml-2c actions">
      <button :disabled="busy" v-text="i18n('buttonDeveloperModeConnect')"
              @click="run('ConnectDeveloperMode')" />
      <button :disabled="busy" v-text="i18n('buttonDeveloperModeDisconnect')"
              @click="run('DisconnectDeveloperMode')" />
      <button :disabled="busy" v-text="i18n('buttonDeveloperModeRefresh')"
              @click="refresh" />
    </div>
    <div class="ml-2c status" v-if="status">
      <span>
        {{ i18n('labelDeveloperModeTransport') }}
        <code>{{ status.transport.connected ? 'connected' : 'disconnected' }}</code>
      </span>
      <span v-if="status.transport.hostVersion">
        {{ i18n('labelDeveloperModeHostVersion') }}
        <code>{{ status.transport.hostVersion }}</code>
      </span>
      <span v-if="status.transport.sessionId">
        {{ i18n('labelDeveloperModeSession') }}
        <code>{{ status.transport.sessionId }}</code>
      </span>
      <span>
        {{ i18n('labelDeveloperModeRuntime') }}
        <code>{{ mutationMode(status) }}</code>
      </span>
      <span class="error" v-if="error || status.transport.error">
        {{ error || status.transport.error }}
      </span>
      <span class="limitation" v-text="status.limitation" />
    </div>
  </section>
</template>

<script setup>
import { i18n, sendCmdDirectly } from '@/common';
import { onMounted, ref } from 'vue';
import { kDeveloperMode } from '@/common/options-defaults';
import SettingCheck from '@/common/ui/setting-check';
import Tooltip from 'vueleton/lib/tooltip';

const busy = ref(false);
const error = ref('');
const status = ref();

onMounted(refresh);

function mutationMode(value) {
  if (value?.developmentState?.available) return 'lifecycle';
  if (value?.controlledReconcile?.available) return 'reconcile';
  return 'unavailable';
}

async function refresh() {
  return run('GetDeveloperModeStatus');
}

async function run(command) {
  busy.value = true;
  error.value = '';
  try {
    status.value = await sendCmdDirectly(command);
  } catch (err) {
    error.value = String(err?.message || err);
    status.value = await sendCmdDirectly('GetDeveloperModeStatus').catch(() => status.value);
  } finally {
    busy.value = false;
  }
}
</script>

<style>
.developer-mode {
  .actions {
    display: flex;
    gap: .5em;
    margin-top: .5em;
  }
  .status {
    display: flex;
    flex-direction: column;
    margin-top: .5em;
  }
  .error {
    color: var(--fg-error);
  }
  .limitation {
    opacity: .8;
  }
}
</style>
