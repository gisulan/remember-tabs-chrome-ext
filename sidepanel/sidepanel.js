import {
  GROUP_COLORS, HISTORY_MAX, uid, getLocal, setLocal, getLibrary, updateLibrary, isSavableUrl, countTabs,
} from '../lib/common.js';
import { openTabsInWindow, openSingleTab, restoreWindow, restoreSession } from '../lib/restore.js';
import {
  getConfig, setConfig, getStatus, signIn, signOut, runBackup, listBackups, downloadBackup,
  redirectUri, defaultDevice, backupFileName,
} from '../lib/onedrive.js';
import { SHARED_CLIENT_ID } from '../lib/config.js';

const $ = (s) => document.querySelector(s);
const main = $('#main');
const dlg = $('#modal');
const NEW = '__new__';

const state = {
  view: 'open',
  query: '',
  windowId: null,
  expanded: new Set(),
  historyIndex: 0,
  library: { groups: [] },
  history: [],
  settings: { lazy: true },
  links: {}, // open tabGroupId -> library group id (for this browser session)
  open: { groups: [], ungrouped: [] },
  cloud: { config: {}, status: {}, account: null },
};
let drag = null;
let pendingRefresh = false;

// ---------------------------------------------------------------------------
// Tiny DOM helper
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const favicon = (url) => chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
const fmtDate = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const matches = (q, ...fields) => fields.some((f) => f && f.toLowerCase().includes(q));

function prettyUrl(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname + u.search + u.hash).replace(/\/$/, '') || url;
  } catch { return url; }
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}

// ---------------------------------------------------------------------------
// Dialogs
function openDialog(content, onClose) {
  dlg.replaceChildren(content);
  dlg.returnValue = '';
  dlg.onclose = () => onClose(dlg.returnValue);
  dlg.showModal();
}

// buttons: [[value, label, style?]]; first button is the default/primary one.
function choose(title, message, buttons) {
  return new Promise((resolve) => {
    const btns = buttons.map(([value, label, style], i) =>
      h('button', { class: `btn ${style || (i === 0 ? 'primary' : '')}`, onclick: () => dlg.close(value) }, label));
    openDialog(h('div', {}, h('h3', {}, title), message ? h('p', {}, message) : null, h('div', { class: 'btns' }, btns)),
      (rv) => resolve(rv || 'cancel'));
    btns[0]?.focus();
  });
}

function groupDialog(heading, { name = '', color = 'blue' } = {}) {
  return new Promise((resolve) => {
    let sel = GROUP_COLORS.includes(color) ? color : 'grey';
    const input = h('input', { type: 'text', value: name, placeholder: 'Group name', 'aria-label': 'Group name' });
    const sw = h('div', { class: 'swatches' }, GROUP_COLORS.map((c) => h('button', {
      type: 'button', class: `c-${c}${c === sel ? ' sel' : ''}`, title: c, 'aria-label': c,
      onclick: () => { sel = c; sw.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.title === c)); },
    })));
    const form = h('form', { method: 'dialog' },
      h('h3', {}, heading), input, sw,
      h('div', { class: 'btns' },
        h('button', { class: 'btn primary', value: 'ok' }, 'Save'),
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel')));
    openDialog(form, (rv) => resolve(rv === 'ok' ? { name: input.value.trim() || 'Untitled group', color: sel } : null));
    input.focus();
    input.select();
  });
}

function pickGroup(heading) {
  return new Promise((resolve) => {
    const list = h('div', { class: 'pick' },
      h('button', { onclick: () => dlg.close(NEW) }, h('span', { class: 'swatch' }), h('b', { class: 'name' }, '+ New group…')),
      state.library.groups.map((g) => h('button', { class: `c-${g.color}`, onclick: () => dlg.close(g.id) },
        h('span', { class: 'swatch' }), h('span', { class: 'name' }, g.title || 'Untitled'), h('span', { class: 'count' }, g.tabs.length))));
    openDialog(h('div', {}, h('h3', {}, heading), list,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => dlg.close('') }, 'Cancel'))),
    (rv) => resolve(rv || null));
  });
}

// ---------------------------------------------------------------------------
// Data
async function loadOpen() {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId: state.windowId }),
    chrome.tabGroups.query({ windowId: state.windowId }),
  ]);
  const gmap = new Map(groups.map((g) => [g.id, { id: g.id, title: g.title, color: g.color, collapsed: g.collapsed, tabs: [] }]));
  const ungrouped = [];
  for (const t of tabs) {
    const url = t.url || t.pendingUrl;
    if (!isSavableUrl(url)) continue;
    const tab = { tabId: t.id, index: t.index, url, title: t.title || url, pinned: t.pinned, active: t.active, discarded: t.discarded };
    (gmap.get(t.groupId)?.tabs ?? ungrouped).push(tab);
  }
  const list = [...gmap.values()].filter((g) => g.tabs.length).sort((a, b) => a.tabs[0].index - b.tabs[0].index);
  return { groups: list, ungrouped };
}

