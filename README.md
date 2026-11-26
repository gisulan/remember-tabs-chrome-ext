# Remember Tabs

A browser extension for **Edge, Brave and Chrome** that remembers your tabs and tab groups.

- **Last session:** after the browser or computer restarts, everything you had open is listed, ready to reopen. You can reopen all of it, one window, one group, or single tabs. Nothing reopens on its own.
- **Library:** save a tab group to free up memory and reopen it whenever you need it. You can add pages to a saved group without opening it.
- **Light on memory:** reopened tabs stay asleep until you click them.
- **Search, duplicate warnings, drag-and-drop sorting.**
- **OneDrive backup**, so a browser reset doesn't lose your groups.

Everything lives in a side panel: click the extension's icon to open it.

---

## Install

It takes about 2 minutes, and you only do it once per browser.

1. Download **`remember-tabs-vX.Y.Z.zip`** from the [latest release](../../releases/latest).
2. Unzip it and move the `remember-tabs` folder somewhere permanent, such as `Documents/remember-tabs`.
   ⚠️ The browser runs the extension from this folder. If you delete or move the folder, the extension stops working.
   **Windows:** right-click the zip → **Extract All**. You can't load it straight from the zip. Extracting creates `remember-tabs-v1.0.0\remember-tabs\`. Use the inner `remember-tabs` folder, the one with `manifest.json` in it.
3. Open your browser's extensions page:

   | Browser | Address |
   |---|---|
   | Edge | `edge://extensions` |
   | Brave | `brave://extensions` |
   | Chrome | `chrome://extensions` |

4. Turn on **Developer mode** (a toggle at the top right in Chrome/Brave, or the left sidebar in Edge).
5. Click **Load unpacked** and select the `remember-tabs` folder (the one that contains `manifest.json`).
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Remember Tabs**.
7. Click the icon to open the side panel.

> Edge or Chrome may show a "developer mode extensions" warning at startup. That's expected for extensions installed this way, so dismiss it.

## Turn on OneDrive backup (recommended)

Click the **OneDrive backup** line at the bottom of the panel, then **Sign in with Microsoft**.

- **Personal Microsoft accounts** (outlook.com, hotmail.com, live.com) work right away.
- **Work accounts** may show "Need admin approval", depending on company settings. If so, use a personal account.
- Backups go to **your own** OneDrive, in `Apps › Remember Tabs`. Nobody else can see them.
- When the line shows a green dot, backups are working. Yellow means sign in again; red means click it for details.

To move your groups to another browser or computer, install the extension there, sign in, and click **Restore…**.

## Update to a new version

1. Download the new zip from [Releases](../../releases/latest).
2. Replace the **contents** of your existing `remember-tabs` folder with the new files.
3. On the extensions page, click the **reload ↻** icon on the Remember Tabs card.

Your saved groups and sessions are kept. **Don't** click *Remove* to update: removing the extension deletes its local data. If you ever do need to remove it, back up first, either through OneDrive (**Back up now**) or with **Library › Export**.

## Tips

- **Save a group:** in *Open now*, click **Save** on a group. You'll be asked whether to close its tabs.
- **Add a page to a saved group without opening the group:** click **+** on the tab, or **+** on the saved group to add the current tab.
- **Reorder:** drag groups and pages in the *Library*.
- **The toggle at the bottom** controls whether reopened tabs load right away or wait until clicked.
- **Not saved:** incognito/InPrivate windows, new-tab pages and blank pages.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Load unpacked" is missing | Developer mode is off, or your browser policy blocks it. Company-managed Windows PCs often lock this. Ask IT, or check `edge://policy` / `chrome://policy` for `DeveloperToolsAvailability` or `ExtensionInstallBlocklist`. |
| "Manifest file is missing or unreadable" | You selected the outer folder. Pick the folder that directly contains `manifest.json`. |
| Clicking the icon doesn't open the panel | Update the browser (version 116 or newer is required). |
| OneDrive: "Need admin approval" | Your company blocks the app for work accounts. Sign in with a personal Microsoft account. |
| OneDrive asks to sign in again often | Microsoft limits this kind of sign-in to about 24h. The extension renews it silently when it can. Click the status line to sign in again. |

---

## For maintainers

**Shared OneDrive app.** For colleagues to sign in without registering their own app, `lib/config.js` must contain the Application (client) ID of an app registration set up like this:
- Supported account types: *Accounts in any organizational directory and personal Microsoft accounts*.
- Platform **Single-page application**, with the redirect URI `https://kgmhblgkcigcgldgkchbabickejefhea.chromiumapp.org/`.

The client ID is not a secret. The extension ID is pinned by the `key` in `manifest.json`, so this redirect URI is the same for everyone in every browser. Don't change the key, or every install's ID (and its stored data) changes.

**Releasing.**
1. Bump `version` in `manifest.json` and add a section to `CHANGELOG.md`.
2. Run `./scripts/build-release.sh` on macOS/Linux (on Windows, use Git Bash or WSL). It writes `dist/remember-tabs-v<version>.zip`.
3. Commit, push, then open GitHub → **Releases → Draft a new release**, create a tag `v<version>`, paste the changelog section, and attach the zip.

Release files (`dist/`, `releases/`, `*.zip`, `*.crx`, `*.pem`) are git-ignored on purpose. Don't publish `.crx` files: Chrome/Edge/Brave won't install them from outside their stores, and a `.pem` is a private signing key.

**Code layout.**
- `background.js`: session snapshots, startup rotation, backup scheduling
- `lib/common.js`: storage and session capture
- `lib/restore.js`: reopening tabs and groups, lazy sleeping
- `lib/onedrive.js`: Microsoft sign-in (PKCE) and Graph backup
- `lib/config.js`: the shared app ID
- `sidepanel/`: the UI
