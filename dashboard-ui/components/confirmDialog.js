import { html, setHtml } from '../render.js';

/** Clicks this soon after opening are ignored, so a double click cannot answer the dialog it opened. */
const ARM_MS = 400;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** In-page confirm (never `window.confirm`): true on confirm, false on Cancel or Esc; focus is trapped. */
export function confirmDialog({ title, message, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.setAttribute('aria-describedby', 'confirm-message');
    setHtml(
      dialog,
      html`<form method="dialog" class="confirm-body">
        <h2 id="confirm-title">${title}</h2>
        <p id="confirm-message">${message}</p>
        <div class="confirm-actions">
          <button type="button" class="btn" data-answer="cancel">${cancelLabel}</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-answer="confirm">${confirmLabel}</button>
        </div>
      </form>`,
    );

    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('keydown', onKey);
      if (dialog.open) dialog.close();
      dialog.remove();
      if (typeof opener?.focus === 'function' && opener.isConnected) opener.focus();
      resolve(answer);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    dialog.addEventListener('keydown', onKey);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    const armedAt = Date.now() + ARM_MS;
    dialog.addEventListener('click', (event) => {
      if (Date.now() < armedAt) return;
      const answer = event.target.closest('[data-answer]')?.dataset.answer;
      if (answer !== undefined) finish(answer === 'confirm');
    });

    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector('[data-answer="cancel"]').focus();
  });
}