async function loadAll() {
  const [library, history, settings, sess, open, config, status, auth] = await Promise.all([
    getLibrary(), getLocal('sessionHistory', []), getLocal('settings', {}),
    chrome.storage.session.get('links'), loadOpen(), getConfig(), getStatus(), getLocal('cloudAuth', null),
  ]);
  Object.assign(state, {
    library, history, settings: { lazy: true, ...settings }, links: sess.links || {}, open,
    cloud: { config, status, account: auth?.account || null },
  });
  $('#lazy').checked = state.settings.lazy;
}

// url -> list of library groups containing it (a group appears twice if it holds the url twice)
function libraryIndex() {
  const idx = new Map();
  for (const g of state.library.groups) for (const t of g.tabs) {
    if (!idx.has(t.url)) idx.set(t.url, []);
    idx.get(t.url).push(g);
  }
  return idx;
}

const groupNames = (groups) => [...new Set(groups.map((g) => g.title || 'Untitled'))].join(', ');

async function setLink(tabGroupId, libId) {
  const { links = {} } = await chrome.storage.session.get('links');
  links[tabGroupId] = libId;
  await chrome.storage.session.set({ links });
  state.links = links;
}

async function findOpenLinkedGroup(libId) {
  for (const [tgid, lid] of Object.entries(state.links)) {
    if (lid !== libId) continue;
    try { return await chrome.tabGroups.get(Number(tgid)); } catch { /* closed */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
function refresh() {
  if (refresh.queued) return;
  refresh.queued = true;
  setTimeout(async () => {
    refresh.queued = false;
    if (drag || dlg.open) { pendingRefresh = true; return; }
    await loadAll();
    render();
  }, 80);
}

function render() {
  const q = state.query.trim().toLowerCase();
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('active', !q && b.dataset.view === state.view));
  const st = main.scrollTop;
  main.replaceChildren(q ? renderSearch(q) : { open: renderOpenView, library: renderLibraryView, last: renderLastView }[state.view](''));
  main.scrollTop = st;
  renderCloudStatus();
}

// ---- OneDrive backup ---------------------------------------------------------
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtDate(ts);
}

// One summary of the backup state, shared by the footer and the dialog.
function cloudSummary() {
  const { config, status, account } = state.cloud;
  if (!config.clientId) return { cls: '', text: 'OneDrive backup: not set up. Click to set up.' };
  if (!account) return { cls: 'warn', text: 'OneDrive backup: not signed in. Click to sign in.' };
  if (status.state === 'working' && Date.now() - (status.workingSince || 0) < 120000) return { cls: 'working', text: 'Backing up to OneDrive…' };
  if (status.state === 'signin') return { cls: 'warn', text: 'OneDrive: sign in again to keep backing up' };
  if (status.state === 'error') return { cls: 'bad', text: 'OneDrive backup failed. Click for details.' };
  if (status.lastBackupAt) return { cls: 'ok', text: `Backed up to OneDrive · ${ago(status.lastBackupAt)}` };
  return { cls: 'working', text: 'OneDrive: signed in, waiting for first backup' };
}

function renderCloudStatus() {
  const { cls, text } = cloudSummary();
  const btn = $('#cloud');
  btn.className = `cloud ${cls}`;
  btn.replaceChildren(h('span', { class: 'dot' }), h('span', {}, text));
}

function openCloudDialog() {
  const { config, status, account } = state.cloud;
  if (!config.clientId) { cloudSetupDialog(); return; }
  const { text } = cloudSummary();
  const lines = [h('div', {}, h('b', {}, 'Status: '), text)];
  if (account) lines.push(h('div', {}, h('b', {}, 'Account: '), account));
  lines.push(h('div', {}, h('b', {}, 'File: '), h('code', {}, `OneDrive › Apps › … › ${backupFileName(config.device || defaultDevice())}`)));
  if (status.lastBackupAt) lines.push(h('div', {}, h('b', {}, 'Last backup: '), fmtDate(status.lastBackupAt)));
  if (status.lastError && status.state !== 'ok') lines.push(h('div', { class: 'err' }, h('b', {}, 'Last error: '), status.lastError));

  const btn = (value, label, primary) => h('button', { class: `btn${primary ? ' primary' : ''}`, onclick: () => dlg.close(value) }, label);
  const needsSignIn = !account || status.state === 'signin';
  const buttons = needsSignIn
    ? [btn('signin', 'Sign in with Microsoft', true), btn('setup', 'Setup'), btn('', 'Close')]
    : [btn('backup', 'Back up now', true), btn('restore', 'Restore…'), btn('signout', 'Sign out'), btn('setup', 'Setup'), btn('', 'Close')];
  dlg.classList.add('wide');
  openDialog(h('div', {},
    h('h3', {}, 'OneDrive backup'),
    h('p', {}, 'Backs up your library and recent sessions automatically: a minute after any change to the library, and hourly otherwise.'),
    h('div', { class: 'status-box' }, lines),
    h('div', { class: 'btns' }, buttons)), (rv) => { dlg.classList.remove('wide'); cloudAction(rv); });
}

async function cloudAction(action) {
  try {
    if (action === 'setup') return cloudSetupDialog();
    if (action === 'signin') {
      toast('Opening Microsoft sign-in…');
      const account = await signIn();
      toast(`Signed in as ${account}. Backing up…`);
      await runBackup({ force: true });
      toast('Backed up to OneDrive ✓');
    } else if (action === 'backup') {
      toast('Backing up…');
      await runBackup({ force: true });
      toast('Backed up to OneDrive ✓');
    } else if (action === 'signout') {
      await signOut();
      toast('Signed out of OneDrive backup');
    } else if (action === 'restore') {
      await restoreFromCloud();
    }
  } catch (e) {
    await choose('OneDrive', e.message, [['ok', 'OK']]);
  } finally {
    refresh();
  }
}

function cloudSetupDialog() {
  const cfg = state.cloud.config;
  const uri = redirectUri();
  const clientInput = h('input', {
    type: 'text', id: 'cid',
    value: cfg.usingShared ? '' : (cfg.clientId || ''),
    placeholder: SHARED_CLIENT_ID ? 'Leave empty to use the shared app' : '00000000-0000-0000-0000-000000000000',
  });
  const tenantSel = h('select', { id: 'tenant' },
    [['common', 'Personal and work/school accounts'], ['consumers', 'Personal accounts only'], ['organizations', 'Work/school accounts only']]
      .map(([v, l]) => h('option', { value: v, selected: (cfg.tenant || 'common') === v }, l)));
  const deviceInput = h('input', { type: 'text', value: cfg.device || defaultDevice(), id: 'device' });
  const uriInput = h('input', { type: 'text', value: uri, readonly: true, 'aria-label': 'Redirect URI' });
  const link = (href, text) => h('a', { href, onclick: (e) => { e.preventDefault(); chrome.tabs.create({ url: href }); } }, text);

  const form = h('form', { method: 'dialog' },
    h('h3', {}, 'Set up OneDrive backup'),
    h('p', {}, SHARED_CLIENT_ID
      ? 'This copy already includes a shared Microsoft app, so you can just sign in. Only follow these steps if you want to use your own app registration instead.'
      : 'You need to do this once: register a free app with Microsoft so the extension can sign in.'),
    h('ol', {},
      h('li', {}, 'Open ', link('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade', 'Microsoft Entra › App registrations › New registration'), ' and sign in with your Microsoft account.'),
      h('li', {}, 'Name it anything, e.g. ', h('code', {}, 'Remember Tabs'), '.'),
      h('li', {}, 'Supported account types: ', h('b', {}, 'Accounts in any organizational directory and personal Microsoft accounts'), '.'),
      h('li', {}, 'Redirect URI: choose platform ', h('b', {}, 'Single-page application (SPA)'), ' and paste the address below. Then click Register.'),
      h('li', {}, 'Copy the ', h('b', {}, 'Application (client) ID'), ' from the overview page and paste it here.')),
    h('label', { class: 'field' }, 'Redirect URI (the same in Edge, Brave and Chrome)'),
    h('div', { class: 'copyrow' }, uriInput,
      h('button', { type: 'button', class: 'btn', onclick: async () => { await navigator.clipboard.writeText(uri); toast('Copied'); } }, 'Copy')),
    h('label', { class: 'field', for: 'cid' }, 'Application (client) ID'), clientInput,
    h('label', { class: 'field', for: 'tenant' }, 'Account type (must match the app registration)'), tenantSel,
    h('label', { class: 'field', for: 'device' }, 'Name for this browser’s backup'), deviceInput,
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', value: 'ok' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close('cancel') }, 'Cancel')));

  dlg.classList.add('wide');
  openDialog(form, async (rv) => {
    dlg.classList.remove('wide');
    if (rv !== 'ok') return;
    const clientId = clientInput.value.trim();
    if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      await choose('Check the client ID', 'It should look like 1a2b3c4d-1234-5678-9abc-1234567890ab.', [['ok', 'OK']]);
      return cloudSetupDialog();
    }
    await setConfig({ clientId, tenant: tenantSel.value, device: deviceInput.value.trim() || defaultDevice() });
    const next = await getConfig();
    const changed = next.clientId !== cfg.clientId || next.tenant !== cfg.tenant;
    if (changed) await signOut();
    state.cloud = { ...state.cloud, config: await getConfig(), account: changed ? null : state.cloud.account };
    renderCloudStatus();
    if (next.clientId && (changed || !state.cloud.account)) {
      const c = await choose('Saved', 'Sign in with Microsoft now to start backing up?', [['signin', 'Sign in'], ['later', 'Later', '']]);
      if (c === 'signin') cloudAction('signin');
    }
  });
}

async function restoreFromCloud() {
  toast('Loading backups from OneDrive…');
  const files = await listBackups();
  if (!files.length) { await choose('No backups yet', 'There are no backups in your OneDrive app folder.', [['ok', 'OK']]); return; }
  const name = await new Promise((resolve) => {
    const list = h('div', { class: 'pick' }, files.map((f) => h('button', { onclick: () => dlg.close(f.name) },
      h('span', { class: 'name' }, f.name.replace(/^backup-|\.json$/g, '')),
      h('span', { class: 'count' }, fmtDate(Date.parse(f.lastModifiedDateTime))))));
    openDialog(h('div', {}, h('h3', {}, 'Restore from OneDrive'), h('p', {}, 'Pick which browser’s backup to restore:'), list,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => dlg.close('') }, 'Cancel'))), (rv) => resolve(rv || null));
  });
  if (!name) return;
  await importBackup(await downloadBackup(name));
}

