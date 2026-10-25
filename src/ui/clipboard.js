// ===== clipboard.js =====
// Shared copy-to-clipboard helper. Uses the modern Clipboard API when
// available (secure context: https:// or localhost) and falls back to the
// legacy execCommand('copy') path otherwise (file://, plain http://).
// Returns Promise<boolean>.
//
// Used by HudView (COPY ALL) and UnitHistoryView (Copy history). In its
// own file so a fix to the fallback path lands in one place.

export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  return legacyCopy(text);
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  // Off-screen and out of tab order so the copy doesn't cause a visible
  // flash or steal focus.
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  ta.setAttribute('readonly', '');
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}