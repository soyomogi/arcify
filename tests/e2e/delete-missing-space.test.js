import { launchBrowserWithExtension, openSidebar } from './helpers/extension-helper.js';

describe('Delete a space with a missing bookmark folder', () => {
    let browser;
    afterAll(async () => { await browser?.close(); });
    test('removes the space and its registry entry without recreating the missing folder', async () => {
        let extensionId;
        ({ browser, extensionId } = await launchBrowserWithExtension());
        const helper = await browser.newPage();
        await helper.goto(`chrome-extension://${extensionId}/options.html`);
        const deleted = await helper.evaluate(async () => {
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            const folder = await chrome.bookmarks.create({ parentId: root.id, title: 'Missing folder space' });
            const { spaces } = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            const space = spaces.find(s => s.bookmarkFolderId === folder.id);
            await chrome.bookmarks.removeTree(folder.id);
            return { spaceId: space.id, folderId: folder.id };
        });
        const sidebar = await openSidebar(browser, extensionId);
        sidebar.on('dialog', dialog => dialog.accept());
        await sidebar.$eval(`[data-space-id="${deleted.spaceId}"] .delete-space-btn`, button => button.click());
        await helper.waitForFunction(async ({ spaceId, folderId }) => {
            const { spaces, spaceRegistry } = await chrome.storage.local.get(['spaces', 'spaceRegistry']);
            return !spaces.some(s => s.id === spaceId) && !spaceRegistry[folderId];
        }, {}, deleted);
        expect(await helper.evaluate(() => chrome.bookmarks.search({ title: 'Missing folder space' }))).toEqual([]);
        expect(await sidebar.$(`[data-space-id="${deleted.spaceId}"]`)).toBeNull();
    });
});
