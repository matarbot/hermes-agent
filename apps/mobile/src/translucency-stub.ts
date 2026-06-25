/**
 * Stub replacement for the desktop's `@/store/translucency` module.
 *
 * The desktop translucency module calls `hermesDesktop.setTranslucency()` to
 * configure the Electron window's visual effect. On mobile this has no
 * equivalent — the Capacitor WebView manages its own rendering.
 *
 * This file is wired into the Vite `resolve.alias` config so that the
 * desktop's `import './store/translucency'` resolves here on mobile.
 */

// Intentionally empty — no translucency logic for mobile.
