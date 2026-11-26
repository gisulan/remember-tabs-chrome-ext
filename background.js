// Keeps a live snapshot of the open tabs/groups. When the browser starts again,
// that snapshot moves into "sessionHistory" and appears as "Last session" in the panel.
import { captureSession, countTabs, getLocal, setLocal, HISTORY_MAX } from './lib/common.js';
import { discardSoon } from './lib/restore.js';
import { runBackup } from './lib/onedrive.js';

// ---- OneDrive backup scheduling -------------------------------------------
// Hourly backup of everything (only uploads if something changed), plus a quick
// backup one minute after any change to the library.
const ensureBackupAlarm = () => chrome.alarms.create('cloud-periodic', { periodInMinutes: 60, delayInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('cloud-')) runBackup().catch((e) => console.warn('OneDrive backup failed:', e.message));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.library || changes.sessionHistory)) chrome.alarms.create('cloud-soon', { delayInMinutes: 1 });
});

// Restored tabs are put to sleep here (see lib/restore.js).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'discard' && Array.isArray(msg.tabIds)) msg.tabIds.forEach((id) => discardSoon(id));
});

const DEBOUNCE_MS = 1500;
let timer = null;

async function setupPanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('Side panel not supported here', e);
  }
}

// Move the previous browser session's snapshot into history.
async function rotateSession() {
  const cur = await getLocal('currentSession', null);
  if (!cur || !countTabs(cur)) return;
  const history = await getLocal('sessionHistory', []);
  if (history[0]?.id !== cur.id) {
    history.unshift(cur);
    await setLocal('sessionHistory', history.slice(0, HISTORY_MAX));
  }
  await setLocal('currentSession', null);
}

// chrome.storage.session is wiped when the browser closes, so the "live" flag
// tells us whether startup handling already ran in this browser session.
const markLive = () => chrome.storage.session.set({ live: true });

chrome.runtime.onStartup.addListener(async () => {
  await setupPanel();
  ensureBackupAlarm();
  await rotateSession();
  await markLive();
  scheduleSnapshot();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setupPanel();
  ensureBackupAlarm();
  // A browser update also fires this at startup; let onStartup handle that case.
  if (reason !== 'install' && reason !== 'update') return;
  // Install or extension update: keep the current snapshot as the live one (no rotation).
  await markLive();
  scheduleSnapshot();
});

function scheduleSnapshot(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(snapshot, delay);
}

let waitedForStartup = false;
async function snapshot() {
  const { live } = await chrome.storage.session.get('live');
  if (!live) {
    // Startup handler hasn't run yet; give it a moment so we don't overwrite
    // the previous session before it's rotated into history.
    if (!waitedForStartup) {
      waitedForStartup = true;
      scheduleSnapshot(5000);
      return;
    }
    await markLive();
  }
  const s = await captureSession();
  if (!countTabs(s)) return; // never replace a real snapshot with an empty one
  const cur = await getLocal('currentSession', null);
  if (cur?.id) s.id = cur.id; // stable id for the whole browser session
  await setLocal('currentSession', s);
}

const watch = (event, filter) => event.addListener((...args) => {
  if (!filter || filter(...args)) scheduleSnapshot();
});

watch(chrome.tabs.onCreated);
watch(chrome.tabs.onUpdated, (_id, info) => 'url' in info || 'title' in info || 'pinned' in info || 'groupId' in info);
// Tabs closing because their window closes (e.g. quitting the browser) must not shrink the snapshot.
watch(chrome.tabs.onRemoved, (_id, info) => !info.isWindowClosing);
watch(chrome.tabs.onMoved);
watch(chrome.tabs.onAttached);
watch(chrome.tabs.onDetached);
watch(chrome.tabGroups.onCreated);
watch(chrome.tabGroups.onUpdated);
watch(chrome.tabGroups.onMoved);
