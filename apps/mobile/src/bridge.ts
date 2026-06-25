/**
 * Mobile bridge — Capacitor implementation of the `window.hermesDesktop` API.
 *
 * The desktop renderer exclusively communicates with the backend through
 * `window.hermesDesktop`, which on desktop is exposed by Electron's preload
 * script via IPC. On mobile we replace it with a Capacitor-based
 * implementation that:
 *
 *   - Uses browser `fetch()` for REST API proxy (token auth via header,
 *     OAuth via credentials: 'include' leveraging the WebView's cookie jar).
 *   - Constructs WebSocket URLs for both auth modes.
 *   - Persists connection config in localStorage (non-sensitive) +
 *     SecureStorage (token secrets).
 *   - Stubs out desktop-only features (terminal, pet overlay, file picker).
 *   - Implements notify() using Capacitor Notifications plugin.
 *
 * This module is a side-effect import: `import './bridge'` installs the
 * bridge onto `window.hermesDesktop` immediately.
 */

import { Preferences } from '@capacitor/preferences'
import { SecureStorage } from 'capacitor-secure-storage-plugin'
import { LocalNotifications } from '@capacitor/local-notifications'

// ── Type aliases (mirror from global.d.ts so mobile doesn't need the file) ──

interface MobileConnectionConfig {
  mode: 'local' | 'remote'
  remoteUrl: string
  remoteAuthMode: 'oauth' | 'token'
  remoteToken: string | null
  remoteTokenSet: boolean
  remoteOauthConnected: boolean
  remoteTokenPreview: string | null
  envOverride: boolean
  profile: string | null
}

// ── Constants ─────────────────────────────────────────────────────────────

const STORAGE_KEY_CONFIG = 'hermes_mobile_conn_config'
const STORAGE_KEY_TOKEN = 'hermes_mobile_conn_token'
const DEFAULT_FETCH_TIMEOUT_MS = 60_000

// ── Utility functions ─────────────────────────────────────────────────────

function normalizeRemoteBaseUrl(rawUrl: string): string {
  const value = String(rawUrl || '').trim()
  if (!value) throw new Error('Remote gateway URL is required.')

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (error) {
    throw new Error(`Remote gateway URL is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Remote gateway URL must be http:// or https://, got ${parsed.protocol}`)
  }

  parsed.hash = ''
  parsed.search = ''
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')
  return parsed.toString().replace(/\/+$/, '')
}

function normAuthMode(mode: string | undefined): 'oauth' | 'token' {
  return mode === 'oauth' ? 'oauth' : 'token'
}

function tokenPreview(value: string | null): string | null {
  if (!value) return null
  return value.length <= 8 ? 'set' : `...${value.slice(-6)}`
}

function buildGatewayWsUrl(baseUrl: string, token: string): string {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${wsScheme}://${parsed.host}${prefix}/api/ws?token=${encodeURIComponent(token)}`
}

function buildGatewayWsUrlWithTicket(baseUrl: string, ticket: string): string {
  const parsed = new URL(baseUrl)
  const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
  const prefix = parsed.pathname.replace(/\/+$/, '')
  return `${wsScheme}://${parsed.host}${prefix}/api/ws?ticket=${encodeURIComponent(ticket)}`
}

function resolveTimeoutMs(timeoutMs: number | undefined, defaultMs: number): number {
  if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs
  return defaultMs
}

// ── Storage ───────────────────────────────────────────────────────────────

async function loadConnectionConfig(): Promise<MobileConnectionConfig> {
  const raw = (await Preferences.get({ key: STORAGE_KEY_CONFIG })).value
  if (raw) {
    try {
      return JSON.parse(raw) as MobileConnectionConfig
    } catch { /* ignore */ }
  }

  const defaultConfig: MobileConnectionConfig = {
    mode: 'remote',
    remoteUrl: 'https://lab.synth.kitchen',
    remoteAuthMode: 'token',
    remoteToken: null,
    remoteTokenSet: false,
    remoteOauthConnected: false,
    remoteTokenPreview: null,
    envOverride: false,
    profile: null,
  }

  // Check for a persisted token in SecureStorage.
  try {
    const stored = await SecureStorage.get({ key: STORAGE_KEY_TOKEN })
    if (stored.value) {
      defaultConfig.remoteToken = stored.value
      defaultConfig.remoteTokenSet = true
      defaultConfig.remoteTokenPreview = tokenPreview(stored.value)
    }
  } catch { /* SecureStorage may not be available */ }

  return defaultConfig
}