function iconBtn(label, title, onclick, cls = '') {
  return h('button', {
    class: `icon ${cls}`, title, 'aria-label': title,
    onclick: (e) => { e.stopPropagation(); onclick(e); },
  }, label);
}

const badge = (text, title, soft) => h('span', { class: `badge${soft ? ' soft' : ''}`, title }, text);

function tabRow(t, { onClick, actions = [], badges = [], rowProps = {} }) {
  return h('div', { class: `tab${t.active ? ' active' : ''}${t.discarded ? ' sleeping' : ''}`, title: t.url, ...rowProps },
    h('img', { class: 'fav', src: favicon(t.url), alt: '', loading: 'lazy' }),
    h('div', { class: 'tab-text', onclick: onClick },
      h('div', { class: 'tab-title' }, t.title || t.url),
      h('div', { class: 'tab-url' }, prettyUrl(t.url))),
    badges,
    h('div', { class: 'actions' }, actions));
}

function groupCard({ key, color, title, count, extra = [], actions = [], body, forceOpen = false, cardProps = {} }) {
  const open = forceOpen || state.expanded.has(key);
  return h('section', { class: `group c-${color || 'grey'}`, ...cardProps },
    h('div', { class: 'group-head', onclick: () => { state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key); render(); } },
      h('span', { class: 'chev' }, open ? '▾' : '▸'),
      h('span', { class: 'gtitle' }, title || 'Untitled'),
      extra,
      h('span', { class: 'count' }, count),
      h('div', { class: 'actions' }, actions)),
    open ? h('div', { class: 'group-body' }, body()) : null);
}

