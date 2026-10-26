import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSpaceShortcutHandler } from '../../space-shortcuts.js';

test('only the four direct space selections have defaults, with real Control on macOS', async () => {
    const { commands } = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url)));
    assert.deepEqual(Object.keys(commands).filter(name => commands[name].suggested_key),
        ['selectSpace1', 'selectSpace2', 'selectSpace3', 'selectSpace4']);
    for (const [i, key] of ['Q', 'W', 'E', 'R'].entries()) {
        assert.deepEqual(commands[`selectSpace${i + 1}`].suggested_key, { default: `Ctrl+${key}`, mac: `MacCtrl+${key}` });
    }
    for (const name of ['_execute_action', 'quickPinToggle', 'nextSpace', 'previousSpace']) {
        assert.ok(commands[name].description);
        assert.equal(commands[name].suggested_key, undefined);
    }
});

test('space commands map to ordered positions and directions without sidebar messaging', async () => {
    const requests = [];
    const handle = createSpaceShortcutHandler({ dispatch: async message => requests.push(message) });
    for (const name of ['selectSpace1', 'selectSpace2', 'selectSpace3', 'selectSpace4', 'nextSpace', 'previousSpace']) {
        await handle(name, { windowId: 7 });
    }
    assert.deepEqual(requests, [
        ...[0, 1, 2, 3].map(index => ({ action: 'switch', windowId: 7, index })),
        { action: 'switch', windowId: 7, offset: 1 },
        { action: 'switch', windowId: 7, offset: -1 }
    ]);
    assert.equal(handle('quickPinToggle'), null);
});

test('queued commands capture their window immediately and run in arrival order', async () => {
    let resolveFirst, finishFirst;
    const firstWindow = new Promise(resolve => { resolveFirst = resolve; });
    const firstOperation = new Promise(resolve => { finishFirst = resolve; });
    const queries = [], requests = [];
    globalThis.chrome = { windows: { getLastFocused: options => {
        queries.push(options);
        return queries.length === 1 ? firstWindow : Promise.resolve({ id: 22 });
    } } };
    const handle = createSpaceShortcutHandler({ dispatch: async message => {
        requests.push(message);
        if (requests.length === 1) await firstOperation;
    } });
    const first = handle('nextSpace');
    const second = handle('previousSpace');
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[0], { windowTypes: ['normal'] });
    await Promise.resolve();
    assert.deepEqual(requests, []);
    resolveFirst({ id: 11 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    finishFirst();
    await Promise.all([first, second]);
    assert.deepEqual(requests, [
        { action: 'switch', windowId: 11, offset: 1 },
        { action: 'switch', windowId: 22, offset: -1 }
    ]);
});

test('a failed command does not block later commands', async () => {
    const requests = [];
    const handle = createSpaceShortcutHandler({ dispatch: async message => {
        requests.push(message);
        if (requests.length === 1) throw new Error('Window closed');
    } });
    const failed = handle('selectSpace1', { windowId: 1 });
    const next = handle('selectSpace2', { windowId: 2 });
    await assert.rejects(failed, /Window closed/);
    await next;
    assert.equal(requests.length, 2);
});
