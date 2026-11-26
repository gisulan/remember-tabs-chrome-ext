// Opening saved tabs/groups back into the browser.
import { GROUP_COLORS } from './common.js';

// Puts a freshly opened background tab to sleep once it has a title,
// so restored tabs use almost no memory until you click them.
export function discardSoon(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      try {
        const t = await chrome.tabs.get(tabId);
        if (!t.active && !t.discarded) await chrome.tabs.discard(tabId);
      } catch { /* tab closed or can't be discarded */ }
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && (info.title || info.status === 'complete')) finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, 6000);
  });
}

// Opens tabs at the end of a window; optionally wraps them in a tab group.
export async function openTabsInWindow(windowId, tabs, { group = null, lazy = true } = {}) {
  const tabIds = [];
  for (const t of tabs) {
    try {
      const tab = await chrome.tabs.create({ windowId, url: t.url, active: false, pinned: !group && !!t.pinned });
      tabIds.push(tab.id);
    } catch (e) {
      console.warn('Could not open', t.url, e);
    }
  }
  let groupId = null;
  if (group && tabIds.length) {
    groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, {
      title: group.title || '',
      color: GROUP_COLORS.includes(group.color) ? group.color : 'grey',
      collapsed: !!group.collapsed,
    });
  }
  // Hand discarding to the background worker so it finishes even if the panel closes.
  if (lazy && tabIds.length) {
    chrome.runtime.sendMessage({ type: 'discard', tabIds }).catch(() => tabIds.forEach((id) => discardSoon(id)));
  }
  return { tabIds, groupId };
}

export const openSingleTab = (windowId, url) => chrome.tabs.create({ windowId, url, active: true });

// Recreates one saved window (groups, order, pinned tabs) in a new browser window.
export async function restoreWindow(win, lazy) {
  const w = await chrome.windows.create({ focused: true });
  const placeholder = w.tabs?.[0]?.id;
  for (const e of win.entries) {
    if (e.type === 'group') await openTabsInWindow(w.id, e.tabs, { group: e, lazy });
    else await openTabsInWindow(w.id, [e], { lazy });
  }
  if (placeholder != null) await chrome.tabs.remove(placeholder).catch(() => {});
}

export async function restoreSession(session, lazy) {
  for (const win of session.windows) await restoreWindow(win, lazy);
}
