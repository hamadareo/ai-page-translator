import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

test('manifest is MV3 and references existing files', () => {
  assert.equal(manifest.manifest_version, 3);
  for (const path of [manifest.action.default_popup, manifest.options_page, manifest.background.service_worker, 'src/content.js']) {
    assert.ok(existsSync(join(root, path)), `${path} missing`);
  }
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'nativeMessaging', 'scripting', 'storage', 'unlimitedStorage']);
  for (const host of ['https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*', 'http://localhost/*', 'http://127.0.0.1/*']) {
    assert.ok(manifest.host_permissions.includes(host), `${host} missing`);
  }
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
});

test('every module the content script loads is web accessible', () => {
  const patterns = manifest.web_accessible_resources.flatMap((r) => r.resources);
  assert.deepEqual(patterns, ['src/lib/*.js']);
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const rel = relative(root, file);
    assert.match(rel, /^src\/lib\/[^/]+\.js$/, `${rel} is not covered by src/lib/*.js`);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/g)) visit(resolve(dirname(file), spec));
  };
  visit(join(root, 'src/lib/page-translator.js'));
  visit(join(root, 'src/lib/status-overlay.js'));
});

test('manifest pins the extension ID with a public key', () => {
  assert.match(manifest.key, /^[A-Za-z0-9+/]{300,}={0,2}$/);
});
