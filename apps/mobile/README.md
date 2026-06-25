# Hermes Mobile

Mobile shell for Hermes Agent, built with Capacitor to wrap the desktop React renderer.

## Architecture

The mobile app reuses the desktop's Vite-built React renderer (`apps/desktop/src/`)
and replaces the Electron IPC bridge (`window.hermesDesktop`) with a Capacitor-based
implementation that talks to a remote Hermes dashboard over HTTP/WebSocket.

```
apps/mobile/
├── src/
│   ├── bridge.ts           # hermesDesktop bridge (Capacitor + fetch + Storage)
│   ├── mobile-entry.tsx    # Entry point: installs bridge → loads desktop renderer
│   ├── mobile-clipboard.ts # Mobile clipboard shim (no-op, native API works)
│   └── translucency-stub.ts # No-op replacement for desktop's translucency module
├── index.html              # Mobile HTML shell (loads mobile-entry.tsx)
├── capacitor.config.ts     # Capacitor config
├── vite.config.ts          # Vite config pointing to desktop source
├── tsconfig.json           # TS config with path aliases
├── package.json
└── scripts/
    └── post-build.cjs      # Copies dist/ → www/ for cap sync
```

## Prerequisites

- Node.js 20+ (matching the desktop app)
- npm workspaces (install root first: `npm install --workspaces=false`)
- For native builds:
  - Android: Android Studio + SDK
  - iOS: Xcode + macOS

## Quick Start

```bash
# From the monorepo root (~/projects/hermes-mobile/)
cd apps/mobile

# 1. Install dependencies
npm install

# 2. Start the Vite dev server
npm run dev
```

Then in a separate terminal:

```bash
# Run the Capacitor dev server (iOS)
npx cap run ios --external

# Run the Capacitor dev server (Android)
npx cap run android --external
```

The `--external` flag tells Capacitor to connect to the Vite dev server on your
machine. On iOS Simulator this works out of the box. On Android you may need to use
`adb reverse tcp:5175 tcp:5175` first.

## Building for production

```bash
npm run android   # Build + sync to Android
npm run ios       # Build + sync to iOS
npm run open:android  # Open Android Studio project
npm run open:ios      # Open Xcode project
```

## Bridge implementation details

The `hermesDesktop` bridge (`src/bridge.ts`) implements the full interface defined
in `apps/desktop/src/global.d.ts`. Here's how each method is adapted:

| Method | Desktop (Electron IPC) | Mobile (Capacitor) |
|--------|----------------------|-------------------|
| `getConnection()` | Main process | localStorage config |
| `api(request)` | Electron `net` module | browser `fetch()` |
| `getGatewayWsUrl()` | Main process mint | REST call + build URL |
| `probeConnectionConfig()` | Electron `net` | browser `fetch()` |
| `testConnectionConfig()` | Electron `net` + ws | browser `fetch()` + ws |
| `getConnectionConfig()` | Electron file read | Capacitor Preferences |
| `saveConnectionConfig()` | Electron file write | Capacitor Preferences + SecureStorage |
| `notify()` | Electron Notification API | Capacitor Notifications |
| `terminal` | node-pty child process | **stubbed** |
| `petOverlay` | Electron BrowserWindow | **stubbed** |
| `selectPaths` | Electron dialog | **stubbed** |
| `readFileDataUrl` | Electron fs | **stubbed** |
| `readFileText` | Electron fs | **stubbed** |
| `readDir` | Electron fs | **stubbed** |
| `updates` | Git + electron-builder | **stubbed** |
| `themes` | Electron net + fs | **stubbed** |
| `uninstall` | Electron fs + shell | **stubbed** |

### Auth modes

Two auth modes are supported for remote connections:

- **Token**: A static session token sent via `X-Hermes-Session-Token` header on REST
  calls and as `?token=` in the WebSocket URL.
- **OAuth**: Session cookies stored in the WebView's cookie jar (OAuth on mobile uses
  the browser's `credentials: 'include'` for REST, and `POST /api/auth/ws-ticket`
  for minting WebSocket tickets).

### Connection config persistence

- Non-sensitive config (URL, auth mode, etc.): `@capacitor/preferences` (key-value storage)
- Sensitive tokens: `@capacitor/secure-storage-plugin` (Keychain on iOS, Keystore on Android)

## Mobile-specific bridge methods

In addition to the standard `hermesDesktop` methods, the mobile bridge adds:

- `connectRemote({ url, authMode, token })` — Direct connection to a remote dashboard.
- `disconnect()` — Clear all connection state.
- `isRemoteConfigured()` — Check if a remote connection is configured.
