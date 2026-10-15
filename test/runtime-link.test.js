import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeLink } from '../src/lib/runtime-link.js';

const invalidated = () => { throw new Error('Extension context invalidated.'); };

test('send forwards to the runtime while the extension is alive', async () => {
  const sent = [];
  const link = createRuntimeLink({ id: 'x', sendMessage: async (m) => (sent.push(m), { ok: true }) });
  assert.equal(link.alive(), true);
  assert.deepEqual(await link.send({ type: 'progress' }), { ok: true });
  assert.deepEqual(sent, [{ type: 'progress' }]);
});

test('after the extension was reloaded, send rejects instead of throwing and reports the loss once', async () => {
  const runtime = { id: 'x', sendMessage: invalidated };
  let lost = 0;
  const link = createRuntimeLink(runtime, { onLost: () => lost++ });
  await assert.rejects(() => link.send({ type: 'progress' }), /invalidated/);
  delete runtime.id;
  assert.equal(link.alive(), false);
  await assert.rejects(() => link.send({ type: 'progress' }), /invalidated/);
  assert.equal(lost, 1);
});

test('a runtime without an id counts as lost before anything is sent', async () => {
  let lost = 0;
  const link = createRuntimeLink({ sendMessage: async () => ({}) }, { onLost: () => lost++ });
  await assert.rejects(() => link.send({ type: 'progress' }));
  assert.equal(lost, 1);
});
