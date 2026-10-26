import { LocalStorage } from './localstorage.js';
import { enqueueBookmarkOperation } from './bookmark-writer.js';

const equal = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

export function orderSpacesByFolders(spaces, folders) {
    const ranks = new Map(folders.map((folder, index) => [String(folder.id), index]));
    return [...spaces].sort((a, b) => (ranks.get(String(a.bookmarkFolderId)) ?? Infinity)
        - (ranks.get(String(b.bookmarkFolderId)) ?? Infinity));
}

export async function reorderSpaceFolders(spaces, before, after) {
    const root = await LocalStorage.getOrCreateArcifyFolder();
    const children = await chrome.bookmarks.getChildren(root.id);
    const folders = children.filter(node => !node.url);
    const current = orderSpacesByFolders(spaces, folders);
    if (!Array.isArray(before) || !equal(before, current.map(space => space.id))) {
        throw new Error('Space order changed. Refresh and retry.');
    }
    if (!Array.isArray(after) || new Set(after).size !== after.length || after.length !== before.length
        || after.some(id => !before.includes(id))) throw new Error('Space order must include every space exactly once.');
    const byId = new Map(current.map(space => [space.id, String(space.bookmarkFolderId)]));
    if (current.some(space => !folders.some(folder => String(folder.id) === String(space.bookmarkFolderId)))) {
        throw new Error('A space bookmark folder is missing. Restore or delete that space before reordering.');
    }
    const desiredFolders = after.map(id => byId.get(id));
    let index = 0;
    const expected = children.map(node => String(node.id));
    const desired = children.map(node => node.url ? String(node.id) : desiredFolders[index++]);
    await enqueueBookmarkOperation({ parents: [{ parentId: root.id,
        expectedCanonicalIds: expected, desiredCanonicalIds: desired }] });
}