function filterGroup(g, q) {
  if (!q || matches(q, g.title)) return g;
  const tabs = g.tabs.filter((t) => matches(q, t.title, t.url));
  return tabs.length ? { ...g, tabs } : null;
}

const empty = (text) => h('div', { class: 'empty' }, text);
const hasResults = (node) => !!node.querySelector('.tab, .group');

// ---- Open now --------------------------------------------------------------
function renderOpenView(q) {
  const { groups, ungrouped } = state.open;
  const idx = libraryIndex();
  const openCount = new Map();
  for (const t of [...groups.flatMap((g) => g.tabs), ...ungrouped]) openCount.set(t.url, (openCount.get(t.url) || 0) + 1);

  const row = (t) => {
    const badges = [];
    if (openCount.get(t.url) > 1) badges.push(badge('Open twice', 'This exact URL is open in more than one tab in this window'));
    const saved = idx.get(t.url);
    if (saved) badges.push(badge('Saved', `Saved in: ${groupNames(saved)}`, true));
    return tabRow(t, {
      onClick: () => chrome.tabs.update(t.tabId, { active: true }),
      badges,
      actions: [
        iconBtn('+', 'Add to a saved group', () => addTabsToLibrary([t], `Add “${t.title}” to…`)),
        iconBtn('×', 'Close tab', () => chrome.tabs.remove(t.tabId)),
      ],
    });
  };

  const gs = groups.map((g) => filterGroup(g, q)).filter(Boolean);
  const ug = q ? ungrouped.filter((t) => matches(q, t.title, t.url)) : ungrouped;
  const out = h('div', {});
  if (!q) {
    const total = groups.reduce((n, g) => n + g.tabs.length, 0) + ungrouped.length;
    out.append(h('p', { class: 'hint' }, `${plural(total, 'tab')} · ${plural(groups.length, 'group')} in this window`));
  }
  for (const g of gs) {
    const full = groups.find((x) => x.id === g.id);
    const linked = state.library.groups.find((x) => x.id === state.links[g.id]);
    out.append(groupCard({
      key: `open:${g.id}`, color: g.color, title: g.title, count: g.tabs.length, forceOpen: !!q,
      extra: linked ? badge('Saved', `Linked to “${linked.title}” in your library`, true) : null,
      actions: [
        iconBtn('Save', 'Save this group to your library', () => onSaveOpenGroup(full), 'text'),
        iconBtn('Close', 'Close this group', () => onCloseOpenGroup(full), 'text'),
      ],
      body: () => g.tabs.map(row),
    }));
  }
  if (ug.length) {
    out.append(h('div', { class: 'section' }, 'Not in a group', h('span', { class: 'spacer' }),
      !q && iconBtn('Save all…', 'Add all ungrouped tabs to a saved group', () => addTabsToLibrary(ungrouped, `Add ${plural(ungrouped.length, 'tab')} to…`), 'text')));
    out.append(...ug.map(row));
  }
  if (!q && !gs.length && !ug.length) out.append(empty('No tabs in this window.'));
  return out;
}

async function onSaveOpenGroup(g) {
  const before = libraryIndex();
  const r = await saveGroupToLibrary(g, state.links[g.id]);
  if (!r) return;
  await setLink(g.id, r.id);
  const crossDupes = g.tabs.filter((t) => (before.get(t.url) || []).some((x) => x.id !== r.id)).length;
  let msg = r.skipped ? `${plural(r.added, 'tab')} added, ${r.skipped} already there.` : `${plural(r.added, 'tab')} saved.`;
  if (crossDupes) msg += ` ${crossDupes} of them are also saved in other groups.`;
  const c = await choose(`Saved “${r.title}”`, `${msg} Close its ${plural(g.tabs.length, 'tab')} now to free memory?`,
    [['close', 'Close tabs'], ['keep', 'Keep open']]);
  if (c === 'close') await chrome.tabs.remove(g.tabs.map((t) => t.tabId));
}

