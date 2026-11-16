import { csrfToken } from './authService';

const NOTIFICATIONS_API_BASE = '/api/notifications';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function getNotificationPermission() {
  if (!isPushSupported()) {
    return 'unsupported';
  }
  return Notification.permission;
}

export async function getPushStatus(endpoint = null) {
  const qs = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '';
  const res = await fetch(`${NOTIFICATIONS_API_BASE}/push/status${qs}`, {
    method: 'GET',
    credentials: 'include',
  });
  if (!res.ok) {
    throw new Error('Failed to fetch push status');
  }
  return res.json();
}

export async function subscribeToPushNotifications() {
  if (!isPushSupported()) {
    return { status: 'unsupported' };
  }

  // Ask for permission only when user triggers this action
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { status: 'denied', permission };
  }

  const statusData = await getPushStatus();
  if (!statusData.vapidPublicKey) {
    throw new Error('VAPID public key not available from server');
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const convertedVapidKey = urlBase64ToUint8Array(statusData.vapidPublicKey);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: convertedVapidKey,
    });
  }

  const token = await csrfToken();
  const subJson = subscription.toJSON();

  const res = await fetch(`${NOTIFICATIONS_API_BASE}/push/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': token,
    },
    body: JSON.stringify({
      endpoint: subJson.endpoint,
      keys: subJson.keys,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to save subscription on server');
  }

  return { status: 'subscribed', subscription };
}

export async function unsubscribeFromPushNotifications() {
  if (!isPushSupported()) {
    return { status: 'unsupported' };
  }

  let endpoint = null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      endpoint = subscription.endpoint;
      await subscription.unsubscribe();
    }
  } catch {}

  if (endpoint) {
    const token = await csrfToken();
    await fetch(`${NOTIFICATIONS_API_BASE}/push/subscribe`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
      },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  }

  return { status: 'unsubscribed' };
}
