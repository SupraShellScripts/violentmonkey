import {
  dataUri2text, getScriptHome, getScriptName, getScriptPrettyUrl, getScriptRunAt, getScriptsTags,
  getScriptUpdateUrl, i18n, ignoreChromeErrors, isDataUri, isRemote, isValidHttpUrl,
  makePause, trueJoin,
} from '@/common';
import {
  CACHE_KEYS, FETCH_OPTS, INFERRED, kDownloads, kTag, PROMISE, REQ_KEYS, TIMEOUT_24HOURS,
  TIMEOUT_WEEK, TL_AWAIT, VALUE_IDS,
} from '@/common/consts';
import { deepSize, forEachEntry, forEachKey, forEachValue } from '@/common/object';
import { isGmStorageGranted } from '@/common/script';
import pluginEvents from '../plugin/events';
import broadcast from './broadcast';
import {
  aliveScripts, getDefaultCustom, getNameURI, inferScriptProps, newScript, parseMeta,
  removedScripts, scriptMap, scriptSiteVisited,
} from './script';
import { testBlacklist, testerBatch, testScript } from './tester';
import { getImageData } from './icon';
import { addOwnCommands, addPublicCommands, commands, resolveInit } from './init';
import { installedOver, NEW_INSTALL } from './on-installed';
import patchDB from './patch-db';
import { permissionDownloads } from './permissions';
import { initOptions, kVersion, setOption } from './options';
import sessionData, { flushSession, kScriptSizes, scriptSizes } from './session-data';
import storage, {
  S_CACHE, S_CODE, S_REQUIRE, S_SCRIPT, S_VALUE,
  S_CACHE_PRE, S_CODE_PRE, S_MOD_PRE, S_REQUIRE_PRE, S_SCRIPT_PRE, S_VALUE_PRE,
  getStorageKeys,
} from './storage';
import { storageCacheHas } from './storage-cache';
import { reloadTabForScript } from './tabs';
import { vetUrl } from './url';

let maxScriptId = 0;
let maxScriptPosition = 0;
/** @type {Map<string,number>} */
export let dbKeys = new Map(); // 1: exists, 0: known to be absent
/** Ensuring slow icons don't prevent installation/update */
const ICON_TIMEOUT = 1000;
export const kTryVacuuming = 'Try vacuuming database in options.';
/** Same order as in SIZE_TITLES and getSizes */
export const sizesPrefixRe = RegExp(
  `^(${S_CODE_PRE}|${S_SCRIPT_PRE}|${S_VALUE_PRE}|${S_REQUIRE_PRE}|${S_CACHE_PRE}${S_MOD_PRE})`);
/** @type {{ [type: 'cache' | 'require']: { [url: string]: Promise<?> } }} */
const pendingDeps = { [S_CACHE]: {}, [S_REQUIRE]: {} };
const depsPorts = {};

addPublicCommands({
  GetScriptVer(opts) {
    const script = getScript(opts);
    return script
      ? script.meta.version
      : null;
  },
});

addOwnCommands({
  CheckPosition: sortScripts,
  CheckRemove: checkRemove,
  RemoveScripts: removeScripts,
  GetData: getData,
  GetMoreIds({ url, [kTop]: isTop, [IDS]: ids }) {
    return getScriptsByURL(url, isTop, null, ids);
  },
  /** @return {VMScript} */
  GetScript: getScript,
  GetSizes: getSizes,
  /** @return {Promise<{ items: VMScript[], values? }>} */
  async ExportZip({ values }) {
    const scripts = getScripts();
    const ids = scripts.map(getPropsId);
    const codeMap = await storage[S_CODE].getMulti(ids);
    return {
      items: scripts.map(script => ({ script, code: codeMap[script.props.id] })),
      values: values ? await storage[S_VALUE].getMulti(ids) : undefined,
    };
  },
  /** @return {Promise<string>} */
  GetScriptCode(id) {
    return storage[S_CODE][Array.isArray(id) ? 'getMulti' : 'getOne'](id);
  },
  GetTags: () => getScriptsTags(aliveScripts),
  /** @return {Promise<void>} */
  async MarkRemoved({ id, removed }) {
    if (!removed) {
      const script = getScriptById(id);
      const conflict = getScript({ meta: script.meta });
      if (conflict) throw i18n('msgNamespaceConflictRestore');
    }
    await updateScriptInfo(id, {
      config: { removed: removed ? 1 : 0 },
      props: { lastModified: Date.now() },
    });
    const list = removed ? aliveScripts : removedScripts;
    const i = list.findIndex(script => script.props.id === id);
    const [script] = list.splice(i, 1);
    (removed ? removedScripts : aliveScripts).push(script);
  },
  /** @return {Promise<number>} */
  Move({ id, offset }) {
    const script = getScriptById(id);
    const index = aliveScripts.indexOf(script);
    aliveScripts.splice(index, 1);
    aliveScripts.splice(index + offset, 0, script);
    return normalizePosition();
  },
  ParseMeta: parseMetaWithErrors,
  ParseMetaErrors: data => parseMetaWithErrors(data).errors,
  ParseScript: parseScript,
  /** @return {Promise<void>} */
  UpdateScriptInfo({ id, config, custom }) {
    return updateScriptInfo(id, {
      config,
      custom,
      props: { lastModified: Date.now() },
    });
  },
  /** @return {Promise<number>} */
  Vacuum: vacuum,
});

