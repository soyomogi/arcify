import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GlobalFavorites } from '../../global-favorites.js';

let nodes, tabs, local, session, nextId, nextTab;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const area = data => ({ get: async keys => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)) });
const children = id => nodes.filter(node => node.parentId === id);
const tabOrder = windowId => tabs.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
const normalize = windowId => tabOrder(windowId).forEach((tab, index) => { tab.index = index; });
beforeEach(() => {
    nextId = 10; nextTab = 10;
    nodes = [{ id: '0', title: 'root' }, { id: '1', parentId: '0', title: 'Bookmarks' }, { id: 'arcify', parentId: '1', title: 'Arcify' },
        { id: 'space', parentId: 'arcify', title: 'Space' }, { id: 'space-pin', parentId: 'space', title: 'Space saved', url: 'https://same.test/' }];
    tabs = [{ id: 1, windowId: 1, index: 0, pinned: true, active: true, title: 'A', url: 'https://same.test/' },
        { id: 2, windowId: 1, index: 1, pinned: true, active: false, title: 'B', url: 'https://same.test/' }];
    local = {}; session = {};
    const bookmarks = {
        onCreated: event(), onRemoved: event(), onMoved: event(), onChanged: event(), onChildrenReordered: event(),
        getTree: async () => {
            const tree = node => ({ ...node, ...(!node.url ? { children: children(node.id).map(tree) } : {}) });
            return [tree(nodes[0])];
        },
        search: async ({ title }) => structuredClone(nodes.filter(node => node.title === title)),
        getChildren: async id => structuredClone(children(id)),
        get: async id => {
            const node = nodes.find(node => node.id === id);
            if (!node) throw new Error("Can't find bookmark for id.");
            return [structuredClone(node)];
        },
        create: async data => {
            const node = { parentId: '1', ...data, id: String(nextId++) };
            nodes.push(node); bookmarks.onCreated.emit(node.id, node); return structuredClone(node);
        },
        move: async (id, { index, parentId }) => {
            const node = nodes.find(node => node.id === id);
            const oldParentId = node.parentId;
            nodes = nodes.filter(other => other !== node);
            node.parentId = parentId || oldParentId;
            const siblings = children(node.parentId);
            const target = siblings[index];
            nodes.splice(target ? nodes.indexOf(target) : nodes.length, 0, node);
            bookmarks.onMoved.emit(id, { parentId: node.parentId, oldParentId }); return structuredClone(node);
        },
        remove: async id => { const node = nodes.find(node => node.id === id); nodes = nodes.filter(node => node.id !== id); bookmarks.onRemoved.emit(id, { parentId: node.parentId }); }
    };
    globalThis.chrome = { bookmarks, storage: { local: area(local), session: area(session) }, tabs: {
        onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onActivated: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
        query: async query => structuredClone(tabs.filter(tab => (query.windowId === undefined || tab.windowId === query.windowId)
            && (query.pinned === undefined || tab.pinned === query.pinned))),
        get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('Missing tab'); return structuredClone(tab); },
        update: async (id, attrs) => {
            const tab = tabs.find(tab => tab.id === id);
            if (attrs.active) tabs.filter(other => other.windowId === tab.windowId).forEach(other => { other.active = false; });
            Object.assign(tab, attrs); return structuredClone(tab);
        },
        create: async attrs => { const tab = { id: nextTab++, index: tabOrder(attrs.windowId).length, ...attrs }; tabs.push(tab); return structuredClone(tab); },
        move: async (id, { index }) => {
            const tab = tabs.find(tab => tab.id === id);
            const ordered = tabOrder(tab.windowId).filter(other => other !== tab);
            ordered.splice(index, 0, tab); ordered.forEach((other, i) => { other.index = i; });
            return structuredClone(tab);
        }
    } };
});

test('native pinned tabs migrate once into a separate folder and URL twins keep distinct bookmark IDs', async () => {
    const store = new GlobalFavorites();
    const first = await store.dispatch({ action: 'get' });
    assert.equal(first.bookmarks.length, 2);
    assert.notEqual(first.tabs[0].bookmarkId, first.tabs[1].bookmarkId);
    assert.equal(nodes.find(node => node.id === first.folderId).parentId, '1');
    assert.deepEqual(children('space').map(node => node.id), ['space-pin']);
    const restarted = new GlobalFavorites();
    assert.deepEqual((await restarted.dispatch({ action: 'get' })).bookmarks, first.bookmarks);
});

test('close and native unpin preserve favorites; click reopens or repins the exact favorite', async () => {
    const store = new GlobalFavorites();
    const view = await store.dispatch({ action: 'get' });
    const [a, b] = view.bookmarks;
    tabs = tabs.filter(tab => tab.id !== 1); normalize(1);
    tabs[0].pinned = false;
    assert.equal((await store.dispatch({ action: 'get' })).bookmarks.length, 2);
    await store.dispatch({ action: 'open', bookmarkId: b.bookmarkId, windowId: 1 });
    assert.equal(tabs.find(tab => tab.id === 2).pinned, true);
    await store.dispatch({ action: 'open', bookmarkId: a.bookmarkId, windowId: 1 });
    assert.equal(Object.values(store.bindings).filter(id => id === a.bookmarkId).length, 1);
    assert.equal((await store.dispatch({ action: 'get' })).bookmarks.length, 2);
    assert.deepEqual(tabOrder(1).filter(tab => tab.pinned).map(tab => store.bindings[tab.id]), [a.bookmarkId, b.bookmarkId]);
});

