// popup.js — reads cached state from chrome.storage + a single backend
// summary call. No DOM scraping happens here.

const DEFAULT_BACKEND = 'http://localhost:8765';
const fmt = new Intl.NumberFormat('th-TH');

function fmtRel(iso) {
  if (!iso) return 'ยังไม่มีข้อมูล';
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'เมื่อสักครู่';
  if (sec < 3600) return Math.floor(sec / 60) + ' นาทีที่แล้ว';
  if (sec < 86400) return Math.floor(sec / 3600) + ' ชม.ที่แล้ว';
  return Math.floor(sec / 86400) + ' วันที่แล้ว';
}

async function getBackendUrl() {
  const { backendUrl } = await chrome.storage.sync.get(['backendUrl']);
  return (backendUrl || DEFAULT_BACKEND).replace(/\/$/, '');
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.sync.get(['apiKey']);
  return apiKey || '';
}

function fmtAbsoluteDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('th-TH', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function showProfile(name) {
  const wrap = document.getElementById('profile');
  if (name) {
    wrap.style.display = '';
    const el = document.getElementById('profile-name');
    el.textContent = '🌐 Freepik: ' + name;
    el.title = name;
  } else {
    wrap.style.display = 'none';
  }
}

async function showPairedUser() {
  const card = document.getElementById('pair-card');
  const avatar = document.getElementById('pair-avatar');
  const nameEl = document.getElementById('pair-name');
  const metaEl = document.getElementById('pair-meta');

  const r = await chrome.storage.sync.get(['pairedUser']);
  const p = r.pairedUser || null;

  // เคลียร์ class state เก่า
  card.classList.remove('member', 'admin', 'unpaired');

  if (!p) {
    card.classList.add('unpaired');
    avatar.textContent = '🔒';
    nameEl.textContent = 'ยังไม่ได้ Pair';
    nameEl.style.color = '#8b95a8';
    metaEl.textContent = 'autofill ปิด — เปิดระบบหลังบ้านเพื่อ pair';
    return;
  }

  const isAdmin = (p.role === 'admin') || p.member_id == null;
  card.classList.add(isAdmin ? 'admin' : 'member');
  const label = p.label || 'unknown';
  avatar.textContent = (label.trim().charAt(0) || '?').toUpperCase();
  nameEl.style.color = '';
  nameEl.textContent = label;
  nameEl.title = label;

  const parts = [];
  if (isAdmin) {
    parts.push('admin (bypass team)');
  } else {
    parts.push('member · ID ' + p.member_id);
  }
  if (p.deviceLabel) parts.push('💻 ' + p.deviceLabel);
  metaEl.textContent = parts.join(' · ');
  metaEl.title = metaEl.textContent;
}

async function loadCached() {
  const r = await chrome.storage.local.get(['last_balance', 'last_updated', 'last_profile_name']);
  if (r.last_balance != null) {
    document.getElementById('balance').textContent = fmt.format(Math.round(r.last_balance));
  }
  document.getElementById('updated').textContent = 'อัพเดท: ' + fmtRel(r.last_updated);
  document.getElementById('balance-time').textContent = fmtAbsoluteDateTime(r.last_updated);
  showProfile(r.last_profile_name);
}

async function loadSummary() {
  const url = (await getBackendUrl()) + '/api/summary';
  const apiKey = await getApiKey();
  const headers = {};
  if (apiKey) headers['X-API-Key'] = apiKey;
  try {
    const res = await fetch(url, { cache: 'no-store', headers });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();

    if (s.current_balance != null) {
      document.getElementById('balance').textContent = fmt.format(Math.round(s.current_balance));
    }
    if (s.last_snapshot_at) {
      document.getElementById('updated').textContent = 'อัพเดท: ' + fmtRel(s.last_snapshot_at);
      document.getElementById('balance-time').textContent = fmtAbsoluteDateTime(s.last_snapshot_at);
    }
    showProfile(s.profile_name);

    const dot = document.getElementById('alert-dot');
    const txt = document.getElementById('alert-text');
    dot.classList.remove('ok', 'warning', 'critical');
    dot.classList.add(s.alert_level || 'ok');
    if (s.days_until_empty == null) {
      txt.textContent = 'ยังไม่พอข้อมูลคำนวณ burn rate';
    } else {
      const labels = { ok: 'ใช้งานปกติ', warning: 'ใกล้หมด', critical: 'วิกฤต' };
      txt.textContent = `${labels[s.alert_level] || 'ปกติ'} · เหลืออีก ${s.days_until_empty} วัน`;
    }

    setConn('online');
    return true;
  } catch (e) {
    setConn('offline');
    return false;
  }
}

function setConn(status) {
  const dot = document.getElementById('conn-dot');
  const txt = document.getElementById('conn-text');
  dot.classList.remove('online', 'offline');
  dot.classList.add(status);
  txt.textContent = status === 'online'
    ? 'เชื่อมต่อ backend แล้ว'
    : 'ติดต่อ backend ไม่ได้ — โปรดเปิด server';
}

document.getElementById('dashboard-btn').addEventListener('click', async () => {
  const url = await getBackendUrl();
  chrome.tabs.create({ url: url + '/dashboard' });
});

document.getElementById('options-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

(async () => {
  await Promise.all([
    showPairedUser(),
    loadCached(),
  ]);
  await loadSummary();
})();
