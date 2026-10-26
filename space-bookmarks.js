import { Utils } from './utils.js';
import { LocalStorage } from './localstorage.js';

// Deletion may outlive its bookmark folder. Prove absence by ID before ignoring
// a failure; moved folders and ordinary API failures must still be reported.
export async function removeSpaceBookmarkFolder(space) {
    if (!space?.bookmarkFolderId) return;
    try {
        const folder = await getSpaceBookmarkFolder(space);
        await chrome.bookmarks.removeTree(folder.id);
    } catch (error) {
        const contains = nodes => nodes.some(node => String(node.id) === String(space.bookmarkFolderId)
            || (node.children && contains(node.children)));
        if (contains(await chrome.bookmarks.getTree())) throw error;
    }
    await LocalStorage.removeSpaceRegistryEntry(space.bookmarkFolderId);
}

export async function getSpaceBookmarkFolder(space) {
    if (!space?.bookmarkFolderId) throw new Error('This space has no bookmark folder association.');
    const [folder] = await chrome.bookmarks.get(space.bookmarkFolderId);
    if (!folder || folder.url) throw new Error('The bookmark folder for this space is unavailable.');
    const root = (await chrome.bookmarks.search({ title: 'Arcify' })).find(node => !node.url);
    if (!root || String(folder.parentId) !== String(root.id)) {
        throw new Error('The bookmark folder is no longer inside the Arcify folder.');
    }
    return folder;
}

export async function getSpaceBookmarkTree(space) {
    const folder = await getSpaceBookmarkFolder(space);
    const read = async node => ({
        ...node,
        children: await Promise.all((await chrome.bookmarks.getChildren(node.id)).map(child =>
            child.url ? Promise.resolve({ ...child }) : read(child)))
    });
    return read(folder);
}

export async function getSpaceBookmarkById(space, bookmarkId) {
    if (!bookmarkId) return null;
    const folder = await getSpaceBookmarkFolder(space);
    async function find(parentId) {
        for (const node of await chrome.bookmarks.getChildren(parentId)) {
            if (String(node.id) === String(bookmarkId)) return node.url ? node : null;
            if (!node.url) {
                const match = await find(node.id);
                if (match) return match;
            }
        }
        return null;
    }
    return find(folder.id);
}

export async function removeSpacePin(space, tab) {
    const binding = tab.id ? await Utils.getPinnedTabState(tab.id) : null;
    const bookmarkId = tab.bookmarkId || binding?.bookmarkId;
    if (!bookmarkId) throw new Error('Cannot remove a favorite without its bookmark identity.');
    const bookmark = await getSpaceBookmarkById(space, bookmarkId);
    if (bookmark) await chrome.bookmarks.remove(bookmark.id);
}
