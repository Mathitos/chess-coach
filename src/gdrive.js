// Google login (Google Identity Services, token model) + one JSON file in the
// user's hidden Drive app folder (scope drive.appdata). No backend.
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid email profile'
const FILE = 'chess-coach.json'
const API = 'https://www.googleapis.com'

let tokenClient = null, token = null, tokenExp = 0, fileId = null

// O access token do Google vale ~1h. Guardamos ele no navegador pra um reload
// não pedir login de novo; quando vence, o app renova no próximo clique.
const TK = 'coach.gtoken'
try { const t = JSON.parse(localStorage.getItem(TK) || 'null'); if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp } } catch {}
function persist() { try { token ? localStorage.setItem(TK, JSON.stringify({ token, exp: tokenExp })) : localStorage.removeItem(TK) } catch {} }

export const clientId = typeof __GOOGLE_CLIENT_ID__ !== 'undefined' ? __GOOGLE_CLIENT_ID__ : ''
export function available() { return !!clientId && !/claude/.test(location.hostname) }

function loadScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('não carregou o login do Google'))
    document.head.appendChild(s)
  })
}

// Must be called from a click (opens Google's popup).
export async function signIn(hintEmail) {
  await loadScript()
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      hint: hintEmail || undefined,
      callback: (r) => {
        if (r.error) return reject(new Error(r.error_description || r.error))
        token = r.access_token
        tokenExp = Date.now() + (r.expires_in - 60) * 1000
        persist()
        resolve()
      },
      error_callback: (e) => reject(new Error(e?.message || e?.type || 'login cancelado')),
    })
    tokenClient.requestAccessToken({ prompt: hintEmail ? '' : 'consent' })
  })
}
export function signedIn() { return !!token && Date.now() < tokenExp }
export function expiresIn() { return token ? tokenExp - Date.now() : 0 }
export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {})
  token = null; tokenExp = 0; fileId = null
  persist()
}

async function api(path, opts = {}) {
  if (!signedIn()) throw new Error('sessão do Google expirou')
  const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } })
  if (!r.ok) throw new Error(`Google respondeu ${r.status}`)
  return r
}
export async function userInfo() {
  return (await api('/oauth2/v3/userinfo')).json()
}
async function findFile() {
  if (fileId) return fileId
  const q = encodeURIComponent(`name='${FILE}'`)
  const j = await (await api(`/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json()
  fileId = j.files?.[0]?.id || null
  return fileId
}
export async function load() {
  const id = await findFile()
  if (!id) return null
  return (await api(`/drive/v3/files/${id}?alt=media`)).json()
}
export async function save(data) {
  const body = JSON.stringify(data)
  const id = await findFile()
  if (id) {
    await api(`/upload/drive/v3/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body })
    return
  }
  const boundary = 'cc' + Math.random().toString(36).slice(2)
  const meta = JSON.stringify({ name: FILE, parents: ['appDataFolder'], mimeType: 'application/json' })
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`
  const r = await api('/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart })
  fileId = (await r.json()).id
}
