import test from 'node:test';
import assert from 'node:assert/strict';
import { Cooldown, capPageSize } from '../dist/limits.js';

test('cooldown returns cached result for the same key', async () => {
    const c = new Cooldown(10);
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    assert.deepEqual(await c.run('a', fn), { n: 1 });
    const second = await c.run('a', fn);
    assert.equal(second.cached, true);
    assert.deepEqual(second.result, { n: 1 });
    assert.deepEqual(await c.run('b', fn), { n: 2 });
});

test('cooldown 0 disables caching', async () => {
    const c = new Cooldown(0);
    let calls = 0;
    await c.run('a', async () => ++calls);
    await c.run('a', async () => ++calls);
    assert.equal(calls, 2);
});

test('page size is capped', () => {
    assert.deepEqual(capPageSize({ size: 1000, start: 0 }, 200), { size: 200, start: 0 });
    assert.deepEqual(capPageSize({ size: 50 }, 200), { size: 50 });
    assert.deepEqual(capPageSize({}, 200), {});
});

test('cooldown does not keep a failed or timed-out job: the next call tries again', async () => {
    const c = new Cooldown(30);
    let calls = 0;
    await c.run('node', async () => (++calls, { timeout: true }));
    await c.run('node', async () => (++calls, { isFailed: true }));
    const ok = await c.run('node', async () => (++calls, { isCompleted: true }));
    assert.equal(calls, 3);
    assert.equal(ok.isCompleted, true);
    assert.equal((await c.run('node', async () => ++calls)).cached, true);
});
