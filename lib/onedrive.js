// OneDrive backup via Microsoft Graph.
// Sign-in uses OAuth 2.0 authorization code + PKCE through chrome.identity.launchWebAuthFlow,
// so it works with personal Microsoft accounts and (if the company allows) work accounts.
// Backups go to the app's own folder: OneDrive > Apps > <app name> > backup-<device>.json
import { getLocal, setLocal } from './common.js';
import { SHARED_CLIENT_ID, SHARED_TENANT } from './config.js';

const SCOPES = 'offline_access User.Read Files.ReadWrite.AppFolder';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const APPROOT = '/me/drive/special/approot';

export class CloudError extends Error {
  // kind: 'off' (not set up) | 'signedout' | 'signin' (must sign in again) | 'error'
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

export const redirectUri = () => chrome.identity.getRedirectURL();

export function defaultDevice() {
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(' ');
  const name = navigator.brave || /brave/i.test(brands) ? 'Brave'
    : /edge/i.test(brands) ? 'Edge'
      : /chrome/i.test(brands) ? 'Chrome' : 'Browser';
  const os = navigator.userAgentData?.platform;
  return os ? `${name} on ${os}` : name;
}

// A client ID typed into Setup wins; otherwise the shared one from lib/config.js is used.
export async function getConfig() {
  const c = await getLocal('cloudConfig', {});
  const own = !!c.clientId;
  return {
    device: c.device || '',
    clientId: own ? c.clientId : SHARED_CLIENT_ID,
    tenant: own ? (c.tenant || 'common') : SHARED_TENANT,
    usingShared: !own && !!SHARED_CLIENT_ID,
  };
}
export const setConfig = (c) => setLocal('cloudConfig', c);
export const getStatus = () => getLocal('cloudStatus', { state: 'idle' });
async function setStatus(patch) { await setLocal('cloudStatus', { ...(await getStatus()), ...patch }); }
const getAuth = () => getLocal('cloudAuth', null);

export const backupFileName = (device) =>
  `backup-${(device || 'browser').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'browser'}.json`;

// ---- Auth ------------------------------------------------------------------
const authority = (cfg) => `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant || 'common')}/oauth2/v2.0`;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function explain(text) {
  const msg = String(text || 'Unknown error');
  if (/AADSTS9002327|AADSTS90023/.test(msg)) return 'In the Azure app registration, the redirect URI must be under the "Single-page application" platform (not Web or Mobile/desktop).';
  if (/AADSTS50011/.test(msg)) return `Redirect URI mismatch. Add exactly ${redirectUri()} as a "Single-page application" redirect URI in the app registration.`;
  if (/AADSTS700016/.test(msg)) return 'Application (client) ID not found. Check the ID you pasted, and that the account type setting matches the app registration.';
  if (/AADSTS50020|AADSTS50194|AADSTS9002331/.test(msg)) return 'This account type is not allowed by the app registration. Set "Supported account types" to include personal Microsoft accounts, and match the account type setting here.';
  if (/AADSTS65001|AADSTS90094|AADSTS90095/.test(msg)) return 'Your organization requires admin approval for this app. Use a personal account, or ask IT to approve it.';
  return msg.split(/\r?\n/)[0];
}

async function tokenRequest(cfg, params) {
  let res;
  try {
    res = await fetch(`${authority(cfg)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: SCOPES, ...params }),
    });
  } catch {
    throw new CloudError('Could not reach Microsoft sign-in (offline?).');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new CloudError(explain(data.error_description || data.error), data.error === 'invalid_grant' || data.error === 'interaction_required' ? 'signin' : 'error');
  }
  const prev = (await getAuth()) || {};
  const auth = {
    ...prev,
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 120) * 1000,
    refreshToken: data.refresh_token || prev.refreshToken,
  };
  await setLocal('cloudAuth', auth);
  return auth;
}

async function authorize(cfg, interactive) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: cfg.clientId, response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPES, code_challenge: challenge, code_challenge_method: 'S256', state,
    prompt: interactive ? 'select_account' : 'none',
  });
  const prev = await getAuth();
  if (!interactive && prev?.account) params.set('login_hint', prev.account);
  const opts = { url: `${authority(cfg)}/authorize?${params}`, interactive };
  if (!interactive) Object.assign(opts, { abortOnLoadForNonInteractive: false, timeoutMsForNonInteractive: 20000 });

  let result;
  try {
    result = await chrome.identity.launchWebAuthFlow(opts);
  } catch (e) {
    throw new CloudError(interactive ? `Sign-in was cancelled or failed: ${e.message}` : 'Sign in to Microsoft again to keep backing up.', 'signin');
  }
  const q = new URL(result).searchParams;
  if (q.get('error')) throw new CloudError(explain(q.get('error_description') || q.get('error')), 'signin');
  if (q.get('state') !== state || !q.get('code')) throw new CloudError('Unexpected sign-in response. Please try again.', 'signin');
  return tokenRequest(cfg, { grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: verifier });
}

export async function getAccessToken() {
  const cfg = await getConfig();
  if (!cfg.clientId) throw new CloudError('OneDrive backup is not set up.', 'off');
  const auth = await getAuth();
  if (!auth?.account) throw new CloudError('Not signed in to Microsoft.', 'signedout');
  if (auth.accessToken && auth.expiresAt > Date.now()) return auth.accessToken;
  if (auth.refreshToken) {
    try {
      return (await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: auth.refreshToken })).accessToken;
    } catch (e) {
      if (e.kind !== 'signin') throw e;
    }
  }
  // Refresh token expired (single-page-app tokens last ~24h): try a silent sign-in with the browser's Microsoft session.
  return (await authorize(cfg, false)).accessToken;
}

export async function signIn() {
  const cfg = await getConfig();
  if (!cfg.clientId) throw new CloudError('Enter the Application (client) ID first.', 'off');
  await setLocal('cloudAuth', null);
  const auth = await authorize(cfg, true);
  const res = await fetch(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const me = await res.json().catch(() => ({}));
  const account = me.userPrincipalName || me.mail || me.displayName || 'Microsoft account';
  await setLocal('cloudAuth', { ...auth, account, name: me.displayName || account });
  await setStatus({ state: 'idle', lastError: null });
  return account;
}

export async function signOut() {
  await setLocal('cloudAuth', null);
  await setStatus({ state: 'idle', lastError: null, lastHash: null });
}

// ---- Graph -----------------------------------------------------------------
async function graph(path, init = {}, retry = true) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(path.startsWith('http') ? path : GRAPH + path, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  } catch {
    throw new CloudError('Could not reach OneDrive (offline?).');
  }
  if (res.status === 401 && retry) {
    const auth = await getAuth();
    if (auth) await setLocal('cloudAuth', { ...auth, expiresAt: 0 });
    return graph(path, init, false);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error?.message || msg; } catch { /* not json */ }
    throw new CloudError(`OneDrive error ${res.status}: ${msg}`);
  }
  return res;
}

const itemPath = (name) => `${APPROOT}:/${encodeURIComponent(name)}:`;

export async function uploadBackup(payload, fileName) {
  const body = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(body);
  if (bytes.length < 4 * 1024 * 1024) {
    await graph(`${itemPath(fileName)}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bytes });
    return;
  }
  // Large backups: resumable upload session in 5 MiB chunks (must be multiples of 320 KiB).
  const res = await graph(`${itemPath(fileName)}/createUploadSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  const { uploadUrl } = await res.json();
  const CHUNK = 320 * 1024 * 16;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, bytes.length);
    const r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` }, body: bytes.slice(start, end) });
    if (!r.ok) throw new CloudError(`OneDrive upload failed (${r.status}).`);
  }
}

