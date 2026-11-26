# Remember Tabs

A side-panel extension for Chromium browsers (Edge, Brave, Chrome) that:

- **Remembers your last session.** It keeps saving your open windows, tabs and groups. After a browser or computer restart, everything appears under **Last session**. You can restore all of it, one window, one group, or single tabs. Nothing reopens automatically. The last 10 sessions are kept.
- **Keeps a library of groups.** Save an open group to free memory. It asks before closing the tabs. Reopen the group later with one click; it stays in the library. You can add tabs to a saved group without opening it.
- **Restores lazily.** Restored tabs go to sleep right away and load only when you click them. There's a toggle at the bottom of the panel.
- **Search** covers open tabs, the library and the last session.
- **Duplicates** are exact-URL matches. You're warned whenever you add a page that's already in any saved group. Duplicates are labeled in the library, and pages open twice in a window are labeled too.
- **Drag and drop** reorders groups, and tabs within or between groups, in the Library.
- **Export / Import** saves your library and session history as a JSON backup, which you can also use to move data between browsers.
- **OneDrive backup** runs automatically, a minute after any library change and hourly otherwise. It works with a personal Microsoft account, or a work account if your company allows it. The status line at the bottom of the panel always shows whether it's working.

## Set up OneDrive backup (once)

The extension needs a free app registration with Microsoft so it can sign in.

1. Go to <https://entra.microsoft.com> → **App registrations** → **New registration** and sign in with your Microsoft account.
2. **Name:** anything, e.g. `Remember Tabs`.
3. **Supported account types:** *Accounts in any organizational directory and personal Microsoft accounts*.
4. **Redirect URI:** platform **Single-page application (SPA)**, value:
   `https://kgmhblgkcigcgldgkchbabickejefhea.chromiumapp.org/`
   This is the same in Edge, Brave and Chrome, because the manifest pins the extension ID.
5. Click **Register**, then copy the **Application (client) ID**.
6. In the side panel, click the **OneDrive backup** line at the bottom → paste the ID → **Save** → **Sign in with Microsoft**.

You don't need to add API permissions in Azure. The extension asks for `Files.ReadWrite.AppFolder`, `User.Read` and `offline_access` when you sign in. It can only touch its own folder: **OneDrive › Apps › (app name)**. Each browser writes its own file (`backup-edge-on-macos.json`, `backup-brave-…`), so browsers never overwrite each other. **Restore…** lets you pull any of them into any browser.

Sign-in renewal: Microsoft limits single-page-app sign-ins to about 24 hours. After that the extension tries to renew silently using your Microsoft login in the browser. If that fails, the status line turns yellow ("sign in again").

## Install (unpacked)

Do this once in each browser:

| Browser | Extensions page |
|---|---|
| Edge | `edge://extensions` |
| Brave | `brave://extensions` |
| Chrome | `chrome://extensions` |

1. Open the extensions page and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension, then click its icon to open the side panel.

After you change the code, click the reload icon on the extension's card.

## Notes and limits

- Each browser keeps its own library. Use OneDrive **Restore…** or Export/Import to copy one into another.
- Incognito/InPrivate windows, new-tab pages and blank pages aren't saved.
- If your company's policy clears site data when the browser closes, extension storage may be wiped too. OneDrive backup protects you from that. Use **Restore…** after a wipe.
- Edge's own sleeping tabs feature works alongside this extension.

## Roadmap

1. Google Drive as an alternative backup target.
2. A full-page manager if the side panel gets cramped.
3. Optional: a right-click "Add page to saved group" menu, and a keyboard shortcut.

## Files

- `background.js`: snapshots the session and moves it to history at browser startup
- `lib/common.js`: storage and session capture
- `lib/restore.js`: reopening tabs and groups, lazy sleeping
- `lib/onedrive.js`: Microsoft sign-in (PKCE), Graph upload, list and download
- `sidepanel/`: the UI