export async function initializeDatabase(reset) {
  if (reset) {
    maxScriptId = 0;
    maxScriptPosition = 0;
    dbKeys.clear();
    aliveScripts.length = 0;
    removedScripts.length = 0;
    scriptSizes = {}; // eslint-disable-line no-import-assign
    for (const key in scriptMap) delete scriptMap[key];
    for (const key in scriptSiteVisited) delete scriptSiteVisited[key];
  }
  /** @type {string[]} */
  let keys;
  let [allKeys, data] = await Promise.all([
    getStorageKeys?.(),
    !getStorageKeys && storage.api.get(),
    sessionData,
  ]);
  if (allKeys) {
    keys = allKeys.join('\n').replace(/^(?:(options|version|(?:scr|mod):\d+)|\S+)$/gm, '$1').trim();
    dbKeys = new Map(JSON.parse(`[${keys.replace(/\S+/g, '["$&",1],').slice(0, -1)}]`));
    keys = keys.split(/\n+/);
    data = await storage.api.get(keys);
  }
  if (installedOver === NEW_INSTALL) await patchDB();
  if (installedOver) storage.api.set({ [kVersion]: __.VM_VER });
  const uriMap = {};
  const defaultCustom = getDefaultCustom();
  data::forEachEntry(([key, script]) => {
    const id = +storage[S_SCRIPT].toId(key);
    if (id && script) {
      const uri = getNameURI(script);
      if (!script.config.removed) {
        if (scriptMap[id] && scriptMap[id] !== script) return;
        if (uriMap[uri]) return;
        uriMap[uri] = script;
      }
      script.props = { ...script.props, id, uri };
      const custom = script.custom = { ...defaultCustom, ...script.custom };
      const { pathMap, tags } = custom;
      const meta = script.meta ||= {};
      const tag = meta[kTag];
      if (tags) {
        custom[kTag] = tags.split(/\s+/);
        delete custom.tags;
      }
      if (tag && !Array.isArray(tag)) meta[kTag] = tag.split(/\s+/);
      if (pathMap) for (const url in pathMap) if (isDataUri(url)) delete pathMap[url];
      maxScriptId = Math.max(maxScriptId, id);
      maxScriptPosition = Math.max(maxScriptPosition, getInt(script.props.position));
      (script.config.removed ? removedScripts : aliveScripts).push(script);
      if (!meta.require) meta.require = [];
      if (!meta.resources) meta.resources = {};
      if (TL_AWAIT in meta) meta[TL_AWAIT] = true;
      meta.grant = [...new Set(meta.grant || [])];
    }
  });
  initOptions(data, installedOver, installedOver && installedOver !== NEW_INSTALL);
  if (__.DEBUG) {
    console.info('store:', {
      aliveScripts, removedScripts, maxScriptId, maxScriptPosition, scriptMap, scriptSizes,
    });
  }
  if (!__.MV3 || !sessionData.init) {
    if (allKeys?.length) {
      const set = new Set(keys);
      const data2 = await storage.api.get(allKeys.filter(k => !set.has(k)));
      Object.assign(data, data2);
    }
    vacuum(data);
    checkRemove();
    sortScripts();
  }
  if (!__.MV3) setInterval(checkRemove, TIMEOUT_24HOURS);
  resolveInit();
}

