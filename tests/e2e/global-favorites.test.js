import { createServer } from 'node:http';
import { launchBrowserWithExtension, openSidebar } from './helpers/extension-helper.js';

describe('Durable global favorites', () => {
    let browser, extensionId, helper, server, url, setup;
    beforeAll(async () => {
        server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Favorite fixture</title>'); });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${server.address().port}/`;
        ({ browser, extensionId } = await launchBrowserWithExtension());
        helper = await browser.newPage();
        await helper.goto(`chrome-extension://${extensionId}/options.html`);
        setup = await helper.evaluate(async url => {
            const { id: windowId } = await chrome.windows.getCurrent();
            const a = await chrome.tabs.create({ windowId, url, pinned: true, active: false });
            const b = await chrome.tabs.create({ windowId, url, pinned: true, active: false });
            const c = await chrome.tabs.create({ windowId, url: `${url}third`, pinned: true, active: false });
            return { windowId, a: a.id, b: b.id, c: c.id };
        }, url);
    });
    afterAll(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

    test('preserves closed and unpinned favorites with distinct same-URL identities, and synchronizes ordering', async () => {
        await helper.waitForFunction(async () => {
            const result = await chrome.runtime.sendMessage({ type: 'globalFavorites', action: 'get' });
            return result.success && result.favorites.bookmarks.length === 3;
        });
        const initial = await helper.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'globalFavorites', action: 'get' })).favorites);
        const a = initial.tabs.find(tab => tab.tabId === setup.a).bookmarkId;
        const b = initial.tabs.find(tab => tab.tabId === setup.b).bookmarkId;
        const c = initial.tabs.find(tab => tab.tabId === setup.c).bookmarkId;
        expect(a).not.toBe(b);
        expect(await helper.evaluate(async folderId => {
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            return (await chrome.bookmarks.getChildren(root.id)).some(node => node.id === folderId);
        }, initial.folderId)).toBe(false);
        await helper.evaluate(async ({ b, c }) => { await chrome.tabs.remove(b); await chrome.tabs.move(c, { index: 0 }); }, setup);
        await helper.waitForFunction(async expected => {
            const response = await chrome.runtime.sendMessage({ type: 'globalFavorites', action: 'get' });
            return response.favorites.bookmarks.map(node => node.bookmarkId).join(',') === expected.join(',');
        }, { polling: 100 }, [c, b, a]);

        const sidebar = await openSidebar(browser, extensionId);
        sidebar.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
        sidebar.on('pageerror', error => console.error(error.message));
        const icon = id => `#pinnedFavicons .pinned-favicon[data-bookmark-id="${id}"]`;
        await sidebar.waitForSelector(icon(b));
        expect(await sidebar.$eval(icon(b), el => el.dataset.tabId)).toBeUndefined();
        await sidebar.$eval(icon(b), el => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
        await sidebar.waitForFunction(id => !!document.querySelector(`#pinnedFavicons [data-bookmark-id="${id}"][data-tab-id]`), { polling: 100 }, b);
        const reopened = await sidebar.$eval(icon(b), el => Number(el.dataset.tabId));
        expect(reopened).not.toBe(setup.a);
        expect(reopened).not.toBe(setup.b);
        await helper.evaluate(id => chrome.tabs.update(id, { pinned: false }), setup.c);
        await sidebar.waitForFunction(id => { const el = document.querySelector(`#pinnedFavicons [data-bookmark-id="${id}"]`); return el && !el.dataset.tabId; }, { polling: 100 }, c);
        await sidebar.$eval(icon(c), el => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })));
        await sidebar.waitForFunction(({ id, tabId }) => document.querySelector(`#pinnedFavicons [data-bookmark-id="${id}"]`)?.dataset.tabId === String(tabId), { polling: 100 }, { id: c, tabId: setup.c });

        // Drag A to the front, then verify both bookmarks and native pinned tabs.
        await sidebar.evaluate(id => {
            const dragged = document.querySelector(`#pinnedFavicons [data-bookmark-id="${id}"]`);
            const first = document.querySelector('#pinnedFavicons .pinned-favicon');
            const rect = first.getBoundingClientRect();
            dragged.classList.add('dragging');
            first.parentElement.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true,
                clientX: rect.left + 1, clientY: rect.top + rect.height / 2 }));
        }, a);
        await helper.waitForFunction(async expected => {
            const response = await chrome.runtime.sendMessage({ type: 'globalFavorites', action: 'get' });
            return response.favorites.bookmarks.map(node => node.bookmarkId).join(',') === expected.join(',');
        }, { polling: 100 }, [a, c, b]);
        expect(await helper.evaluate(async windowId => (await chrome.tabs.query({ windowId, pinned: true }))
            .sort((a, b) => a.index - b.index).map(tab => tab.id), setup.windowId)).toEqual([setup.a, setup.c, reopened]);

        await sidebar.$eval(icon(a), el => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
        await sidebar.waitForSelector('#favorite-context-menu .context-menu-item');
        await sidebar.bringToFront();
        await sidebar.click('#favorite-context-menu .context-menu-item');
        await sidebar.waitForFunction(id => !document.querySelector(`#pinnedFavicons [data-bookmark-id="${id}"]`), { polling: 100 }, a);
        expect(await helper.evaluate(async id => (await chrome.tabs.get(id)).pinned, setup.a)).toBe(false);
        expect(await helper.evaluate(async id => { try { await chrome.bookmarks.get(id); return true; } catch { return false; } }, a)).toBe(false);
        expect(await helper.evaluate(async id => (await chrome.bookmarks.get(id))[0].id, b)).toBe(b);
        await sidebar.close();
    });
});
