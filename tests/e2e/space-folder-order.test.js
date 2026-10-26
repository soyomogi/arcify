import { launchBrowserWithExtension, openSidebar } from './helpers/extension-helper.js';

describe('Space and bookmark folder ordering', () => {
    let browser;
    afterAll(async () => { await browser?.close(); });
    test('persists a button drag, reflects a Chrome reorder, and rejects a drag from a stale view', async () => {
        let extensionId;
        ({ browser, extensionId } = await launchBrowserWithExtension());
        const helper = await browser.newPage();
        await helper.goto(`chrome-extension://${extensionId}/options.html`);
        const setup = await helper.evaluate(async () => {
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
            for (const title of ['Order A', 'Order B']) await chrome.bookmarks.create({ parentId: root.id, title });
            const { spaces } = await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
            return { rootId: root.id, spaces: spaces.map(({ id, bookmarkFolderId }) => ({ id, bookmarkFolderId })) };
        });
        const page = await openSidebar(browser, extensionId);
        const errors = [];
        page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.accept(); });
        await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('#spaceSwitcher button')];
            const dragged = buttons.at(-1), target = buttons[0];
            dragged.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
            const rect = target.getBoundingClientRect();
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.left + 1 }));
            dragged.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        const draggedOrder = [setup.spaces[2], setup.spaces[0], setup.spaces[1]];
        await helper.waitForFunction(async ({ rootId, expected }) => (await chrome.bookmarks.getChildren(rootId))
            .filter(node => !node.url).map(node => node.id).join(',') === expected.join(','), {},
        { rootId: setup.rootId, expected: draggedOrder.map(space => space.bookmarkFolderId) });
        expect(errors).toEqual([]);
        await page.waitForFunction(ids => [...document.querySelectorAll('#spaceSwitcher button')]
            .map(button => button.dataset.spaceId).join(',') === ids.join(','), {}, draggedOrder.map(space => space.id));

        // Start a drag from this view, then change Chrome's order while refresh is paused.
        await page.evaluate(() => document.querySelector('#spaceSwitcher button').dispatchEvent(new DragEvent('dragstart', {
            bubbles: true, dataTransfer: new DataTransfer()
        })));
        await helper.evaluate(async ({ folderId, rootId }) => {
            await chrome.bookmarks.move(folderId, { parentId: rootId, index: 0 });
            await chrome.runtime.sendMessage({ type: 'spaceStore', action: 'get' });
        }, { folderId: setup.spaces[1].bookmarkFolderId, rootId: setup.rootId });
        await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('#spaceSwitcher button')];
            const rect = buttons.at(-1).getBoundingClientRect();
            buttons.at(-1).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: rect.right - 1 }));
            buttons[0].dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        });
        await page.waitForFunction(ids => [...document.querySelectorAll('#spaceSwitcher button')]
            .map(button => button.dataset.spaceId).join(',') === ids.join(','), {},
        [setup.spaces[1].id, setup.spaces[2].id, setup.spaces[0].id]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('changed');
        expect(await helper.evaluate(async id => (await chrome.bookmarks.getChildren(id)).filter(node => !node.url).map(node => node.id), setup.rootId))
            .toEqual([setup.spaces[1].bookmarkFolderId, setup.spaces[2].bookmarkFolderId, setup.spaces[0].bookmarkFolderId]);
    });
});