initializeDatabase();

/** @return {number} */
function getInt(val) {
  return +val || 0;
}

/** @return {?number} */
function getPropsId(script) {
  return script?.props.id;
}

/** @return {void} */
function updateLastModified() {
  setOption('lastModified', Date.now());
}

export async function normalizePosition() {
  const updates = aliveScripts.reduce((res, script, index) => {
    const { props } = script;
    const position = index + 1;
    if (props.position !== position) {
      props.position = position;
      (res || (res = {}))[props.id] = script;
    }
    return res;
  }, null);
  maxScriptPosition = aliveScripts.length;
  if (updates) {
    await storage[S_SCRIPT].set(updates);
    updateLastModified();
  }
  return !!updates;
}

export async function sortScripts() {
  const old = [...aliveScripts];
  aliveScripts.sort((a, b) => (a.props.position || 0) - (b.props.position || 0));
  if (await normalizePosition() || old.some((val, i) => val !== aliveScripts[i])) {
    broadcast('ScriptsUpdated');
    return true;
  }
}

export function getScriptById(id) {
  return scriptMap[id];
}

export function getScriptsByIdsOrAll(ids) {
  return ids?.map(getScriptById) ?? [...aliveScripts, ...removedScripts];
}

export function getScript({ id, uri, meta, removed }) {
  let script;
  if (id) {
    script = getScriptById(id);
  } else {
    if (!uri) uri = getNameURI({ meta, props: { id: '@@should-have-name' } });
    script = (removed ? removedScripts : aliveScripts).find(({ props }) => uri === props.uri);
  }
  return script;
}

export function getScripts() {
  return [...aliveScripts];
}

const makeEnv = () => ({ depsMap: {}, [RUN_AT]: {}, [SCRIPTS]: [] });
const STORAGE_ROUTES = {
  [S_CACHE]: CACHE_KEYS,
  [S_CODE]: IDS,
  [S_REQUIRE]: REQ_KEYS,
  [S_VALUE]: VALUE_IDS,
};
const STORAGE_ROUTES_ENTRIES = Object.entries(STORAGE_ROUTES);
const notifiedBadScripts = new Set();

export function getScriptsByURL(url, isTop, errors, prevIds) {
  if (testBlacklist(url)) return;
  const allIds = {};
  const isDelayed = !errors;
  let envStart;
  let envDelayed;
  let clipboardChecked = isDelayed || !IS_FIREFOX;
  testerBatch(errors || true);
  for (const script of aliveScripts) {
    const {
      config: { enabled }, custom, meta, props: { id },
    } = script;
    if ((prevIds ? id in prevIds : !enabled)
    || !((isTop || !(custom.noframes ?? meta.noframes)) && testScript(url, script))) continue;
    if (prevIds) {
      allIds[id] = enabled ? MORE : 0;
      continue;
    }
    allIds[id] = 1;
    if (!envStart) {
      envStart = makeEnv();
      envDelayed = makeEnv();
      for (const [areaName, listName] of STORAGE_ROUTES_ENTRIES) {
        envStart[areaName] = {}; envDelayed[areaName] = {};
        envStart[listName] = []; envDelayed[listName] = [];
      }
    }
    const { pathMap = buildPathMap(script) } = custom;
    const runAt = getScriptRunAt(script);
    const env = runAt === 'start' || runAt === 'body' ? envStart : envDelayed;
    const { depsMap } = env;
    env[IDS].push(id);
    env[RUN_AT][id] = runAt;
    if (isGmStorageGranted(meta)) env[VALUE_IDS].push(id);
    if (!clipboardChecked) {
      for (const g of meta.grant) {
        if (!clipboardChecked && (g === 'GM_setClipboard' || g === 'GM.setClipboard')) {
          clipboardChecked = envStart.clipFF = true;
        }
      }
    }
    for (const [list, name, dataUriDecoder] of [
      [meta.require, S_REQUIRE, dataUri2text],
      [Object.values(meta.resources), S_CACHE],
    ]) {
      const listName = STORAGE_ROUTES[name];
      const envCheck = name === S_CACHE ? envStart : env;
      for (let depUrl of list) {
        depUrl = pathMap[depUrl] || depUrl;
        if (depUrl) {
          if (isDataUri(depUrl)) {
            if (dataUriDecoder) env[name][depUrl] = dataUriDecoder(depUrl);
          } else if (!envCheck[listName].includes(depUrl)) {
            env[listName].push(depUrl);
            (depsMap[depUrl] || (depsMap[depUrl] = [])).push(id);
          }
        }
      }
    }
    env[SCRIPTS].push(script);
  }
  testerBatch();
  if (prevIds) return allIds;
  if (!envStart) return;
  if (isDelayed) {
    envDelayed[PROMISE] = readEnvironmentData(envDelayed);
    return envDelayed;
  }
  if (envStart[IDS].length) envStart[PROMISE] = readEnvironmentData(envStart);
  if (envDelayed[IDS].length) {
    envDelayed[PROMISE] = makePause().then(readEnvironmentData.bind(null, envDelayed));
  }
  return Object.assign(envStart, { allIds, [MORE]: envDelayed });
}

