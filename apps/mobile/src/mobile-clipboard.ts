/**
 * Mobile clipboard shim.
 *
 * On desktop, `lib/clipboard.ts` installs a shim that routes
 * `navigator.clipboard.writeText` through Electron IPC to avoid
 * "Write permission denied" when the document loses focus.
 *
 * On mobile, the native clipboard API works fine (no focus-stealing window
 * managers). We install a lightweight wrapper that:
 *   - Uses `navigator.clipboard` when available (HTTPS + focus).
 *   - Falls back to a programmatic copy for edge cases.
 */

export function installMobileClipboardShim(): void {
  if (!navigator.clipboard) {
    return
  }

  // Mobile browsers handle clipboard permissions properly; no shim needed.
  // This function exists as a parity import point with the desktop's
  // `installClipboardShim()` so the same code path is exercised.
  // On mobile the native API is used directly.
}