export async function listBackups() {
  const res = await graph(`${APPROOT}/children?$select=name,size,lastModifiedDateTime&$top=200`);
  const { value = [] } = await res.json();
  return value.filter((f) => f.name.endsWith('.json'))
    .sort((a, b) => b.lastModifiedDateTime.localeCompare(a.lastModifiedDateTime));
}

export async function downloadBackup(name) {
  const meta = await (await graph(itemPath(name))).json();
  const url = meta['@microsoft.graph.downloadUrl'];
  if (!url) throw new CloudError('OneDrive did not return a download link.');
  const res = await fetch(url);
  if (!res.ok) throw new CloudError(`Download failed (${res.status}).`);
  return res.json();
}

// ---- Backup ----------------------------------------------------------------
async function sha256(text) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Uploads library + session history if anything changed since the last backup.
// Returns true if a backup was uploaded. Quietly does nothing if not set up / signed in (unless force).
export async function runBackup({ force = false } = {}) {
  const cfg = await getConfig();
  const auth = await getAuth();
  if (!cfg.clientId || !auth?.account) {
    if (force) throw new CloudError(cfg.clientId ? 'Sign in to Microsoft first.' : 'OneDrive backup is not set up.', cfg.clientId ? 'signedout' : 'off');
    return false;
  }
  const [library, sessionHistory, currentSession] = await Promise.all([
    getLocal('library', { groups: [] }), getLocal('sessionHistory', []), getLocal('currentSession', null),
  ]);
  const data = { library, sessionHistory, currentSession };
  const hash = await sha256(JSON.stringify(data));
  const status = await getStatus();
  if (!force && status.lastHash === hash && status.state === 'ok') return false;

  const fileName = backupFileName(cfg.device || defaultDevice());
  await setStatus({ state: 'working', workingSince: Date.now() });
  try {
    await uploadBackup({
      app: 'remember-tabs', version: 1, device: cfg.device || defaultDevice(),
      exportedAt: new Date().toISOString(), ...data,
    }, fileName);
    await setStatus({ state: 'ok', lastBackupAt: Date.now(), lastHash: hash, lastError: null, fileName });
    return true;
  } catch (e) {
    await setStatus({ state: e.kind === 'signin' ? 'signin' : 'error', lastError: e.message, lastErrorAt: Date.now() });
    throw e;
  }
}