async function readEnvironmentData(env) {
  const keys = [];
  for (const [area, listName] of STORAGE_ROUTES_ENTRIES) {
    for (const id of env[listName]) keys.push(storage[area].toKey(id));
  }
  const data = await storage.api.get(keys);
  const badScripts = new Set();
  for (const [area, listName] of STORAGE_ROUTES_ENTRIES) {
    for (const id of env[listName]) {
      let val = data[storage[area].toKey(id)];
      if (!val && area === S_VALUE) val = {};
      env[area][id] = val;
      if (val == null) {
        if (area === S_CODE) badScripts.add(id);
        else env.depsMap[id]?.forEach(scriptId => badScripts.add(scriptId));
      }
    }
  }
  if (badScripts.size) reportBadScripts(badScripts);
  return env;
}

function reportBadScripts(ids) {
  const unnotifiedIds = [];
  const title = i18n('msgMissingResources');
  let toLog = i18n('msgReinstallScripts');
  let toNotify = toLog;
  let str;
  ids.forEach(id => {
    str = `\n#${id}: ${getScriptName(getScriptById(id))}`;
    toLog += str;
    if (!notifiedBadScripts.has(id)) {
      notifiedBadScripts.add(id);
      unnotifiedIds.push(id);
      toNotify += str;
    }
  });
  console.error(`${title} ${toLog}`);
  if (unnotifiedIds.length) notifyToOpenScripts(title, toNotify, unnotifiedIds);
}

export function notifyToOpenScripts(title, text, ids) {
  commands.Notification({ title, text, onclick: { cmd: 'OpenEditor', for: ids } });
}

export async function getData({ id, ids, sizes }) {
  if (id) ids = [id];
  const res = {};
  const scripts = ids
    ? getScriptsByIdsOrAll(ids).filter(Boolean)
    : getScriptsByIdsOrAll();
  scripts.forEach(inferScriptProps);
  res[kDownloads] = permissionDownloads;
  res[SCRIPTS] = scripts;
  if (sizes) res.sizes = getSizes(ids);
  if (!id) res.cache = await getIconCache(scripts);
  if (!id && sizes) res.sync = commands.SyncGetStates();
  return res;
}

async function getIconCache(scripts) {
  const toGet = [`${ICON_PREFIX}38.png`];
  const toPrime = [];
  const res = {};
  for (let { custom, meta } of scripts) {
    let icon = custom.icon || meta.icon;
    if (isValidHttpUrl(icon)) {
      icon = custom.pathMap[icon] || icon;
      toGet.push(icon);
      if (!storageCacheHas(S_CACHE_PRE + icon)) toPrime.push(icon);
    }
  }
  if (toPrime.length) await storage[S_CACHE].getMulti(toPrime);
  for (let i = 0, d, url; i < toGet.length; i++) {
    url = toGet[i];
    d = getImageData(url);
    if (!isObject(d) || !i && (d = await d)) res[url] = d;
  }
  return res;
}

export function getSizes(ids) {
  const scripts = getScriptsByIdsOrAll(ids);
  return scripts.map(({
    meta, custom: { pathMap = {} }, props: { id },
  }, i) => [
    scriptSizes[S_CODE_PRE + id] || 0,
    deepSize(scripts[i]),
    scriptSizes[S_VALUE_PRE + id] || 0,
    meta.require.reduce(getSizeForRequires, { len: 0, pathMap }).len,
    Object.values(meta.resources).reduce(getSizeForResources, { len: 0, pathMap }).len,
  ]);
}