async function saveConnectionConfig(config: MobileConnectionConfig): Promise<void> {
  await Preferences.set({ key: STORAGE_KEY_CONFIG, value: JSON.stringify(config) })

  // Persist token separately in SecureStorage.
  if (config.remoteToken) {
    await SecureStorage.set({ key: STORAGE_KEY_TOKEN, value: config.remoteToken }).catch(() => {
      /* SecureStorage unavailable — non-critical */
    })
  } else {
    // Clear token when mode changes to local or token is unset.
    await SecureStorage.remove({ key: STORAGE_KEY_TOKEN }).catch(() => {
      /* SecureStorage unavailable — non-critical */
    })
  }
}

// ── REST API proxy ────────────────────────────────────────────────────────

/**
 * Proxy a REST API call to the Hermes dashboard.
 *
 * Desktop uses Electron's `net` module for this (which supports OAuth
 * cookies via the OAuth partition). Mobile uses `fetch()` directly:
 *   - Token mode: sends `X-Hermes-Session-Token` header.
 *   - OAuth mode: sends `credentials: 'include'` so the WebView's cookie
 *     jar automatically attaches the session cookie.
 */
async function proxyApi(
  config: MobileConnectionConfig,
  request: {
    path: string
    method?: string
    body?: unknown
    timeoutMs?: number
    profile?: string | null
  }
): Promise<unknown> {
  const baseUrl = config.remoteUrl
  const url = `${baseUrl}${request.path}`

  const timeoutMs = resolveTimeoutMs(request.timeoutMs, DEFAULT_FETCH_TIMEOUT_MS)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (config.remoteAuthMode === 'oauth') {
      // OAuth: WebView cookie jar handles authentication.
      const response = await fetch(url, {
        method: request.method || 'GET',
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: 'include',
        signal: controller.signal,
      })

      return parseJsonResponse(response)
    }

    // Token mode: send the session token as a header.
    if (config.remoteToken) {
      headers['X-Hermes-Session-Token'] = config.remoteToken
    }

    const response = await fetch(url, {
      method: request.method || 'GET',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    })

    return parseJsonResponse(response)
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonResponse(response: Response): unknown {
  if (response.status >= 400) {
    // Try to extract a meaningful error message.
    const text = response.statusText || `HTTP ${response.status}`
    return Promise.reject(new Error(`${response.status}: ${text}`))
  }

  const contentType = String(response.headers.get('content-type') || '')
  const text = response.headers.get('content-length') === '0'
    || response.status === 204
    ? ''
    : response.text()

  return text.then(raw => {
    if (!raw) return null
    // Guard against HTML responses (e.g. SPA fallback).
    if (/^\s*<(?:!doctype|html)/i.test(raw) || contentType.includes('text/html')) {
      throw new Error(
        `Expected JSON but got HTML (status ${response.status}). ` +
        'The endpoint is likely missing on the Hermes backend.'
      )
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`Invalid JSON from backend: ${raw.slice(0, 200)}`)
    }
  })
}

// ── OAuth helpers ─────────────────────────────────────────────────────────

/**
 * Mint a fresh WebSocket ticket for OAuth connections.
 * The gateway's `POST /api/auth/ws-ticket` endpoint returns `{ ticket: "..." }`.
 */