async function onCloseOpenGroup(g) {
  const saved = state.library.groups.some((x) => x.id === state.links[g.id]);
  const n = plural(g.tabs.length, 'tab');
  const c = saved
    ? await choose(`Close “${g.title || 'Untitled'}”?`, `Its ${n} will close. It stays in your library.`, [['close', 'Close'], ['cancel', 'Cancel']])
    : await choose(`Close “${g.title || 'Untitled'}”?`, `Its ${n} will close. This group isn't saved in your library.`,
      [['save', 'Save first'], ['close', 'Close without saving'], ['cancel', 'Cancel']]);
  if (c === 'save') return onSaveOpenGroup(g);
  if (c === 'close') await chrome.tabs.remove(g.tabs.map((t) => t.tabId));
}

// Saves {title, color, tabs} into the library. Returns { id, title, added, skipped } or null.
async function saveGroupToLibrary(src, linkedId) {
  let target = linkedId ? state.library.groups.find((x) => x.id === linkedId) : null;
  let mode = 'new';
  if (target) {
    mode = await choose(`Update “${target.title || 'Untitled'}”?`, 'This group is already in your library.',
      [['merge', 'Add new tabs'], ['replace', 'Replace saved tabs'], ['new', 'Save as a new group'], ['cancel', 'Cancel', '']]);
  } else if (src.title && (target = state.library.groups.find((x) => x.title.toLowerCase() === src.title.toLowerCase()))) {
    mode = await choose(`“${target.title}” already exists`, 'Your library already has a group with this name.',
      [['merge', 'Merge into it'], ['new', 'Save as a new group'], ['cancel', 'Cancel']]);
  }
  if (mode === 'cancel') return null;
  const fresh = src.tabs.map((t) => ({ id: uid(), url: t.url, title: t.title }));
  return updateLibrary((lib) => {
    const now = Date.now();
    if (mode === 'new') {
      const g = { id: uid(), title: src.title || 'Untitled group', color: src.color || 'grey', tabs: fresh, createdAt: now, updatedAt: now };
      lib.groups.unshift(g);
      return { id: g.id, title: g.title, added: fresh.length, skipped: 0 };
    }
    const g = lib.groups.find((x) => x.id === target.id);
    let added = fresh;
    if (mode === 'replace') g.tabs = fresh;
    else {
      const have = new Set(g.tabs.map((t) => t.url));
      added = fresh.filter((t) => !have.has(t.url) && have.add(t.url));
      g.tabs.push(...added);
    }
    g.updatedAt = now;
    return { id: g.id, title: g.title, added: added.length, skipped: fresh.length - added.length };
  });
}

// Adds tabs to a saved group the user picks, asking about every exact-URL duplicate.
async function addTabsToLibrary(tabs, heading) {
  let target = await pickGroup(heading);
  if (!target) return;
  if (target === NEW) {
    const r = await groupDialog('New group');
    if (!r) return;
    target = uid();
    await updateLibrary((lib) => { lib.groups.unshift({ id: target, title: r.name, color: r.color, tabs: [], createdAt: Date.now(), updatedAt: Date.now() }); });
    state.library = await getLibrary();
  }
  await addToGroup(target, tabs);
}

async function addToGroup(groupId, tabs) {
  const idx = libraryIndex();
  const toAdd = [];
  for (const t of tabs) {
    const where = idx.get(t.url);
    if (where?.length) {
      const here = where.some((g) => g.id === groupId);
      const c = await choose(here ? 'Already in this group' : 'Already saved',
        `“${t.title}” is already saved in: ${groupNames(where)}.`, [['skip', 'Skip'], ['add', 'Add anyway', '']]);
      if (c !== 'add') continue;
    }
    toAdd.push({ id: uid(), url: t.url, title: t.title });
  }
  if (!toAdd.length) return;
  const title = await updateLibrary((lib) => {
    const g = lib.groups.find((x) => x.id === groupId);
    if (!g) return null;
    g.tabs.push(...toAdd);
    g.updatedAt = Date.now();
    return g.title;
  });
  if (title != null) toast(`Added ${plural(toAdd.length, 'tab')} to “${title}”`);
}

// ---- Library ---------------------------------------------------------------
function renderLibraryView(q) {
  const out = h('div', {});
  if (!q) {
    out.append(h('div', { class: 'toolbar' },
      h('button', { class: 'btn primary', onclick: newGroup }, '+ New group'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: exportData, title: 'Download a backup file' }, 'Export'),
      h('button', { class: 'btn', onclick: () => $('#importFile').click(), title: 'Load a backup file' }, 'Import')));
  }
  const idx = libraryIndex();
  const gs = state.library.groups.map((g) => filterGroup(g, q)).filter(Boolean);
  if (!gs.length && !q) out.append(empty('No saved groups yet. Save one from “Open now”, or create one here.'));
  for (const g of gs) out.append(libraryGroupCard(state.library.groups.find((x) => x.id === g.id), g, idx, !q));
  return out;
}

