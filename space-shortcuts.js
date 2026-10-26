const selections = {
    selectSpace1: { index: 0 },
    selectSpace2: { index: 1 },
    selectSpace3: { index: 2 },
    selectSpace4: { index: 3 },
    nextSpace: { offset: 1 },
    previousSpace: { offset: -1 }
};

// Capture the originating window before waiting for earlier commands. A focus
// change during a rapid sequence must not redirect queued commands elsewhere.
export function createSpaceShortcutHandler(store) {
    let chain = Promise.resolve();
    return (command, tab) => {
        if (!Object.hasOwn(selections, command)) return null;
        const window = Number.isInteger(tab?.windowId) && tab.windowId >= 0
            ? Promise.resolve({ id: tab.windowId })
            : chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        // Handle resolution failures immediately, even while this command waits.
        const captured = window.then(value => ({ value }), error => ({ error }));
        const pending = chain.then(async () => {
            const { value, error } = await captured;
            if (error) throw error;
            if (!Number.isInteger(value?.id) || value.id < 0) return;
            return store.dispatch({ action: 'switch', windowId: value.id, ...selections[command] });
        });
        chain = pending.catch(() => {});
        return pending;
    };
}
