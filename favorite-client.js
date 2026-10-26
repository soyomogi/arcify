export async function favoriteRequest(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({ type: 'globalFavorites', action, ...payload });
    if (!response?.success) throw new Error(response?.error || 'Favorites are unavailable.');
    return response.favorites;
}