test('explicit removal deletes only its bookmark and unpins its bound tab', async () => {
    const store = new GlobalFavorites();
    const view = await store.dispatch({ action: 'get' });
    const removed = view.bookmarks[1].bookmarkId;
    await store.dispatch({ action: 'remove', bookmarkId: removed });
    assert.equal(tabs.find(tab => tab.id === 2).pinned, false);
    assert.equal(nodes.some(node => node.id === removed), false);
    assert.ok(nodes.some(node => node.id === view.bookmarks[0].bookmarkId));
    assert.ok(nodes.some(node => node.id === 'space-pin'));
});

test('native tab ordering updates open slots while preserving a closed favorite position', async () => {
    tabs.push({ id: 3, windowId: 1, index: 2, pinned: true, title: 'C', url: 'https://third.test/' });
    const store = new GlobalFavorites();
    const initial = await store.dispatch({ action: 'get' });
    const [a, b, c] = initial.bookmarks.map(node => node.bookmarkId);
    tabs = tabs.filter(tab => tab.id !== 2); normalize(1);
    await store.dispatch({ action: 'get' });
    await chrome.tabs.move(3, { index: 0 });
    const native = await store.run(() => store.reconcile({ reorderWindowId: 1 }));
    assert.deepEqual(native.bookmarks.map(node => node.bookmarkId), [c, b, a]);
    const reordered = await store.dispatch({ action: 'reorder', before: [c, b, a], after: [a, b, c] });
    assert.deepEqual(reordered.bookmarks.map(node => node.bookmarkId), [a, b, c]);
    assert.deepEqual(tabOrder(1).map(tab => tab.id), [1, 3]);
    await assert.rejects(store.dispatch({ action: 'reorder', before: [c, b, a], after: [a, c, b] }), /changed/);
});

test('same-URL newly pinned tabs never steal a closed favorite and external removal unpins only its binding', async () => {
    const store = new GlobalFavorites();
    const first = await store.dispatch({ action: 'get' });
    tabs = tabs.filter(tab => tab.id !== 1); normalize(1);
    await store.dispatch({ action: 'get' });
    tabs.push({ id: 4, windowId: 1, index: 1, pinned: true, title: 'New twin', url: 'https://same.test/' });
    const next = await store.dispatch({ action: 'get' });
    assert.equal(next.bookmarks.length, 3);
    assert.notEqual(store.bindings[4], first.bookmarks[0].bookmarkId);
    await chrome.bookmarks.remove(first.bookmarks[1].bookmarkId);
    await store.dispatch({ action: 'get' });
    assert.equal(tabs.find(tab => tab.id === 2).pinned, false);
    assert.equal(tabs.find(tab => tab.id === 4).pinned, true);
});

test('restart remaps new tab IDs using snapshots after navigation and keeps URL twins distinct', async () => {
    const store = new GlobalFavorites();
    const first = await store.dispatch({ action: 'get' });
    tabs[0].url = 'https://navigated.test/';
    await store.dispatch({ action: 'get' });
    session = {}; chrome.storage.session = area(session);
    tabs[0].id = 101; tabs[1].id = 102;
    const restarted = new GlobalFavorites();
    const next = await restarted.dispatch({ action: 'get' });
    assert.equal(next.bookmarks.length, 2);
    assert.equal(restarted.bindings[101], first.bookmarks[0].bookmarkId);
    assert.equal(restarted.bindings[102], first.bookmarks[1].bookmarkId);
});

test('opening a favorite creates a local pinned tab and does not focus a different window', async () => {
    const store = new GlobalFavorites();
    const first = await store.dispatch({ action: 'get' });
    await store.dispatch({ action: 'open', bookmarkId: first.bookmarks[0].bookmarkId, windowId: 2 });
    assert.equal(tabs.filter(tab => store.bindings[tab.id] === first.bookmarks[0].bookmarkId).length, 2);
    assert.equal(tabs.find(tab => tab.windowId === 2).pinned, true);
    assert.equal((await store.dispatch({ action: 'get' })).bookmarks.length, 2);
});

test('a native reorder propagates across windows without an unchanged window undoing it', async () => {
    const store = new GlobalFavorites();
    const first = await store.dispatch({ action: 'get' });
    for (const bookmark of first.bookmarks) await store.dispatch({ action: 'open', bookmarkId: bookmark.bookmarkId, windowId: 2 });
    await chrome.tabs.move(2, { index: 0 });
    const moved = await store.dispatch({ action: 'get' });
    assert.deepEqual(moved.bookmarks.map(node => node.bookmarkId), [...first.bookmarks].reverse().map(node => node.bookmarkId));
    assert.deepEqual(tabOrder(2).map(tab => store.bindings[tab.id]), moved.bookmarks.map(node => node.bookmarkId));
});

test('a native move that wakes a suspended worker is imported before any projection', async () => {
    const first = await new GlobalFavorites().dispatch({ action: 'get' });
    await chrome.tabs.move(2, { index: 0 });
    const restarted = await new GlobalFavorites().dispatch({ action: 'get' });
    assert.deepEqual(restarted.bookmarks.map(node => node.bookmarkId), [...first.bookmarks].reverse().map(node => node.bookmarkId));
});
