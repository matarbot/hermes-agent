/**
 * Mobile entry point.
 *
 * Installs the Capacitor-based `hermesDesktop` bridge on `window` BEFORE
 * loading the desktop renderer source, so all React components that access
 * `window.hermesDesktop` receive a fully-functional mobile implementation.
 *
 * After the bridge is installed, this delegates to the desktop's main.tsx
 * (via shared Vite build) for all rendering, providers, and routing.
 *
 * The translucency import (`@/store/translucency`) is stubbed out by a
 * Vite alias override so the Electron-specific code never runs.
 */

// ── 1. Install the bridge BEFORE anything else ─────────────────────────
import './bridge.ts'

// ── 2. Desktop renderer source (shared via Vite alias) ─────────────────
// This is the same main.tsx that the desktop app uses. Vite alias resolves
// `@/store/translucency` to our mobile stub instead of the real module.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import '@/main'