function getSizeForRequires(accum, url) {
  accum.len += (scriptSizes[S_REQUIRE_PRE + (accum.pathMap[url] || url)] || 0) + url.length;
  return accum;
}

function getSizeForResources(accum, url) {
  accum.len += (scriptSizes[S_CACHE_PRE + (accum.pathMap[url] || url)] || 0) + url.length;
  return accum;
}

export async function removeScripts(ids) {
  const idsToRemove = [];
  const newLen = 1 + removedScripts.reduce((iAlive, script, i) => {
    const id = getPropsId(script);
    if (ids.includes(id)) {
      idsToRemove.push(S_CODE_PRE + id, S_SCRIPT_PRE + id, S_VALUE_PRE + id);
      delete scriptMap[id];
    } else if (++iAlive < i) removedScripts[iAlive] = script;
    return iAlive;
  }, -1);
  if (removedScripts.length !== newLen) {
    removedScripts.length = newLen;
    await storage.api.remove(idsToRemove);
    vacuum();
    return broadcast('RemoveScripts', ids);
  }
}

export function checkRemove({ force } = {}) {
  const now = Date.now();
  const ids = removedScripts.filter(script => {
    const { lastModified } = script.props;
    return script.config.removed && (force || now - getInt(lastModified) > TIMEOUT_WEEK);
  }).map(script => script.props.id);
  return removeScripts(ids);
}

export async function updateScriptInfo(id, data) {
  const script = scriptMap[id];
  for (const key in data) if (script[key]) Object.assign(script[key], data[key]);
  await Promise.all([
    storage.api.set({ [S_SCRIPT_PRE + id]: script }),
    broadcast('UpdateScript', { where: { id }, update: script }),
  ]);
}

export function parseMetaWithErrors(src) {
  const isObj = isObject(src);
  const custom = isObj && src.custom || getDefaultCustom();
  const errors = [];
  const meta = parseMeta(isObj ? src.code : src, { errors });
  if (meta) {
    if (meta.grant.includes('none') && new Set(meta.grant).size > 1) {
      errors.push(i18n('hintGrantNone'));
    }
    testerBatch(errors);
    testScript('', { meta, custom });
    testerBatch();
  } else {
    errors.push(i18n('labelNoName'));
  }
  return { meta, errors: errors.length ? errors : null };
}

export async function parseScript(src) {
  const { meta, errors } = src.meta ? src : parseMetaWithErrors(src);
  if (!meta.name) throw `${i18n('msgInvalidScript')}\n${i18n('labelNoName')}`;
  const update = {
    message: src.message == null ? i18n('msgUpdated') : src.message || '',
  };
  const result = { errors, update };
  const { [S_CODE]: code, update: srcUpdate } = src;
  const now = Date.now();
  let { id } = src;
  let script;
  let oldScript = getScript({ id, meta });
  if (oldScript) {
    script = oldScript;
    id = script.props.id;
  } else {
    script = newScript();
    maxScriptId++;
    id = script.props.id = maxScriptId;
    result.isNew = true;
    update.message = i18n('msgInstalled');
    aliveScripts.push(script);
  }
  const { config, custom, props } = script;
  const uri = getNameURI({ meta, props: { id } });
  if (oldScript) {
    if (src.isNew || id && aliveScripts.some(({ props: p }) => uri === p.uri && id !== p.id)) {
      throw i18n('msgNamespaceConflict');
    }
    delete script[INFERRED];
  }
  props.lastModified = now;
  props.uuid = props.uuid || crypto.randomUUID();
  for (const key of ['config', 'custom', 'props']) {
    const dst = script[key];
    src[key]::forEachEntry(([srcKey, srcVal]) => {
      if (srcVal == null) delete dst[srcKey];
      else dst[srcKey] = srcVal;
    });
  }
  const pos = +src.position;
  if (pos) {
    props.position = pos;
    maxScriptPosition = Math.max(maxScriptPosition, pos);
  } else if (!oldScript) {
    maxScriptPosition++;
    props.position = maxScriptPosition;
  }
  config.enabled = getInt(config.enabled);
  config.removed = 0;
  config.shouldUpdate = getInt(config.shouldUpdate);
  script.meta = meta;
  props.uri = getNameURI(script);
  delete custom.from;
  if (!getScriptHome(script) && isRemote(src.from)) custom.from = src.from;
  if (isValidHttpUrl(src.url)) custom.lastInstallURL = src.url;
  if (!srcUpdate) storage.mod.remove(getScriptUpdateUrl(script, { all: true }) || []);
  buildPathMap(script, src.url);
  const depsPromise = fetchResources(script, src);
  const hasControlledBaseline = Object.prototype.hasOwnProperty.call(src, 'controlledCodeBaseline');
  const codeChanged = !oldScript || code !== (hasControlledBaseline
    ? src.controlledCodeBaseline
    : await storage[S_CODE].getOne(id));
  if (codeChanged && src.bumpDate) props.lastUpdated = now;
  if (src.cache) await depsPromise;
  src.validateBeforeCommit?.();
  await storage.api.set({
    [S_SCRIPT_PRE + id]: script,
    ...codeChanged && { [S_CODE_PRE + id]: code },
  });
  inferScriptProps(script);
  Object.assign(update, script, srcUpdate);
  result.where = { id };
  result[S_CODE] = src[S_CODE];
  broadcast('UpdateScript', result);
  pluginEvents.emit('scriptChanged', result);
  if (src.reloadTab) reloadTabForScript(script);
  return result;
}

