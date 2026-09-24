const TOAST_MS = 6000;

/** Adds a message to the page's live toast region; text only, never markup. */
export function showToast(message, tone = 'failed') {
  const region = document.getElementById('toasts');
  if (region === null) return;
  const toast = document.createElement('div');
  toast.className = `toast tone-${tone}`;
  toast.setAttribute('role', tone === 'failed' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.textContent = String(message);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => toast.remove());
  toast.append(text, close);
  region.append(toast);
  while (region.children.length > 4) region.firstElementChild?.remove();
  setTimeout(() => toast.remove(), TOAST_MS);
}