async function mintWsTicket(baseUrl: string, authMode: 'oauth' | 'token'): Promise<string> {
  if (authMode !== 'oauth') {
    return ''
  }

  const response = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
    method: 'POST',
    credentials: 'include',
  })

  if (response.status === 401 || response.status === 403) {
    const err = new Error(
      'Your remote gateway session has expired. Open Settings → Gateway and sign in again.'
    )
    // Tag the error so callers can detect OAuth reauth requirement.
    Object.defineProperty(err, 'needsOauthLogin', { value: true, configurable: true })
    throw err
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${response.status}: ${text || response.statusText}`)
  }

  const data = await response.json()
  return data.ticket ?? ''
}

/**
 * Open the gateway's OAuth login page and wait for the session cookie.
 * Returns the login result (ok, baseUrl, connected).
 */
async function oauthLogin(
  config: MobileConnectionConfig,
  remoteUrl: string
): Promise<{ ok: boolean; baseUrl: string; connected: boolean }> {
  const baseUrl = normalizeRemoteBaseUrl(remoteUrl)

  // For OAuth on mobile, we redirect to the gateway's login page.
  // The gateway redirects back to a mobile-deeplink URL after login.
  const loginUrl = `${baseUrl}/api/auth/login`

  // On mobile, open the login URL in an in-app browser and redirect
  // back. The session cookie will be stored in the WebView's cookie jar.
  //
  // For now, we simply navigate to the login page. The user will sign in,
  // and the returned cookie will be used for subsequent requests.
  window.open(loginUrl, '_self')

  // Wait a brief moment for the cookie to land.
  await new Promise(resolve => setTimeout(resolve, 2000))

  // Check if we got a session cookie.
  const cookies = document.cookie.split(';')
  const hasSession = cookies.some(c => c.trim().includes('hermes_session_'))

  return {
    ok: true,
    baseUrl,
    connected: hasSession,
  }
}

/**
 * OAuth logout — clear session cookies and redirect to the gateway's logout page.
 */
async function oauthLogout(
  config: MobileConnectionConfig,
  remoteUrl: string
): Promise<{ ok: boolean; connected: boolean }> {
  const baseUrl = normalizeRemoteBaseUrl(remoteUrl)

  // Redirect to the gateway's logout endpoint.
  const logoutUrl = `${baseUrl}/api/auth/logout`
  window.open(logoutUrl, '_self')

  await new Promise(resolve => setTimeout(resolve, 1000))

  const cookies = document.cookie.split(';')
  const hasSession = cookies.some(c => c.trim().includes('hermes_session_'))

  // Clear any persisted OAuth state.
  config.remoteOauthConnected = false
  await saveConnectionConfig(config)

  return {
    ok: true,
    connected: hasSession,
  }
}

// ── Connection config operations ──────────────────────────────────────────

async function getConnectionConfigImpl(profile: string | null): Promise<{
  envOverride: boolean
  mode: 'local' | 'remote'
  profile: string | null
  remoteAuthMode: 'oauth' | 'token'
  remoteOauthConnected: boolean
  remoteTokenPreview: string | null
  remoteTokenSet: boolean
  remoteUrl: string
}> {
  const config = await loadConnectionConfig()

  // Check OAuth session liveness.
  let oauthConnected = false
  if (config.remoteAuthMode === 'oauth') {
    const cookies = document.cookie.split(';')
    oauthConnected = cookies.some(c => c.trim().includes('hermes_session_'))
  }

  return {
    envOverride: config.envOverride,
    mode: config.mode,
    profile: config.profile,
    remoteAuthMode: config.remoteAuthMode,
    remoteOauthConnected: oauthConnected,
    remoteTokenPreview: tokenPreview(config.remoteToken),
    remoteTokenSet: config.remoteTokenSet,
    remoteUrl: config.remoteUrl,
  }
}

async function saveConnectionConfigImpl(payload: {
  mode: 'local' | 'remote'
  profile?: string | null
  remoteAuthMode?: 'oauth' | 'token'
  remoteToken?: string
  remoteUrl?: string
}): Promise<void> {
  const config = await loadConnectionConfig()

  if (payload.mode) config.mode = payload.mode
  if (payload.remoteAuthMode) config.remoteAuthMode = normAuthMode(payload.remoteAuthMode)
  if (payload.remoteUrl) config.remoteUrl = normalizeRemoteBaseUrl(payload.remoteUrl)

  if (payload.remoteToken !== undefined) {
    config.remoteToken = payload.remoteToken || null
    config.remoteTokenSet = !!payload.remoteToken
    config.remoteTokenPreview = tokenPreview(config.remoteToken)
  }

  if (payload.mode === 'local') {
    config.remoteToken = null
    config.remoteTokenSet = false
    config.remoteTokenPreview = null
    config.remoteOauthConnected = false
  }

  await saveConnectionConfig(config)
}

async function applyConnectionConfigImpl(payload: {
  mode: 'local' | 'remote'
  profile?: string | null
  remoteAuthMode?: 'oauth' | 'token'
  remoteToken?: string
  remoteUrl?: string
}): Promise<void> {
  // On mobile, save and apply are the same — there's no local backend.
  await saveConnectionConfigImpl(payload)
}

// ── Connection test ───────────────────────────────────────────────────────

async function testConnectionImpl(payload: {
  mode: 'local' | 'remote'
  remoteAuthMode?: 'oauth' | 'token'
  remoteToken?: string
  remoteUrl?: string
}): Promise<{ baseUrl: string; ok: boolean; version: string | null }> {
  // Build the config to test.
  const current = await loadConnectionConfig()

  const baseUrl = payload.remoteUrl || current.remoteUrl
  const authMode = payload.remoteAuthMode || current.remoteAuthMode
  const token = payload.remoteToken || current.remoteToken

  if (!baseUrl) {
    return { baseUrl: '', ok: false, version: null }
  }

  const normalizedUrl = normalizeRemoteBaseUrl(baseUrl)

  try {
    // Step 1: check if the dashboard is reachable.
    const statusResponse = await fetch(`${normalizedUrl}/api/status`, {
      method: 'GET',
      credentials: authMode === 'oauth' ? 'include' : 'same-origin',
      headers: authMode === 'token' && token
        ? { 'X-Hermes-Session-Token': token }
        : {},
    })

    if (!statusResponse.ok) {
      const text = await statusResponse.text()
      throw new Error(`${statusResponse.status}: ${text || statusResponse.statusText}`)
    }

    const status = await statusResponse.json()

    // Step 2: verify WebSocket connectivity with proper auth.
    let wsUrl: string | null = null

    if (authMode === 'oauth') {
      // OAuth: mint a fresh WS ticket via POST.
      const ticket = await mintWsTicket(normalizedUrl, 'oauth')
      if (ticket) {
        wsUrl = buildGatewayWsUrlWithTicket(normalizedUrl, ticket)
      }
    } else if (token) {
      wsUrl = buildGatewayWsUrl(normalizedUrl, token)
    }

    if (wsUrl) {
      // Try opening the WebSocket to validate it works.
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl)
        const timer = setTimeout(() => {
          ws.close()
          reject(new Error('WebSocket connection timed out'))
        }, 10_000)

        ws.addEventListener('open', () => {
          clearTimeout(timer)
          ws.close()
          resolve()
        })
        ws.addEventListener('error', () => {
          clearTimeout(timer)
          reject(new Error('WebSocket connection failed'))
        })
      })
    }

    return {
      baseUrl: normalizedUrl,
      ok: true,
      version: status.version || status.version_info || null,
    }
  } catch (error) {
    return {
      baseUrl: normalizedUrl,
      ok: false,
      version: null,
    }
  }
}

// ── Probe connection config ───────────────────────────────────────────────

async function probeConnectionConfigImpl(remoteUrl: string): Promise<{
  baseUrl: string
  reachable: boolean
  authMode: 'oauth' | 'token' | 'unknown'
  providers: Array<{
    name: string
    displayName: string
    supportsPassword?: boolean
  }>
  version: string | null
  error: string | null
}> {
  let normalizedUrl: string
  try {
    normalizedUrl = normalizeRemoteBaseUrl(remoteUrl)
  } catch (error) {
    return {
      baseUrl: String(remoteUrl),
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: `Invalid URL: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  try {
    // Fetch public status endpoint (no auth required).
    const statusResponse = await fetch(`${normalizedUrl}/api/status`)
    if (!statusResponse.ok) {
      const text = await statusResponse.text()
      throw new Error(`${statusResponse.status}: ${text || statusResponse.statusText}`)
    }

    const status = await statusResponse.json()
    const authMode = status.auth_required ? 'oauth' : 'token'

    // Fetch OAuth providers if applicable.
    let providers: Array<{ name: string; displayName: string; supportsPassword?: boolean }> = []
    if (authMode === 'oauth') {
      try {
        const providersResponse = await fetch(`${normalizedUrl}/api/auth/providers`)
        if (providersResponse.ok) {
          const data = await providersResponse.json()
          if (Array.isArray(data)) {
            providers = data.map((p: unknown) => ({
              name: String((p as Record<string, unknown>)?.name || ''),
              displayName: String((p as Record<string, unknown>)?.displayName || (p as Record<string, unknown>)?.name || ''),
              supportsPassword: Boolean((p as Record<string, unknown>)?.supportsPassword),
            }))
          }
        }
      } catch {
        // Non-critical — providers are optional.
      }
    }

    return {
      baseUrl: normalizedUrl,
      reachable: true,
      authMode,
      providers,
      version: status.version || status.version_info || null,
      error: null,
    }
  } catch (error) {
    return {
      baseUrl: normalizedUrl,
      reachable: false,
      authMode: 'unknown',
      providers: [],
      version: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ── Event emitters ────────────────────────────────────────────────────────

/**
 * Simple event emitter used for the various `on*` callback methods.
 * Each channel holds a set of registered callbacks.
 */
const eventChannels = new Map<string, Set<(payload: unknown) => void>>()

function getChannel(name: string): Set<(payload: unknown) => void> {
  if (!eventChannels.has(name)) {
    eventChannels.set(name, new Set())
  }
  return eventChannels.get(name)!
}

function emitEvent(name: string, payload: unknown): void {
  for (const callback of getChannel(name)) {
    try {
      callback(payload)
    } catch {
      // Ignore listener errors.
    }
  }
}

// ── Build the hermesDesktop bridge ────────────────────────────────────────

function createBridge(): typeof window.hermesDesktop {
  // Helper: load config + build connection
  const getConn = async (profile?: string | null) => {
    const config = await loadConnectionConfig()

    // Build WS URL based on auth mode.
    let wsUrl: string = ''
    if (config.remoteAuthMode === 'oauth') {
      // For OAuth, we'll mint a fresh ticket at connect time.
      // Return a placeholder; the caller (resolveGatewayWsUrl) will mint.
      wsUrl = ''
    } else if (config.remoteToken) {
      wsUrl = buildGatewayWsUrl(config.remoteUrl, config.remoteToken)
    }

    return {
      baseUrl: config.remoteUrl,
      isFullscreen: false,
      mode: config.mode as 'local' | 'remote',
      authMode: config.remoteAuthMode,
      nativeOverlayWidth: 0,
      source: config.mode === 'remote' ? 'settings' : 'local',
      token: config.remoteToken || '',
      wsUrl,
      logs: [],
      profile: config.profile ?? null,
      windowButtonPosition: null,
    }
  }

  return {
    // ── Connection ────────────────────────────────────────────────────

    getConnection: (profile?: string | null) => getConn(profile),

    revalidateConnection: async () => ({ ok: true, rebuilt: false }),

    touchBackend: async (profile?: string | null) => ({ ok: true }),

    // ── REST API proxy ───────────────────────────────────────────────

    api: async (request: {
      path: string
      method?: string
      body?: unknown
      timeoutMs?: number
      profile?: string | null
    }) => {
      const config = await loadConnectionConfig()
      return proxyApi(config, request)
    },

    // ── Gateway WS URL ───────────────────────────────────────────────

    getGatewayWsUrl: async (profile?: string | null) => {
      const config = await loadConnectionConfig()

      if (config.remoteAuthMode === 'oauth') {
        // OAuth: mint a fresh ticket.
        const ticket = await mintWsTicket(config.remoteUrl, 'oauth')
        if (!ticket) {
          throw new Error(
            'Could not mint a WebSocket ticket — your session may have expired.'
          )
        }
        return buildGatewayWsUrlWithTicket(config.remoteUrl, ticket)
      }

      // Token mode: build URL with the token.
      if (!config.remoteToken) {
        throw new Error('No session token configured.')
      }
      return buildGatewayWsUrl(config.remoteUrl, config.remoteToken)
    },

    // ── Connection config ────────────────────────────────────────────

    getConnectionConfig: (profile?: string | null) => getConnectionConfigImpl(profile),

    saveConnectionConfig: (payload: unknown) => saveConnectionConfigImpl(payload as Parameters<typeof saveConnectionConfigImpl>[0]),

    applyConnectionConfig: (payload: unknown) => applyConnectionConfigImpl(payload as Parameters<typeof applyConnectionConfigImpl>[0]),

    testConnectionConfig: (payload: unknown) => testConnectionImpl(payload as Parameters<typeof testConnectionImpl>[0]),

    probeConnectionConfig: (remoteUrl: string) => probeConnectionConfigImpl(remoteUrl),

    // ── OAuth ────────────────────────────────────────────────────────

    oauthLoginConnectionConfig: async (remoteUrl: string) => {
      const config = await loadConnectionConfig()
      return oauthLogin(config, remoteUrl)
    },

    oauthLogoutConnectionConfig: async (remoteUrl: string) => {
      const config = await loadConnectionConfig()
      return oauthLogout(config, remoteUrl)
    },

    // ── Profile ──────────────────────────────────────────────────────

    profile: {
      get: async () => {
        const config = await loadConnectionConfig()
        return { profile: config.profile }
      },
      set: async (name: string) => {
        const config = await loadConnectionConfig()
        config.profile = name || null
        await saveConnectionConfig(config)
        return { profile: config.profile }
      },
    },

    // ── Notifications ────────────────────────────────────────────────

    notify: async (payload: {
      title?: string
      body?: string
      silent?: boolean
      kind?: string
      sessionId?: string
      actions?: { id: string; text: string }[]
    }) => {
      try {
        // Use Capacitor LocalNotifications plugin for native notifications.
        await LocalNotifications.schedule({
          notifications: [
            {
              title: payload.title || 'Hermes',
              body: payload.body || '',
              id: parseInt(payload.sessionId ?? String(Date.now()), 10),
              sound: payload.silent ? 'none' : 'default',
              // Attach action buttons if provided (Android supports them).
              actions: payload.actions?.map(action => ({
                id: action.id,
                title: action.text,
              })),
            },
          ],
        })
        return true
      } catch {
        // Fallback to Web Notification API.
        if ('Notification' in window && Notification.permission === 'granted') {
          const notif = new Notification({
            title: payload.title || 'Hermes',
            body: payload.body || '',
          })
          notif.addEventListener('click', () => {
            if (payload.sessionId) {
              emitEvent('notification-action', { sessionId: payload.sessionId, actionId: 'click' })
            }
            window.focus()
          })
          return true
        }
        return false
      }
    },

    // ── Microphone ───────────────────────────────────────────────────

    requestMicrophoneAccess: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // Immediately stop the track (we just needed to request permission).
        stream.getTracks().forEach(track => track.stop())
        return true
      } catch {
        return false
      }
    },

    // ── Clipboard ────────────────────────────────────────────────────

    writeClipboard: async (text: string) => {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      }
      return true
    },

    // ── File operations (stubbed — no filesystem on mobile) ──────────

    readFileDataUrl: async () => '',

    readFileText: async () =>
      ({
        path: '',
        text: '',
        binary: false,
        byteSize: 0,
        truncated: false,
        language: 'text',
        mimeType: 'text/plain',
      }),

    selectPaths: async () => [],

    getPathForFile: () => '',

    readDir: async () => ({ entries: [] }),

    gitRoot: async () => '',

    worktrees: async () => [],

    normalizePreviewTarget: async () => ({
      source: '',
      url: '',
      kind: 'file',
      label: '',
      previewKind: 'text',
    }),

    watchPreviewFile: async () => ({ id: '', path: '' }),

    stopPreviewFileWatch: async () => ({ ok: true }),

    // ── Terminal (stubbed — not available on mobile) ─────────────────

    terminal: {
      start: async () => null,
      dispose: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      write: async () => ({ ok: true }),
      onData: () => () => {},
      onExit: () => () => {},
    },

    // ── Pet overlay (stubbed — desktop only) ─────────────────────────

    petOverlay: {
      open: async () => ({ bounds: { x: 0, y: 0, width: 0, height: 0 }, screen: { id: '' } }),
      close: async () => ({ ok: true }),
      setBounds: () => {},
      setIgnoreMouse: () => {},
      setFocusable: () => {},
      pushState: () => {},
      control: () => {},
      onState: () => () => {},
      onControl: () => () => {},
    },

    // ── Boot progress (stubbed — no local backend) ──────────────────

    getBootProgress: async () => ({
      phase: 'done',
      message: 'Ready',
      progress: 100,
      running: false,
      error: null,
      fakeMode: false,
      timestamp: Date.now(),
    }),

    onBootProgress: (callback: (payload: unknown) => void) => {
      const channel = getChannel('boot-progress')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    // ── Bootstrap (stubbed — not applicable on mobile) ───────────────

    getBootstrapState: async () => ({
      active: false,
      manifest: null,
      stages: {},
      error: null,
      log: [],
      startedAt: null,
      completedAt: null,
      unsupportedPlatform: null,
    }),

    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),
    cancelBootstrap: async () => ({ ok: true, cancelled: false }),
    onBootstrapEvent: () => () => {},

    // ── Version info (stubbed) ───────────────────────────────────────

    getVersion: async () => ({
      appVersion: '0.17.0-mobile',
      electronVersion: 'N/A',
      nodeVersion: 'N/A',
      platform: navigator.userAgent,
      hermesRoot: '',
    }),

    getRemoteDisplayReason: async () => null,

    // ── Window / session windows (stubbed) ───────────────────────────

    openSessionWindow: async () => ({ ok: true }),
    openNewSessionWindow: async () => ({ ok: true }),

    // ── Theme / appearance (stubbed) ─────────────────────────────────

    setTitleBarTheme: () => {},
    setNativeTheme: () => {},
    setTranslucency: () => {},
    setPreviewShortcutActive: () => {},

    // ── External links ───────────────────────────────────────────────

    openExternal: (url: string) => window.open(url, '_blank'),
    openPreviewInBrowser: (url: string) => window.open(url, '_blank'),

    fetchLinkTitle: async (url: string) => {
      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: AbortSignal.timeout(5000),
        })
        // Try to extract title from HTML.
        const text = await response.text()
        const match = text.match(/<title[^>]*>(.*?)<\/title>/i)
        return { title: match?.[1]?.trim() ?? '' }
      } catch {
        return { title: '' }
      }
    },

    sanitizeWorkspaceCwd: async (cwd: string) => cwd,

    // ── Settings ─────────────────────────────────────────────────────

    settings: {
      getDefaultProjectDir: async () => '',
      setDefaultProjectDir: async () => '',
      pickDefaultProjectDir: async () => '',
    },

    // ── Logs (stubbed) ───────────────────────────────────────────────

    revealLogs: async () => false,
    getRecentLogs: async () => [],

    // ── Image save (stubbed) ─────────────────────────────────────────

    saveImageFromUrl: async () => false,
    saveImageBuffer: async () => false,
    saveClipboardImage: async () => false,

    // ── Event listeners ──────────────────────────────────────────────

    onClosePreviewRequested: (callback: () => void) => {
      const fn = () => callback()
      const channel = getChannel('close-preview-requested')
      channel.add(fn)
      return () => channel.delete(fn)
    },

    onOpenUpdatesRequested: (callback: () => void) => {
      const fn = () => callback()
      const channel = getChannel('open-updates')
      channel.add(fn)
      return () => channel.delete(fn)
    },

    onDeepLink: (callback: (payload: unknown) => void) => {
      const channel = getChannel('deep-link')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    signalDeepLinkReady: async () => true,

    onWindowStateChanged: (callback: (payload: unknown) => void) => {
      const channel = getChannel('window-state-changed')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    onFocusSession: (callback: (sessionId: string) => void) => {
      const channel = getChannel('focus-session')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    onNotificationAction: (callback: (payload: unknown) => void) => {
      const channel = getChannel('notification-action')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    onPreviewFileChanged: (callback: (payload: unknown) => void) => {
      const channel = getChannel('preview-file-changed')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    onBackendExit: (callback: (payload: unknown) => void) => {
      const channel = getChannel('backend-exit')
      channel.add(callback)
      return () => channel.delete(callback)
    },

    onPowerResume: (callback: () => void) => {
      const fn = () => callback()
      const channel = getChannel('power-resume')
      channel.add(fn)
      return () => channel.delete(fn)
    },

    // ── Updates (stubbed — not applicable on mobile) ─────────────────

    updates: {
      check: async () => ({ supported: false, reason: 'Updates not supported on mobile' }),
      apply: async () => ({ ok: false, error: 'Updates not supported on mobile' }),
      getBranch: async () => ({ branch: 'mobile' }),
      setBranch: async () => ({ branch: 'mobile' }),
      onProgress: () => () => {},
    },

    // ── Uninstall (stubbed) ──────────────────────────────────────────

    uninstall: {
      summary: async () => ({
        hermes_home: '',
        agent_installed: false,
        gui_installed: false,
        source_built_artifacts: [],
        packaged_app_paths: [],
        userdata_dir: '',
        userdata_exists: false,
        platform: navigator.userAgent,
      }),
      run: async () => ({ ok: false, error: 'Uninstall not supported on mobile' }),
    },

    // ── Themes (stubbed) ─────────────────────────────────────────────

    themes: {
      fetchMarketplace: async () => ({
        extensionId: '',
        displayName: '',
        themes: [],
      }),
      searchMarketplace: async () => [],
    },

    // ── Mobile-specific: direct connection helper ────────────────────

    /**
     * Mobile helper: directly connect to a remote dashboard URL.
     * This is the primary entry point for mobile — it sets up the
     * connection config and returns the ready connection object.
     */
    connectRemote: async (options: {
      url: string
      authMode?: 'oauth' | 'token'
      token?: string
    }): Promise<Awaited<ReturnType<typeof getConn>>> => {
      const baseUrl = normalizeRemoteBaseUrl(options.url)
      const authMode = options.authMode ?? 'token'

      // Save the config.
      const config = await loadConnectionConfig()
      config.mode = 'remote'
      config.remoteUrl = baseUrl
      config.remoteAuthMode = authMode
      config.remoteToken = options.token ?? null
      config.remoteTokenSet = !!options.token
      config.remoteTokenPreview = tokenPreview(config.remoteToken)

      if (authMode === 'oauth') {
        config.remoteOauthConnected = false
      }

      await saveConnectionConfig(config)

      return getConn()
    },

    /**
     * Mobile helper: disconnect and reset connection config to defaults.
     */
    disconnect: async (): Promise<void> => {
      const config = await loadConnectionConfig()
      config.mode = 'remote'
      config.remoteUrl = ''
      config.remoteToken = null
      config.remoteTokenSet = false
      config.remoteTokenPreview = null
      config.remoteOauthConnected = false

      await saveConnectionConfig(config)

      // Clear OAuth session cookies.
      document.cookie.split(';').forEach(cookie => {
        const name = cookie.trim().split('=')[0]
        if (name.includes('hermes_session_')) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;sameSite=Lax`
        }
      })
    },

    /**
     * Mobile helper: check if a remote connection is currently configured.
     */
    isRemoteConfigured: async (): Promise<boolean> => {
      const config = await loadConnectionConfig()
      return config.mode === 'remote' && !!config.remoteUrl
    },
  }
}

// ── Install the bridge ────────────────────────────────────────────────────

// Expose the bridge on `window.hermesDesktop` so the desktop renderer source
// can access it transparently. This is a side-effect import.
window.hermesDesktop = createBridge()

// Register for local notifications on app start.
LocalNotifications.requestPermissions().catch(() => {
  // Registration failed — non-critical; will fall back to Web Notifications.
})