function buildPathMap(script, base) {
  const { meta } = script;
  const baseUrl = base || script.custom.lastInstallURL;
  const pathMap = baseUrl ? [
    ...meta.require,
    ...Object.values(meta.resources),
    meta.icon,
  ].reduce((map, key) => {
    if (key) {
      const fullUrl = vetUrl(key, baseUrl);
      if (fullUrl !== key) map[key] = fullUrl;
    }
    return map;
  }, {}) : {};
  script.custom.pathMap = pathMap;
  return pathMap;
}

export async function fetchResources(script, src) {
  const { custom, meta } = script;
  const { pathMap } = custom;
  const { resources } = meta;
  const icon = custom.icon || meta.icon;
  const jobs = [];
  for (const url of meta.require) jobs.push([S_REQUIRE, url]);
  for (const key in resources) jobs.push([S_CACHE, resources[key]]);
  if (isRemote(icon)) jobs.push([S_CACHE, icon, ICON_TIMEOUT]);
  if (!jobs.length) return;
  for (let i = 0, type, url, timeout, res; i < jobs.length; i++) {
    [type, url, timeout] = jobs[i];
    if (!(res = pendingDeps[type][url])) {
      if (url && !isDataUri(url)) {
        url = pathMap[url] || url;
        if ((res = src[type]) && (res = res[url]) != null) {
          storage[type].setOne(url, res);
          res = '';
        } else {
          res = fetchResource(src, type, url);
          if (timeout) res = Promise.race([res, makePause(timeout)]);
          pendingDeps[type][url] = res;
        }
      } else res = '';
    }
    jobs[i] = res;
  }
  const results = await Promise.all(jobs);
  const cache = {};
  results.forEach((res, i) => {
    const job = jobs[i];
    if (res && job) cache[job[1]] = res;
  });
  if (Object.keys(cache).length) await storage.api.set(cache);
}

async function fetchResource(src, type, url) {
  try {
    const res = await request(url, { ...FETCH_OPTS, responseType: 'blob' });
    if (res.status >= 300) return `${res.status} ${res.statusText}`;
    return type === S_REQUIRE ? await res.text() : await blob2base64(res);
  } catch (err) {
    return `${err}`;
  }
}

async function vacuum(data) {
  data ||= await storage.api.get();
  const toRemove = [];
  const used = new Set();
  forEachValue(scriptMap, script => {
    const id = script.props.id;
    used.add(S_SCRIPT_PRE + id);
    used.add(S_CODE_PRE + id);
    used.add(S_VALUE_PRE + id);
  });
  forEachKey(data, key => {
    if (sizesPrefixRe.test(key) && !used.has(key)) toRemove.push(key);
  });
  if (toRemove.length) await storage.api.remove(toRemove);
  return true;
}
