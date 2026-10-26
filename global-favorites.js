import { enqueueBookmarkOperation } from './bookmark-writer.js';

const FOLDER_TITLE = 'arcify favorite';
const idsOf = nodes => nodes.map(node => String(node.id));
const mergeSlots = (all, visible) => {
    const selected = new Set(visible);
    let index = 0;
    return all.map(id => selected.has(id) ? visible[index++] : id);
};

// Bookmarks own favorite identity and order. Tab IDs are session-only bindings,
// including unpinned tabs that can be repinned by clicking their saved favorite.
export class GlobalFavorites {
    constructor() {
        this.chain = Promise.resolve();
        this.initialized = false;
        this.bindings = {};
        this.published = '';
        this.lastNativeOrders = new Map();
    }
    run(operation) {
        const pending = this.chain.then(async () => {
            if (!this.initialized) await this.initialize();
            return operation();
        });
        this.chain = pending.catch(() => {});
        return pending;
    }
    async ensureFolder() {
        if (this.folderReady) return;
        const tree = await chrome.bookmarks.getTree();
        const find = (nodes, id) => {
            for (const node of nodes) {
                if (String(node.id) === String(id)) return node;
                const found = node.children && find(node.children, id);
                if (found) return found;
            }
        };
        const existing = this.folderId && find(tree, this.folderId);
        if (existing && !existing.url) { this.folderReady = true; return; }
        // A sibling of Arcify, never a space folder inside Arcify.
        const candidates = await chrome.bookmarks.search({ title: FOLDER_TITLE });
        const arcify = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
        const insideArcify = node => {
            let parent = find(tree, node.parentId);
            while (parent) {
                if (parent.id === arcify?.id) return true;
                parent = find(tree, parent.parentId);
            }
            return false;
        };
        const folder = candidates.find(node => !node.url && !insideArcify(node))
            || await chrome.bookmarks.create({ title: FOLDER_TITLE });
        this.folderId = folder.id;
        this.folderReady = true;
        await chrome.storage.local.set({ globalFavoritesFolderId: folder.id });
    }
    async initialize() {
        const local = await chrome.storage.local.get(['globalFavoritesFolderId', 'globalFavoriteTabSnapshot']);
        const session = await chrome.storage.session.get(['globalFavoritesSession', 'globalFavoriteBindings', 'globalFavoriteView']);
        this.folderId = local.globalFavoritesFolderId;
        this.bindings = session.globalFavoritesSession ? (session.globalFavoriteBindings || {}) : {};
        if (session.globalFavoritesSession && session.globalFavoriteView) {
            this.lastBookmarkOrder = session.globalFavoriteView.bookmarks.map(node => node.bookmarkId);
            const pinned = session.globalFavoriteView.tabs.filter(tab => tab.pinned).sort((a, b) => a.index - b.index);
            this.lastNativeOrders = new Map([...new Set(pinned.map(tab => tab.windowId))].map(windowId => [windowId,
                pinned.filter(tab => tab.windowId === windowId).map(tab => tab.bookmarkId)]));
        }
        await this.ensureFolder();
        await this.reconcile({ restore: !session.globalFavoritesSession, snapshot: local.globalFavoriteTabSnapshot || [] });
        this.initialized = true;
    }
    async readBookmarks() {
        await this.ensureFolder();
        const nodes = (await chrome.bookmarks.getChildren(this.folderId)).filter(node => node.url);
        this.bookmarkIds = new Set(idsOf(nodes));
        return nodes;
    }
    async reorder(expected, desired) {
        if (!Array.isArray(expected) || !Array.isArray(desired) || desired.length !== expected.length
            || new Set(desired).size !== desired.length || desired.some(id => !expected.includes(id))) {
            throw new Error('Favorite order must include every bookmark exactly once.');
        }
        if (JSON.stringify(expected) === JSON.stringify(desired)) return;
        // Include any non-favorite folders in the concurrency baseline and keep
        // their slots unchanged; only direct URL children are favorites.
        const children = await chrome.bookmarks.getChildren(this.folderId);
        const current = children.filter(node => node.url);
        if (JSON.stringify(idsOf(current)) !== JSON.stringify(expected)) throw new Error('Favorites changed. Refresh and retry.');
        const all = idsOf(children);
        await enqueueBookmarkOperation({ parents: [{ parentId: this.folderId,
            expectedCanonicalIds: all, desiredCanonicalIds: mergeSlots(all, desired) }] });
    }
    async projectOrder(bookmarks) {
        const tabs = await chrome.tabs.query({ pinned: true });
        for (const windowId of new Set(tabs.map(tab => tab.windowId))) {
            const owned = tabs.filter(tab => tab.windowId === windowId);
            const ranks = new Map(bookmarks.map((node, index) => [String(node.id), index]));
            owned.sort((a, b) => ranks.get(this.bindings[a.id]) - ranks.get(this.bindings[b.id]));
            for (const [index, tab] of owned.entries()) {
                const live = await chrome.tabs.get(tab.id);
                if (live.pinned && live.windowId === windowId && live.index !== index) await chrome.tabs.move(tab.id, { index });
            }
        }
    }
    async publish(bookmarks) {
        const tabs = await chrome.tabs.query({});
        const view = { folderId: this.folderId, bookmarks: bookmarks.map(({ id, url, title }) => ({ bookmarkId: String(id), url, title })),
            tabs: tabs.filter(tab => this.bindings[tab.id]).map(tab => ({ tabId: tab.id, bookmarkId: this.bindings[tab.id],
                windowId: tab.windowId, index: tab.index, pinned: tab.pinned, active: tab.active })) };
        const snapshot = tabs.filter(tab => this.bindings[tab.id])
            .map(tab => ({ bookmarkId: this.bindings[tab.id], url: tab.url || tab.pendingUrl || '' }));
        const serialized = JSON.stringify({ view, snapshot });
        if (serialized !== this.published) {
            await chrome.storage.local.set({ globalFavoriteTabSnapshot: snapshot });
            await chrome.storage.session.set({ globalFavoritesSession: true, globalFavoriteBindings: this.bindings, globalFavoriteView: view });
            this.published = serialized;
        }
        return view;
    }
    async reconcile({ reorderWindowId, restore = false, snapshot = [] } = {}) {
        let bookmarks = await this.readBookmarks();
        const byId = new Map(bookmarks.map(node => [String(node.id), node]));
        const tabs = await chrome.tabs.query({});
        const live = new Map(tabs.map(tab => [String(tab.id), tab]));
        for (const [tabId, bookmarkId] of Object.entries(this.bindings)) {
            if (!live.has(tabId)) delete this.bindings[tabId];
            else if (!byId.has(bookmarkId)) {
                const tab = live.get(tabId);
                if (tab.pinned) { await chrome.tabs.update(tab.id, { pinned: false }); tab.pinned = false; }
                delete this.bindings[tabId];
            }
        }
        const remaining = [...snapshot];
        const claimedByWindow = new Map();
        for (const tab of tabs) {
            if (!claimedByWindow.has(tab.windowId)) claimedByWindow.set(tab.windowId, new Set());
            if (this.bindings[tab.id]) claimedByWindow.get(tab.windowId).add(this.bindings[tab.id]);
        }
        for (const tab of tabs.filter(tab => tab.pinned).sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
            if (this.bindings[tab.id]) continue;
            const url = tab.url || tab.pendingUrl;
            if (!url) continue;
            const claimed = claimedByWindow.get(tab.windowId);
            const saved = restore && (remaining.find(record => record.url === url && byId.has(record.bookmarkId) && !claimed.has(record.bookmarkId))
                || bookmarks.find(node => node.url === url && !claimed.has(String(node.id))));
            const node = saved ? byId.get(saved.bookmarkId || String(saved.id))
                : await chrome.bookmarks.create({ parentId: this.folderId, title: tab.title || url, url });
            this.bindings[tab.id] = String(node.id);
            claimed.add(String(node.id));
            if (saved && remaining.includes(saved)) remaining.splice(remaining.indexOf(saved), 1);
        }
        bookmarks = await this.readBookmarks();
        const currentOrder = idsOf(bookmarks);
        // A tab close/unpin can be queued before a native move event. If bookmark
        // order has not changed, import the live tab order before projecting it.
        const windows = Number.isInteger(reorderWindowId) ? [reorderWindowId]
            : JSON.stringify(currentOrder) === JSON.stringify(this.lastBookmarkOrder)
                ? [...new Set(tabs.filter(tab => tab.pinned).map(tab => tab.windowId))] : [];
        for (const windowId of windows) {
            const native = (await chrome.tabs.query({ windowId, pinned: true }))
                .sort((a, b) => a.index - b.index).map(tab => this.bindings[tab.id]).filter(Boolean);
            const previous = this.lastNativeOrders.get(windowId) || [];
            const shared = new Set(previous.filter(id => native.includes(id)));
            // Reopening/closing a favorite changes membership, not saved order.
            // Import only an actual reorder, so an unchanged second window cannot
            // undo a native move in the first window before projection runs.
            if (JSON.stringify(previous.filter(id => shared.has(id))) === JSON.stringify(native.filter(id => shared.has(id)))) continue;
            const desired = mergeSlots(idsOf(bookmarks), [...new Set(native)]);
            await this.reorder(idsOf(bookmarks), desired);
            bookmarks = await this.readBookmarks();
            break;
        }
        this.lastBookmarkOrder = idsOf(bookmarks);
        await this.projectOrder(bookmarks);
        const projected = await chrome.tabs.query({ pinned: true });
        this.lastNativeOrders = new Map([...new Set(projected.map(tab => tab.windowId))].map(windowId => [windowId,
            projected.filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index)
                .map(tab => this.bindings[tab.id]).filter(Boolean)]));
        return this.publish(bookmarks);
    }
    async open(bookmarkId, windowId) {
        const bookmark = (await this.readBookmarks()).find(node => String(node.id) === String(bookmarkId));
        if (!bookmark) throw new Error('Favorite no longer exists.');
        const tabs = await chrome.tabs.query({ windowId });
        let tab = tabs.find(tab => this.bindings[tab.id] === String(bookmarkId) && tab.pinned)
            || tabs.find(tab => this.bindings[tab.id] === String(bookmarkId));
        if (tab) tab = await chrome.tabs.update(tab.id, { pinned: true, active: true });
        else {
            tab = await chrome.tabs.create({ windowId, url: bookmark.url, pinned: true, active: true });
            this.bindings[tab.id] = String(bookmarkId);
        }
        return tab;
    }
    async dispatch(message) {
        return this.run(async () => {
            await this.reconcile();
            switch (message.action) {
                case 'get': break;
                case 'open': await this.open(message.bookmarkId, message.windowId); break;
                case 'add': {
                    const tab = message.tabId ? await chrome.tabs.get(message.tabId) : null;
                    let bookmarkId = tab && this.bindings[tab.id];
                    if (!bookmarkId) {
                        const url = message.url || tab?.url || tab?.pendingUrl;
                        if (!url) throw new Error('Favorite requires a URL.');
                        const node = await chrome.bookmarks.create({ parentId: this.folderId, title: message.title || tab?.title || url, url });
                        bookmarkId = String(node.id);
                        if (tab) this.bindings[tab.id] = bookmarkId;
                    }
                    if (Number.isInteger(message.index)) {
                        const current = idsOf(await this.readBookmarks());
                        const desired = current.filter(id => id !== bookmarkId);
                        desired.splice(Math.max(0, Math.min(message.index, desired.length)), 0, bookmarkId);
                        await this.reorder(current, desired);
                    }
                    await this.open(bookmarkId, tab?.windowId ?? message.windowId);
                    break;
                }
                case 'remove': {
                    for (const [tabId, bookmarkId] of Object.entries(this.bindings)) {
                        if (bookmarkId !== String(message.bookmarkId)) continue;
                        const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
                        if (tab?.pinned) await chrome.tabs.update(tab.id, { pinned: false });
                    }
                    const bookmark = (await this.readBookmarks()).find(node => String(node.id) === String(message.bookmarkId));
                    if (bookmark) await chrome.bookmarks.remove(bookmark.id);
                    break;
                }
                case 'reorder': await this.reorder(message.before, message.after); break;
                default: throw new Error('Unknown favorite action');
            }
            return this.reconcile();
        });
    }
    install() {
        const refresh = options => this.run(() => this.reconcile(options)).catch(console.error);
        chrome.tabs.onCreated.addListener(() => refresh());
        chrome.tabs.onUpdated.addListener((id, change, tab) => {
            if (change.pinned !== undefined || change.url || change.status === 'complete') refresh();
        });
        chrome.tabs.onRemoved.addListener(() => refresh());
        chrome.tabs.onActivated.addListener(() => refresh());
        chrome.tabs.onMoved.addListener((id, info) => refresh({ reorderWindowId: info.windowId }));
        chrome.tabs.onAttached.addListener(() => refresh());
        chrome.tabs.onDetached.addListener(() => refresh());
        chrome.tabs.onReplaced.addListener((added, removed) => this.run(async () => {
            if (this.bindings[removed]) { this.bindings[added] = this.bindings[removed]; delete this.bindings[removed]; }
            return this.reconcile();
        }).catch(console.error));
        const bookmarkChanged = (id, info) => {
            if (String(id) === String(this.folderId)) this.folderReady = false;
            if (String(id) === String(this.folderId) || [info?.parentId, info?.oldParentId].some(parent => String(parent) === String(this.folderId))
                || Object.values(this.bindings).includes(String(id)) || this.bookmarkIds?.has(String(id))) refresh();
        };
        chrome.bookmarks.onCreated.addListener(bookmarkChanged);
        chrome.bookmarks.onRemoved.addListener(bookmarkChanged);
        chrome.bookmarks.onMoved.addListener(bookmarkChanged);
        chrome.bookmarks.onChanged.addListener(bookmarkChanged);
        chrome.bookmarks.onChildrenReordered?.addListener(bookmarkChanged);
        refresh();
    }
}