function libraryGroupCard(g, shown, idx, dnd) {
  return groupCard({
    key: `lib:${g.id}`, color: g.color, title: g.title, count: g.tabs.length, forceOpen: !dnd,
    actions: [
      iconBtn('Open', 'Open this group in the window', () => openLibraryGroup(g), 'text'),
      iconBtn('+', 'Add the current tab to this group', () => addActiveTab(g)),
      iconBtn('✎', 'Rename or change color', () => editGroup(g)),
      iconBtn('🗑', 'Delete group', () => deleteGroup(g)),
    ],
    body: () => (shown.tabs.length
      ? shown.tabs.map((t) => libraryTabRow(g, t, idx, dnd))
      : h('div', { class: 'hint pad' }, dnd ? 'Empty. Use + or drag tabs here.' : 'Empty.')),
    cardProps: dnd ? groupDndProps(g) : {},
  });
}

function libraryTabRow(g, t, idx, dnd) {
  const where = idx.get(t.url) || [];
  const badges = [];
  if (where.length > 1) {
    const others = where.filter((x) => x.id !== g.id);
    const sameGroupTwice = where.filter((x) => x.id === g.id).length > 1;
    const parts = [];
    if (sameGroupTwice) parts.push('twice in this group');
    if (others.length) parts.push(`also in: ${groupNames(others)}`);
    badges.push(badge('Duplicate', parts.join('; ')));
  }
  return tabRow(t, {
    onClick: () => openSingleTab(state.windowId, t.url),
    badges,
    actions: [iconBtn('×', 'Remove from this group', () => removeTab(g, t))],
    rowProps: dnd ? tabDndProps(g, t) : {},
  });
}

async function newGroup() {
  const r = await groupDialog('New group');
  if (!r) return;
  const id = uid();
  await updateLibrary((lib) => { lib.groups.unshift({ id, title: r.name, color: r.color, tabs: [], createdAt: Date.now(), updatedAt: Date.now() }); });
  state.expanded.add(`lib:${id}`);
}

async function editGroup(g) {
  const r = await groupDialog('Edit group', { name: g.title, color: g.color });
  if (!r) return;
  await updateLibrary((lib) => {
    const x = lib.groups.find((y) => y.id === g.id);
    if (x) Object.assign(x, { title: r.name, color: r.color, updatedAt: Date.now() });
  });
}

async function deleteGroup(g) {
  const c = await choose(`Delete “${g.title || 'Untitled'}”?`,
    `Its ${plural(g.tabs.length, 'saved tab')} will be removed from your library. Open tabs aren't affected.`,
    [['cancel', 'Cancel', ''], ['delete', 'Delete', 'danger']]);
  if (c !== 'delete') return;
  await updateLibrary((lib) => { lib.groups = lib.groups.filter((x) => x.id !== g.id); });
}

async function removeTab(g, t) {
  await updateLibrary((lib) => {
    const x = lib.groups.find((y) => y.id === g.id);
    if (x) { x.tabs = x.tabs.filter((y) => y.id !== t.id); x.updatedAt = Date.now(); }
  });
}

async function addActiveTab(g) {
  const [t] = await chrome.tabs.query({ active: true, windowId: state.windowId });
  if (!t || !isSavableUrl(t.url)) { toast("The current tab can't be saved."); return; }
  await addToGroup(g.id, [{ url: t.url, title: t.title || t.url }]);
}

async function openLibraryGroup(g) {
  if (!g.tabs.length) { toast('This group is empty.'); return; }
  const already = await findOpenLinkedGroup(g.id);
  if (already) {
    const c = await choose(`“${g.title || 'Untitled'}” is already open`, '',
      [['goto', 'Go to it'], ['again', 'Open another copy', ''], ['cancel', 'Cancel', '']]);
    if (c === 'cancel') return;
    if (c === 'goto') {
      await chrome.tabGroups.update(already.id, { collapsed: false });
      const [t] = await chrome.tabs.query({ groupId: already.id });
      if (t) {
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
      }
      return;
    }
  }
  const { groupId } = await openTabsInWindow(state.windowId, g.tabs, { group: { ...g, collapsed: false }, lazy: state.settings.lazy });
  if (groupId != null) await setLink(groupId, g.id);
  toast(`Opened “${g.title || 'Untitled'}”`);
}

// ---- Drag and drop (library only) -----------------------------------------
const isAfter = (e, el) => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
function clearDrop() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));
}
function endDrag() {
  drag = null;
  clearDrop();
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  if (pendingRefresh) { pendingRefresh = false; refresh(); }
}

