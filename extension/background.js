// background.js — MV3 service worker.
//
// Receives CREDIT_SNAPSHOT messages from content.js, POSTs them to the local
// backend, and queues them in chrome.storage when the backend is unreachable.

const TAG = '[FCT-bg]';

const DEFAULT_BACKEND = 'http://localhost:8765';
const QUEUE_KEY = 'pending_snapshots';
const LAST_KEY = 'last_balance';
const LAST_AT_KEY = 'last_updated';
const STATUS_KEY = 'backend_status';   // 'online' | 'offline'

// Exponential backoff schedule (ms): 1s, 2s, 4s, 8s, 16s, capped at 30s, max 5 tries.
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_BACKOFF = 30_000;

// --- helpers --------------------------------------------------------------

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.sync.get(['backendUrl']);
  return (backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.sync.get(['apiKey']);
  return apiKey || '';
}

async function authHeaders(extra = {}) {
  const apiKey = await getApiKey();
  const headers = { ...extra };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return headers;
}

async function readQueue() {
  const r = await chrome.storage.local.get([QUEUE_KEY]);
  return Array.isArray(r[QUEUE_KEY]) ? r[QUEUE_KEY] : [];
}

async function writeQueue(items) {
  await chrome.storage.local.set({ [QUEUE_KEY]: items });
}

async function setStatus(status) {
  await chrome.storage.local.set({ [STATUS_KEY]: status });
}

/**
 * Try to POST a single snapshot. Returns true on success.
 * Uses bounded exponential backoff with up to 5 attempts.
 * @param {{balance:number, source_url:string, timestamp:string}} payload
 */
async function postSnapshot(payload) {
  const url = (await getBackendUrl()) + '/api/snapshot';
  const headers = await authHeaders({ 'Content-Type': 'application/json' });

  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
      // Backend reachable but rejected — don't retry forever.
      if (res.status >= 400 && res.status < 500) {
        console.warn(TAG, 'snapshot rejected', res.status);
        return false;
      }
    } catch (e) {
      console.debug(TAG, 'POST failed attempt', attempt + 1, e.message);
    }
    const wait = Math.min(BACKOFF_MS[attempt], MAX_BACKOFF);
    await new Promise(r => setTimeout(r, wait));
  }
  return false;
}

/**
 * Drain the queued snapshots — call when the backend just came back online.
 * Stops on first failure to preserve order.
 */
async function drainQueue() {
  const queue = await readQueue();
  if (queue.length === 0) return;
  console.debug(TAG, 'draining', queue.length, 'queued snapshots');

  const remaining = [...queue];
  while (remaining.length > 0) {
    const item = remaining[0];
    const ok = await postSnapshot(item);
    if (!ok) break;            // ยังออฟไลน์อยู่ — รักษาคิวไว้
    remaining.shift();
    await writeQueue(remaining);
  }
  if (remaining.length === 0) {
    await setStatus('online');
    console.debug(TAG, 'queue fully drained');
  }
}

/**
 * Handle a fresh snapshot from content.js.
 * @param {{balance:number, sourceUrl:string, profileName?:string, profileEmail?:string}} msg
 */
async function handleSnapshot(msg) {
  const payload = {
    balance: msg.balance,
    source_url: msg.sourceUrl || '',
    timestamp: new Date().toISOString(),
    profile_name: msg.profileName || null,
    profile_email: msg.profileEmail || null,
  };

  // Update popup-cached values immediately so the user sees fresh data
  // even if the backend is offline.
  await chrome.storage.local.set({
    [LAST_KEY]: msg.balance,
    [LAST_AT_KEY]: payload.timestamp,
    last_profile_name: msg.profileName || null,
  });

  // ลองยิง snapshot ใหม่ก่อน — ถ้าผ่าน จะ drain คิวเก่าด้วย
  const ok = await postSnapshot(payload);
  if (ok) {
    await setStatus('online');
    await drainQueue();
  } else {
    await setStatus('offline');
    const queue = await readQueue();
    queue.push(payload);
    // กันคิวบวมเกินไป — เก็บแค่ 1000 รายการล่าสุด
    if (queue.length > 1000) queue.splice(0, queue.length - 1000);
    await writeQueue(queue);
    console.debug(TAG, 'queued snapshot, queue size =', queue.length);
  }
}

// --- message routing ------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'CREDIT_SNAPSHOT') {
    handleSnapshot(msg).catch(e => console.warn(TAG, 'handleSnapshot error', e));
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'DRAIN_NOW') {
    drainQueue().catch(e => console.warn(TAG, 'drain error', e));
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'GET_BACKEND_STATUS') {
    chrome.storage.local.get([STATUS_KEY, QUEUE_KEY]).then(r => {
      sendResponse({
        status: r[STATUS_KEY] || 'unknown',
        queueLength: (r[QUEUE_KEY] || []).length,
      });
    });
    return true;
  }

  // PAIR — รับ config จากหน้า admin → save ลง chrome.storage
  if (msg.type === 'PAIR') {
    (async () => {
      try {
        const cfg = msg.config || {};
        const updates = {};
        if (cfg.backendUrl) updates.backendUrl = cfg.backendUrl;
        if (cfg.apiKey)     updates.apiKey = cfg.apiKey;
        // pairedUser: { role, label, member_id, paired_at }
        if (cfg.pairedUser) updates.pairedUser = cfg.pairedUser;
        await chrome.storage.sync.set(updates);
        console.debug(TAG, 'paired with', cfg.pairedUser);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // FORCE_PING — เรียก backend /api/extension/heartbeat ทันที (active probe)
  if (msg.type === 'FORCE_PING') {
    (async () => {
      const backend = await getBackendUrl();
      try {
        const headers = await authHeaders();
        const res = await fetch(backend + '/api/extension/heartbeat', {
          method: 'POST', headers,
        });
        sendResponse({
          ok: res.ok,
          status: res.status,
          backend,
        });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e.message, backend });
      }
    })();
    return true;
  }

  // Proxy fetch สำหรับ content.js — เลี่ยง CORS เพราะ background รันใน extension origin
  if (msg.type === 'BACKEND_FETCH') {
    (async () => {
      try {
        const url = (await getBackendUrl()) + msg.path;
        const headers = await authHeaders(
          msg.body ? { 'Content-Type': 'application/json' } : {}
        );
        const res = await fetch(url, {
          method: msg.method || 'GET',
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        sendResponse({ ok: res.ok, status: res.status, data });
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e.message });
      }
    })();
    return true;
  }
});

// On install: try to drain anything stale.
chrome.runtime.onInstalled.addListener(() => {
  console.debug(TAG, 'installed');
  drainQueue().catch(() => {});
});

// On startup: same.
chrome.runtime.onStartup.addListener(() => {
  drainQueue().catch(() => {});
});
