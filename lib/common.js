// Shared helpers used by both the background worker and the side panel.

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
export const HISTORY_MAX = 10; // how many previous browser sessions to keep

export const uid = () => crypto.randomUUID();

export async function getLocal(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
}

export const setLocal = (key, value) => chrome.storage.local.set({ [key]: value });

// ---- Library ---------------------------------------------------------------
// library = { groups: [{ id, title, color, tabs: [{ id, url, title }], createdAt, updatedAt }] }

export const getLibrary = () => getLocal('library', { groups: [] });

// Serialises read-modify-write updates made from this context.
let chain = Promise.resolve();
export function updateLibrary(fn) {
  const run = chain.then(async () => {
    const lib = await getLibrary();
    const result = await fn(lib);
    await setLocal('library', lib);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

// ---- Sessions --------------------------------------------------------------

// New-tab pages, blank pages and this extension's own pages are not worth saving.
const SKIP = /^(about:|devtools:|chrome-search:)|^[a-z-]+:\/\/(newtab|new-tab-page|startpage|startpageshared)\b/i;

export function isSavableUrl(url) {
  if (!url) return false;
  if (url.startsWith(chrome.runtime.getURL(''))) return false;
  return !SKIP.test(url);
}

// Snapshot of every normal (non-incognito) window.
// session = { id, savedAt, windows: [{ entries: [ {type:'group', title, color, collapsed, tabs:[...]}, {type:'tab', url, title, pinned} ] }] }
export async function captureSession() {
  const [windows, groups] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
  ]);
  const gmap = new Map(groups.map((g) => [g.id, g]));
  const out = [];
  for (const w of windows) {
    if (w.incognito) continue;
    const entries = [];
    let current = null;
    for (const t of w.tabs || []) {
      const url = t.url || t.pendingUrl;
      if (!isSavableUrl(url)) continue;
      const tab = { url, title: t.title || url, pinned: !!t.pinned };
      if (t.groupId !== -1 && gmap.has(t.groupId)) {
        if (!current || current.groupId !== t.groupId) {
          const g = gmap.get(t.groupId);
          current = { type: 'group', groupId: t.groupId, title: g.title || '', color: g.color, collapsed: !!g.collapsed, tabs: [] };
          entries.push(current);
        }
        current.tabs.push(tab);
      } else {
        current = null;
        entries.push({ type: 'tab', ...tab });
      }
    }
    if (entries.length) out.push({ entries });
  }
  return { id: uid(), savedAt: Date.now(), windows: out };
}

export function countTabs(session) {
  if (!session?.windows) return 0;
  let n = 0;
  for (const w of session.windows) for (const e of w.entries) n += e.type === 'group' ? e.tabs.length : 1;
  return n;
}