function groupDndProps(g) {
  return {
    draggable: 'true',
    ondragstart: (e) => {
      drag = { kind: 'group', groupId: g.id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', g.title || '');
      e.currentTarget.classList.add('dragging');
    },
    ondragend: endDrag,
    ondragover: (e) => {
      if (!drag) return;
      e.preventDefault();
      clearDrop();
      const el = e.currentTarget;
      if (drag.kind === 'group') { if (drag.groupId !== g.id) el.classList.add(isAfter(e, el) ? 'drop-after' : 'drop-before'); }
      else el.classList.add('drop-into');
    },
    ondrop: async (e) => {
      e.preventDefault();
      const d = drag;
      const after = isAfter(e, e.currentTarget);
      clearDrop();
      if (!d) return;
      if (d.kind === 'group') await moveGroup(d.groupId, g.id, after);
      else await moveTab(d, g.id, null, true);
    },
  };
}

function tabDndProps(g, t) {
  return {
    draggable: 'true',
    ondragstart: (e) => {
      e.stopPropagation();
      drag = { kind: 'tab', groupId: g.id, tabId: t.id, url: t.url };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/uri-list', t.url);
      e.dataTransfer.setData('text/plain', t.url);
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => { e.stopPropagation(); endDrag(); },
    ondragover: (e) => {
      if (drag?.kind !== 'tab') return; // let group drags bubble to the card
      e.preventDefault();
      e.stopPropagation();
      clearDrop();
      if (drag.tabId !== t.id) e.currentTarget.classList.add(isAfter(e, e.currentTarget) ? 'drop-after' : 'drop-before');
    },
    ondrop: async (e) => {
      if (drag?.kind !== 'tab') return;
      e.preventDefault();
      e.stopPropagation();
      const d = drag;
      const after = isAfter(e, e.currentTarget);
      clearDrop();
      if (d.tabId !== t.id) await moveTab(d, g.id, t.id, after);
    },
  };
}

async function moveGroup(fromId, toId, after) {
  if (fromId === toId) return;
  await updateLibrary((lib) => {
    const i = lib.groups.findIndex((x) => x.id === fromId);
    if (i < 0) return;
    const [g] = lib.groups.splice(i, 1);
    let j = lib.groups.findIndex((x) => x.id === toId);
    if (j < 0) j = lib.groups.length; else if (after) j += 1;
    lib.groups.splice(j, 0, g);
  });
}

async function moveTab(d, toGroupId, targetTabId, after) {
  if (d.groupId !== toGroupId) {
    const dst = state.library.groups.find((x) => x.id === toGroupId);
    if (dst?.tabs.some((x) => x.url === d.url)) {
      const c = await choose('Duplicate', `“${dst.title || 'Untitled'}” already has this exact URL.`,
        [['cancel', 'Cancel'], ['move', 'Move anyway', '']]);
      if (c !== 'move') return;
    }
  }
  await updateLibrary((lib) => {
    const src = lib.groups.find((x) => x.id === d.groupId);
    const dst = lib.groups.find((x) => x.id === toGroupId);
    if (!src || !dst) return;
    const i = src.tabs.findIndex((x) => x.id === d.tabId);
    if (i < 0) return;
    const [tab] = src.tabs.splice(i, 1);
    let j = targetTabId ? dst.tabs.findIndex((x) => x.id === targetTabId) : -1;
    j = j < 0 ? dst.tabs.length : j + (after ? 1 : 0);
    dst.tabs.splice(j, 0, tab);
    src.updatedAt = dst.updatedAt = Date.now();
  });
}

// ---- Last session ----------------------------------------------------------
function renderLastView(q) {
  const out = h('div', {});
  const hist = state.history;
  if (!hist.length) {
    if (!q) out.append(empty('Nothing here yet. After you restart the browser, the tabs and groups you had open will appear here.'));
    return out;
  }
  const i = Math.min(state.historyIndex, hist.length - 1);
  const s = hist[i];
  const lazy = state.settings.lazy;
  if (!q) {
    out.append(h('div', { class: 'toolbar' },
      h('select', {
        'aria-label': 'Choose a saved session',
        onchange: (e) => { state.historyIndex = Number(e.target.value); render(); },
      }, hist.map((x, k) => h('option', { value: k, selected: k === i },
        `${k === 0 ? 'Last session' : 'Earlier'} · ${fmtDate(x.savedAt)} · ${plural(countTabs(x), 'tab')}`))),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => restoreSession(s, lazy), title: 'Reopen every window from this session' }, 'Restore all')));
  }
  const idx = libraryIndex();
  const row = (t) => tabRow(t, {
    onClick: () => openSingleTab(state.windowId, t.url),
    badges: idx.get(t.url) ? [badge('Saved', `Saved in: ${groupNames(idx.get(t.url))}`, true)] : [],
    actions: [iconBtn('+', 'Add to a saved group', () => addTabsToLibrary([t], `Add “${t.title}” to…`))],
  });

  s.windows.forEach((w, wi) => {
    const items = [];
    w.entries.forEach((e, ei) => {
      if (e.type === 'group') {
        const g = filterGroup(e, q);
        if (!g) return;
        items.push(groupCard({
          key: `last:${s.id}:${wi}:${ei}`, color: e.color, title: e.title, count: e.tabs.length, forceOpen: !!q,
          actions: [
            iconBtn('Open', 'Open this group in the current window', () => openTabsInWindow(state.windowId, e.tabs, { group: { ...e, collapsed: false }, lazy })
              .then(() => toast(`Opened “${e.title || 'Untitled'}”`)), 'text'),
            iconBtn('Save', 'Save this group to your library', async () => {
              const r = await saveGroupToLibrary(e);
              if (r) toast(`Saved “${r.title}” to your library`);
            }, 'text'),
          ],
          body: () => g.tabs.map(row),
        }));
      } else if (!q || matches(q, e.title, e.url)) {
        items.push(row(e));
      }
    });
    if (!items.length) return;
    const n = countTabs({ windows: [w] });
    out.append(h('div', { class: 'section' }, `Window ${wi + 1} · ${plural(n, 'tab')}`, h('span', { class: 'spacer' }),
      !q && iconBtn('Restore window', 'Reopen this window with its groups', () => restoreWindow(w, lazy), 'text')));
    out.append(...items);
  });
  return out;
}

