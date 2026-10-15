import { loadSettings, PROVIDER_LABELS } from '../lib/settings.js';
import { statusText } from '../lib/status-overlay.js';

const $ = (id) => document.getElementById(id);
let tabId;
let lastStatus = null;

async function sendToTab(message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null; // content script 未注入
  }
}

function render(status) {
  lastStatus = status;
  $('status').textContent = (status && statusText(status)) || '待機中';
  $('status').classList.toggle('error', status?.state === 'error');
  const active = status?.state === 'translating' || status?.state === 'done';
  $('translate').disabled = status?.state === 'translating' || (status?.state === 'done' && !status.failed);
  $('stop').disabled = !active;
}

// 翻訳中は応答待ちの秒数が進むので1秒ごとに描き直す
setInterval(() => {
  if (lastStatus?.state === 'translating') render(lastStatus);
}, 1000);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  const settings = await loadSettings(chrome.storage.local);
  $('provider').textContent = `${PROVIDER_LABELS[settings.provider]} / ${settings.providers[settings.provider].model}`;
  const res = await sendToTab({ type: 'status' });
  render(res?.status);
}

$('translate').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
  } catch {
    $('status').textContent = 'このページは翻訳できません（Chrome の内部ページなど）';
    $('status').classList.add('error');
    return;
  }
  const res = await sendToTab({ type: 'translate' });
  render(res?.status);
});

for (const type of ['stop', 'restore']) {
  $(type).addEventListener('click', async () => {
    const res = await sendToTab({ type });
    render(res?.status);
  });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'progress' && sender.tab?.id === tabId) render(message.status);
});

$('open-options').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
