import { launchBrowserWithExtension, openSidebar } from './helpers/extension-helper.js';

describe('Space shortcut switching', () => {
    let browser, extensionId, helper, setup;
    beforeAll(async () => {
        ({ browser, extensionId } = await launchBrowserWithExtension());
        helper = await browser.newPage();
        await helper.goto(`chrome-extension://${extensionId}/options.html`);
        setup = await helper.evaluate(async () => {
            const request = async (action, data = {}) => {
                const response = await chrome.runtime.sendMessage({ type: 'spaceStore', action, ...data });
                if (!response.success) throw new Error(response.error);
                return response.spaces;
            };
            await request('get');
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            for (const title of ['Shortcut B', 'Shortcut C', 'Shortcut D']) {
                await chrome.bookmarks.create({ parentId: root.id, title });
            }
            const spaces = await request('get');
            const { id: windowId } = await chrome.windows.getCurrent();
            const a = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
            const b = await chrome.tabs.create({ windowId, url: 'about:blank', active: false });
            await request('assign', { spaceId: spaces[0].id, tabId: a.id });
            await request('assign', { spaceId: spaces[1].id, tabId: b.id });
            const foreign = await chrome.windows.create({ url: 'about:blank', focused: false });
            const otherTab = foreign.tabs[0];
            await request('assign', { spaceId: spaces[1].id, tabId: otherTab.id });
            await chrome.tabs.update(otherTab.id, { active: true });
            await request('activate', { windowId: foreign.id, spaceId: spaces[0].id });
            return { windowId, otherWindowId: foreign.id, otherTabId: otherTab.id,
                a: a.id, b: b.id, spaces: spaces.map(s => s.id) };
        });
    });
    afterAll(async () => { await browser?.close(); });

    // Exercise the same worker store action used by the command handler. Actual
    // shortcut key routing belongs to Chrome and is not synthesized by Puppeteer.
    test('switches with the sidebar closed, serializes repeats, and leaves the other window alone', async () => {
        const state = await helper.evaluate(async setup => {
            for (const index of [0, 1, 2, 3]) {
                const result = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'switch', index, windowId: setup.windowId });
                if (!result.success) throw new Error(result.error);
                const { activeSpaces } = await chrome.storage.session.get('activeSpaces');
                if (activeSpaces[setup.windowId] !== setup.spaces[index]) throw new Error('Wrong space selected');
            }
            await Promise.all([1, 1, -1, 1].map(offset => chrome.runtime.sendMessage({
                type: 'spaceStore', action: 'switch', offset, windowId: setup.windowId
            })));
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            return {
                active: (await chrome.storage.session.get('activeSpaces')).activeSpaces,
                tabs: await chrome.tabs.query({ active: true })
            };
        }, setup);
        expect(state.active[setup.windowId]).toBe(setup.spaces[1]);
        expect(state.active[setup.otherWindowId]).toBe(setup.spaces[0]);
        expect(state.tabs.find(t => t.windowId === setup.windowId).id).toBe(setup.b);
        expect(state.tabs.find(t => t.windowId === setup.otherWindowId).id).toBe(setup.otherTabId);
    });

    test('an open sidebar follows selection of empty spaces without a tab activation event', async () => {
        const sidebar = await openSidebar(browser, extensionId);
        try {
            const windowId = await sidebar.evaluate(async () => (await chrome.windows.getCurrent()).id);
            await helper.evaluate(async ({ windowId }) => {
                const response = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'switch', index: 2, windowId });
                if (!response.success) throw new Error(response.error);
            }, { windowId });
            await sidebar.waitForFunction(id => document.querySelector('#spaceSwitcher button.active')?.dataset.spaceId === id,
                {}, setup.spaces[2]);
            expect(await sidebar.$eval('.space.active', el => el.dataset.spaceId)).toBe(setup.spaces[2]);
        } finally { await sidebar.close(); }
    });
});
