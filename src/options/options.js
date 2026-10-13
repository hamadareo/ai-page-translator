import { loadSettings, saveSettings, mergeSettings, validateSettings, PROVIDER_IDS, PROVIDER_LABELS } from '../lib/settings.js';
import { isLocalUrl } from '../lib/errors.js';

const form = document.getElementById('form');
const providerSelect = document.getElementById('provider');
const message = document.getElementById('message');
const fields = () => [...form.querySelectorAll('[name]')];

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

for (const id of PROVIDER_IDS) providerSelect.add(new Option(PROVIDER_LABELS[id], id));

function showProviderSection() {
  for (const fs of form.querySelectorAll('fieldset[data-provider]')) fs.hidden = fs.dataset.provider !== providerSelect.value;
}

function fill(settings) {
  for (const el of fields()) {
    const value = getPath(settings, el.name);
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  }
  showProviderSection();
}

function read() {
  const settings = mergeSettings({});
  for (const el of fields()) {
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
    setPath(settings, el.name, value);
  }
  return settings;
}

function show(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

/** ユーザー操作の直後に同期的に呼ぶ（chrome.permissions.request はユーザー操作が必要） */
function requestHostPermission(settings) {
  if (settings.provider !== 'compat') return Promise.resolve(true);
  const origin = new URL(settings.providers.compat.baseUrl).origin;
  if (isLocalUrl(origin)) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

async function prepare() {
  if (!form.reportValidity()) return null;
  const settings = read();
  const invalid = validateSettings(settings);
  if (invalid) {
    show(invalid, true);
    return null;
  }
  if (!(await requestHostPermission(settings))) {
    show('ベースURLへのアクセスが許可されませんでした', true);
    return null;
  }
  return settings;
}

providerSelect.addEventListener('change', showProviderSection);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await prepare();
  if (!settings) return;
  await saveSettings(chrome.storage.local, settings);
  show('保存しました');
});

document.getElementById('test').addEventListener('click', async () => {
  const settings = await prepare();
  if (!settings) return;
  show('接続テスト中…');
  const res = await chrome.runtime.sendMessage({ type: 'testConnection', settings });
  if (res?.ok) show(`接続成功: "Hello, world!" → "${res.sample}"`);
  else show(`接続失敗: ${res?.error?.message ?? '不明なエラー'}`, true);
});

document.getElementById('clear-cache').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
  if (res?.ok) show('キャッシュを消去しました');
  else show(`消去に失敗しました: ${res?.error?.message ?? '不明なエラー'}`, true);
});

fill(await loadSettings(chrome.storage.local));
