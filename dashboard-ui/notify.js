import { bannerVisible, diffWaiting, notificationFor } from './notifyModel.js';
import { html, patch } from './render.js';
import { href } from './routes.js';

const DISMISSED_KEY = 'factory.notifications.notNow';

function readDismissed() {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Private mode or blocked storage: "Not now" lasts until the page reloads.
  }
}

/** The permission banner (J7) and one desktop notification per newly waiting item. */
export function startNotifications({ store, projectName }) {
  const supported = typeof window.Notification === 'function';
  let dismissed = readDismissed();
  let seen = null;

  const permission = () => (supported ? window.Notification.permission : 'denied');

  const drawBanner = (state) => {
    const waiting = (state.status?.needs_human ?? []).length;
    patch(
      document,
      'notify',
      bannerVisible({ supported, permission: permission(), dismissed, waiting })
        ? html`<div class="notify-banner" role="region" aria-label="Notifications">
            <p>Get a desktop notification when the factory needs you?</p>
            <button type="button" class="btn btn-small btn-primary" data-notify="allow">Allow</button>
            <button type="button" class="btn btn-small" data-notify="not-now">Not now</button>
          </div>`
        : html``,
    );
  };

  const raise = (item, project) => {
    const { title, body, tag } = notificationFor(item, project);
    try {
      const shown = new window.Notification(title, { body, tag });
      shown.onclick = () => {
        window.focus();
        location.hash = href({ name: 'review', id: item.id });
        shown.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker; the tab title still counts.
    }
  };

  const onState = (state) => {
    drawBanner(state);
    if (state.status === null) return;
    const items = state.status.needs_human ?? [];
    const next = diffWaiting(seen, items.map((i) => i.id));
    seen = next.seen;
    if (permission() !== 'granted') return;
    for (const id of next.fresh) {
      const item = items.find((i) => i.id === id);
      if (item !== undefined) raise(item, projectName(state.status));
    }
  };

  document.addEventListener('click', async (event) => {
    const choice = event.target.closest?.('[data-notify]')?.dataset.notify;
    if (choice === undefined) return;
    if (choice === 'not-now') {
      dismissed = true;
      writeDismissed();
    } else if (supported) {
      try {
        await window.Notification.requestPermission();
      } catch {
        // Treated as "not granted"; the banner goes once the browser has an answer.
      }
    }
    drawBanner(store.get());
  });

  store.subscribe(onState);
  onState(store.get());
}
