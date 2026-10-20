import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, PROVIDER_IDS, PROVIDER_LABELS, mergeSettings, validateSettings, loadSettings, saveSettings, SETTINGS_KEY, effectiveLimits,
} from '../src/lib/settings.js';
import { createFakeStorage } from './helpers/fake-storage.js';

test('defaults match the spec', () => {
  const s = mergeSettings(undefined);
  assert.equal(s.provider, 'openai');
  assert.equal(s.targetLang, '日本語');
  assert.equal(s.maxUnitsPerBatch, 40);
  assert.equal(s.maxCharsPerBatch, 3000);
  assert.equal(s.concurrency, 3);
  assert.equal(s.providers.openai.model, 'gpt-5.5');
  assert.equal(s.providers.anthropic.model, 'claude-opus-5-5');
  assert.equal(s.providers.gemini.model, 'gemini-3.8-flash');
  assert.deepEqual(s.providers.compat, { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1', jsonMode: false });
  assert.deepEqual(PROVIDER_IDS, ['openai', 'anthropic', 'gemini', 'compat', 'lmstudio']);
  for (const id of PROVIDER_IDS) assert.equal(typeof PROVIDER_LABELS[id], 'string');
});

test('mergeSettings keeps defaults for missing nested keys and does not share objects', () => {
  const s = mergeSettings({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } });
  assert.equal(s.provider, 'anthropic');
  assert.equal(s.providers.anthropic.apiKey, 'k');
  assert.equal(s.providers.anthropic.model, 'claude-opus-5-5');
  s.providers.openai.apiKey = 'mutated';
  assert.equal(DEFAULT_SETTINGS.providers.openai.apiKey, '');
});

test('validateSettings', () => {
  const ok = mergeSettings({ providers: { openai: { apiKey: 'k' } } });
  assert.equal(validateSettings(ok), null);
  assert.match(validateSettings(mergeSettings({})), /APIキー/);
  assert.match(validateSettings(mergeSettings({ providers: { openai: { apiKey: 'k', model: ' ' } } })), /モデル/);
  assert.match(validateSettings(mergeSettings({ provider: 'nope' })), /プロバイダ/);
  assert.equal(validateSettings(mergeSettings({ provider: 'compat' })), null, 'compat needs no key');
  assert.match(validateSettings(mergeSettings({ provider: 'compat', providers: { compat: { baseUrl: 'ftp://x' } } })), /ベースURL/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', providers: { compat: { baseUrl: 'nonsense' } } })), /ベースURL/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', targetLang: '' })), /翻訳先言語/);
  assert.match(validateSettings(mergeSettings({ provider: 'compat', concurrency: 0 })), /同時/);
});

test('load and save round-trip through storage', async () => {
  const storage = createFakeStorage();
  assert.deepEqual(await loadSettings(storage), mergeSettings(undefined));
  const s = mergeSettings({ provider: 'gemini', providers: { gemini: { apiKey: 'g' } } });
  await saveSettings(storage, s);
  assert.deepEqual(storage.data[SETTINGS_KEY], s);
  assert.deepEqual(await loadSettings(storage), s);
});

test('ignoreTranslateNo defaults to off', () => {
  assert.equal(mergeSettings(undefined).ignoreTranslateNo, false);
});

test('lmstudio defaults and validation', () => {
  const s = mergeSettings({ provider: 'lmstudio' });
  assert.deepEqual(s.providers.lmstudio, { model: '', baseUrl: 'http://localhost:1234/v1', autoStart: true });
  assert.equal(PROVIDER_LABELS.lmstudio, 'LM Studio（ローカル）');
  assert.match(validateSettings(s), /モデル/);
  assert.equal(validateSettings(mergeSettings({ provider: 'lmstudio', providers: { lmstudio: { model: 'qwen/qwen2.5-coder-14b' } } })), null, 'no API key needed');
  assert.match(validateSettings(mergeSettings({ provider: 'lmstudio', providers: { lmstudio: { model: 'm', baseUrl: 'ftp://x' } } })), /ベースURL/);
});

test('effectiveLimits sends small batches to LM Studio two at a time and leaves cloud providers alone', () => {
  const cloud = mergeSettings({ provider: 'gemini' });
  assert.deepEqual(effectiveLimits(cloud), { maxUnitsPerBatch: 40, maxCharsPerBatch: 3000, concurrency: 3 });
  const local = mergeSettings({ provider: 'lmstudio' });
  assert.deepEqual(effectiveLimits(local), { maxUnitsPerBatch: 10, maxCharsPerBatch: 1000, concurrency: 2 });
  const smaller = mergeSettings({ provider: 'lmstudio', maxUnitsPerBatch: 5, maxCharsPerBatch: 500, concurrency: 1 });
  assert.deepEqual(effectiveLimits(smaller), { maxUnitsPerBatch: 5, maxCharsPerBatch: 500, concurrency: 1 }, 'user values below the caps are kept');
});

test('following clicked links is off by default and kept when saved', () => {
  assert.equal(mergeSettings({}).followLinks, false);
  assert.equal(mergeSettings({ followLinks: true }).followLinks, true);
});

test('a local server address without a path gets /v1, so LM Studio\'s copied address works as-is', () => {
  const s = mergeSettings({
    providers: {
      lmstudio: { baseUrl: 'http://10.15.35.233:1234' },
      compat: { baseUrl: 'http://localhost:11434/' },
    },
  });
  assert.equal(s.providers.lmstudio.baseUrl, 'http://10.15.35.233:1234/v1');
  assert.equal(s.providers.compat.baseUrl, 'http://localhost:11434/v1');
});

test('addresses that already have a path, or are not URLs, are left alone', () => {
  const s = mergeSettings({
    providers: {
      lmstudio: { baseUrl: 'http://localhost:1234/v1/' },
      compat: { baseUrl: 'https://openrouter.ai/api/v1' },
    },
  });
  assert.equal(s.providers.lmstudio.baseUrl, 'http://localhost:1234/v1/');
  assert.equal(s.providers.compat.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(mergeSettings({ providers: { compat: { baseUrl: 'not a url' } } }).providers.compat.baseUrl, 'not a url');
});
