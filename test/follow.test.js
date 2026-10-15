import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollower, FOLLOW_KEY } from '../src/lib/follow.js';

function fakeStorage() {
  const data = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
}

function setup({ enabled = true } = {}) {
  const storage = fakeStorage();
  const injected = [];
  const ctl = { enabled };
  const follower = createFollower({ storage, inject: async (tabId) => void injected.push(tabId), isEnabled: async () => ctl.enabled });
  return { storage, injected, ctl, follower };
}
const complete = { status: 'complete' };
const page = (url) => ({ url });

test('a followed tab is translated again when a new page finishes loading', async () => {
  const { follower, injected } = setup();
  await follower.start(7);
  await follower.onUpdated(7, { status: 'loading' }, page('https://example.com/next'));
  assert.deepEqual(injected, []);
  await follower.onUpdated(7, complete, page('https://other.example.org/'));
  assert.deepEqual(injected, [7]);
});

test('other tabs, internal pages and a disabled setting are left alone', async () => {
  const { follower, injected, ctl } = setup();
  await follower.start(7);
  await follower.onUpdated(8, complete, page('https://example.com/'));
  await follower.onUpdated(7, complete, page('chrome://extensions/'));
  ctl.enabled = false;
  await follower.onUpdated(7, complete, page('https://example.com/'));
  assert.deepEqual(injected, []);
});

test('start does nothing while the setting is off', async () => {
  const { follower, injected, ctl } = setup({ enabled: false });
  await follower.start(7);
  ctl.enabled = true;
  await follower.onUpdated(7, complete, page('https://example.com/'));
  assert.deepEqual(injected, []);
});

test('stop and closing the tab end following', async () => {
  const { follower, injected } = setup();
  await follower.start(7);
  await follower.start(9);
  await follower.stop(7);
  await follower.onRemoved(9);
  await follower.onUpdated(7, complete, page('https://example.com/'));
  await follower.onUpdated(9, complete, page('https://example.com/'));
  assert.deepEqual(injected, []);
});

test('followed tabs survive a restart of the background worker', async () => {
  const { follower, storage, injected } = setup();
  await follower.start(7);
  assert.deepEqual(storage.data[FOLLOW_KEY], [7]);
  const again = createFollower({ storage, inject: async (tabId) => void injected.push(tabId), isEnabled: async () => true });
  await again.onUpdated(7, complete, page('http://example.com/'));
  assert.deepEqual(injected, [7]);
});

test('a failing injection does not throw', async () => {
  const storage = fakeStorage();
  const follower = createFollower({ storage, inject: async () => { throw new Error('no access'); }, isEnabled: async () => true });
  await follower.start(7);
  await follower.onUpdated(7, complete, page('https://example.com/'));
});

test('a tab opened from a followed tab (target="_blank" and the like) is not translated', async () => {
  const { follower, injected } = setup();
  await follower.start(7);
  assert.equal(follower.onCreated, undefined, 'new tabs are not tracked');
  await follower.onUpdated(11, complete, page('https://elsewhere.example/'));
  assert.deepEqual(injected, []);
});