// ---- Search across everything ---------------------------------------------
function renderSearch(q) {
  const out = h('div', {});
  const sections = [
    ['Open in this window', renderOpenView(q)],
    ['Library', renderLibraryView(q)],
    ['Last session', renderLastView(q)],
  ];
  for (const [label, node] of sections) {
    if (!hasResults(node)) continue;
    out.append(h('h4', { class: 'section' }, label), node);
  }
  if (!out.childElementCount) out.append(empty(`No tabs or groups match “${state.query.trim()}”.`));
  return out;
}

// ---- Export / import -------------------------------------------------------
function exportData() {
  const data = {
    app: 'remember-tabs', version: 1, exportedAt: new Date().toISOString(),
    library: state.library, sessionHistory: state.history,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  h('a', { href: url, download: `remember-tabs-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function sanitizeGroups(groups) {
  return groups.filter((g) => g && Array.isArray(g.tabs)).map((g) => ({
    id: typeof g.id === 'string' ? g.id : uid(),
    title: String(g.title || 'Untitled group'),
    color: GROUP_COLORS.includes(g.color) ? g.color : 'grey',
    tabs: g.tabs.filter((t) => t && typeof t.url === 'string')
      .map((t) => ({ id: typeof t.id === 'string' ? t.id : uid(), url: t.url, title: String(t.title || t.url) })),
    createdAt: Number(g.createdAt) || Date.now(),
    updatedAt: Number(g.updatedAt) || Date.now(),
  }));
}

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data = null;
  try { data = JSON.parse(await file.text()); } catch { /* handled below */ }
  await importBackup(data);
});

async function importBackup(data) {
  if (!Array.isArray(data?.library?.groups)) {
    await choose('Import failed', "That isn't a Remember Tabs backup.", [['ok', 'OK']]);
    return;
  }
  const groups = sanitizeGroups(data.library.groups);
  const from = data.device ? ` from ${data.device}` : '';
  const when = data.exportedAt ? ` (${fmtDate(Date.parse(data.exportedAt))})` : '';
  const mode = await choose('Import backup', `This backup${from}${when} has ${plural(groups.length, 'group')}. Its sessions will appear under “Last session”.`,
    [['merge', 'Merge with my library'], ['replace', 'Replace my library', ''], ['cancel', 'Cancel', '']]);
  if (mode === 'cancel') return;
  await updateLibrary((lib) => {
    if (mode === 'replace') { lib.groups = groups; return; }
    for (const g of groups) {
      const ex = lib.groups.find((x) => x.id === g.id);
      if (!ex) { lib.groups.push(g); continue; }
      const have = new Set(ex.tabs.map((t) => t.url));
      for (const t of g.tabs) if (!have.has(t.url)) { ex.tabs.push(t); have.add(t.url); }
    }
  });
  // Sessions from the backup (including the one that was open when it was made) go into "Last session" history.
  const sessions = [...(Array.isArray(data.sessionHistory) ? data.sessionHistory : []), data.currentSession];
  const history = await getLocal('sessionHistory', []);
  const current = await getLocal('currentSession', null);
  const byId = new Map(history.map((s) => [s.id, s]));
  for (const s of sessions) {
    if (s?.id && Array.isArray(s.windows) && !byId.has(s.id) && s.id !== current?.id) byId.set(s.id, s);
  }
  await setLocal('sessionHistory', [...byId.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, HISTORY_MAX));
  toast('Import complete');
}

// ---------------------------------------------------------------------------
// Wiring
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  state.query = '';
  $('#search').value = '';
  render();
  main.scrollTop = 0;
}));

$('#search').addEventListener('input', (e) => { state.query = e.target.value; render(); });
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.query = ''; render(); }
});

$('#cloud').addEventListener('click', openCloudDialog);
setInterval(renderCloudStatus, 30000); // keep "x min ago" fresh

$('#lazy').addEventListener('change', (e) => {
  state.settings.lazy = e.target.checked;
  setLocal('settings', state.settings);
});

dlg.addEventListener('close', () => { if (pendingRefresh) { pendingRefresh = false; refresh(); } });

chrome.storage.onChanged.addListener(refresh);
for (const ev of [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onMoved, chrome.tabs.onAttached,
  chrome.tabs.onDetached, chrome.tabs.onActivated, chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated,
  chrome.tabGroups.onRemoved, chrome.tabGroups.onMoved]) ev.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if ('url' in info || 'title' in info || 'groupId' in info || 'pinned' in info || 'discarded' in info) refresh();
});

(async () => {
  state.windowId = (await chrome.windows.getCurrent()).id;
  // Open on "Last session" right after a browser restart, otherwise on "Open now".
  const { seenPanel } = await chrome.storage.session.get('seenPanel');
  await loadAll();
  state.view = !seenPanel && state.history.length ? 'last' : 'open';
  chrome.storage.session.set({ seenPanel: true });
  render();
})();
