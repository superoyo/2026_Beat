// ===== Multi-profile localStorage =====
const PROFILES_KEY = 'fct_profiles';
function getProfiles() {
  try { return JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]'); } catch { return []; }
}
function saveProfiles(arr) { localStorage.setItem(PROFILES_KEY, JSON.stringify(arr)); }
function removeProfile(token) { saveProfiles(getProfiles().filter(p => p.token !== token)); }

let currentLabel = null;       // ชื่อ active profile
let currentLogoutPath = null;  // /api/admin/logout หรือ /api/member/logout
let currentIsSuper = false;    // true ถ้า super admin (admin_users), false ถ้า admin-member
let currentAvatar = null;      // base64 data URL ของ avatar (member)

async function detectActiveSession() {
  // ลอง super admin ก่อน
  try {
    const a = await fetch('/api/admin/state', { credentials: 'same-origin' }).then(r => r.json());
    if (a.logged_in) {
      return { role: 'admin', label: a.username, logoutPath: '/api/admin/logout', isSuper: true, modules: ['platform', 'customer', 'ads'] };
    }
  } catch {}
  // member — เช็ค is_admin → upgrade เป็น admin
  try {
    const m = await fetch('/api/member/me', { credentials: 'same-origin' }).then(r => r.json());
    if (m.logged_in) {
      const md = m.member;
      const display = md.display_name || md.email || md.phone;
      const role = md.is_admin ? 'admin' : 'member';
      return { role, label: display, logoutPath: '/api/member/logout', isSuper: false, memberId: md.id, avatar: md.avatar_data, modules: md.modules || [] };
    }
  } catch {}
  return null;
}

function renderProfileSwitcherFooter() {
  // current profile pill
  $('who').textContent = currentLabel || '—';
  $('who-role').textContent = currentIsSuper
    ? 'super admin'
    : currentRole === 'admin' ? 'admin (member)' : 'สมาชิก';
  const avatarEl = $('profile-avatar');
  if (currentAvatar) {
    // Replace text with image
    avatarEl.style.background = '#fff';
    avatarEl.style.padding = '0';
    avatarEl.style.overflow = 'hidden';
    avatarEl.innerHTML = `<img src="${currentAvatar}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" />`;
  } else {
    avatarEl.style.background = '';
    avatarEl.style.padding = '';
    avatarEl.style.overflow = '';
    avatarEl.textContent = (currentLabel || '?').trim().charAt(0).toUpperCase();
  }

  // dropdown content
  const list = $('profile-list');
  const profiles = getProfiles();

  $('profile-count').textContent = `บัญชีในเครื่องนี้ (${profiles.length})`;

  if (profiles.length === 0) {
    list.innerHTML = `<div style="padding:8px 10px;color:var(--text-muted);font-size:12px">
      ไม่พบ profile อื่น — กด "เพิ่มบัญชีอื่น" ด้านล่าง
    </div>`;
    return;
  }

  list.innerHTML = profiles.map(p => {
    const isCurrent = p.label === currentLabel && p.role === currentRole;
    const initial = (p.label || '?').trim().charAt(0).toUpperCase();
    return `
      <button class="profile-item ${isCurrent ? 'active' : ''}" data-token="${escapeHtml(p.token)}" type="button">
        <span class="profile-avatar" style="width:28px;height:28px;font-size:12px">${escapeHtml(initial)}</span>
        <span class="profile-item-info">
          <span class="profile-item-name">${escapeHtml(p.label || '—')}</span>
          <span class="profile-item-role">${p.role === 'admin' ? 'admin' : 'สมาชิก'}</span>
        </span>
        ${isCurrent ? '<span class="profile-item-check">✓</span>' : ''}
      </button>
    `;
  }).join('');

  list.querySelectorAll('.profile-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const token = btn.dataset.token;
      // ถ้า active อยู่แล้ว → ปิด menu
      if (btn.classList.contains('active')) {
        $('profile-menu').hidden = true;
        return;
      }
      try {
        const res = await fetch('/api/auth/switch', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) {
          // token หมดอายุแล้ว — ลบจาก localStorage
          removeProfile(token);
          alert('Session นั้นหมดอายุแล้ว — กรุณา login ใหม่');
          return;
        }
        // reload เพื่อ pick up cookie ใหม่
        location.reload();
      } catch (e) {
        alert('สลับบัญชีไม่สำเร็จ: ' + e.message);
      }
    });
  });
}

function attachSidebarHandlers() {
  // toggle dropdown
  $('profile-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $('profile-menu').hidden = !$('profile-menu').hidden;
  });
  document.addEventListener('click', (e) => {
    const m = $('profile-menu');
    if (!m.hidden && !m.contains(e.target) && !$('profile-toggle').contains(e.target)) {
      m.hidden = true;
    }
  });

  // add profile → ไป /login (current cookie จะถูกแทนใน logon ใหม่ แต่ profile เดิมยังอยู่ใน localStorage)
  $('add-profile-btn').addEventListener('click', () => {
    location.href = '/login';
  });

  // logout this account (ลบ session ฝั่ง server + ลบ profile จาก localStorage)
  $('logout-btn').addEventListener('click', async () => {
    try { await fetch(currentLogoutPath, { method: 'POST', credentials: 'same-origin' }); } catch {}
    // v1.9.83 — เคลียร์ Wazzup token ด้วย (ถ้ามี)
    try { sessionStorage.removeItem('fct_wazzup_session'); } catch {}
    // ลบ profile ปัจจุบันจาก localStorage (match ด้วย label+role เพราะไม่มี token ที่ active)
    saveProfiles(getProfiles().filter(p => !(p.label === currentLabel && p.role === currentRole)));
    // ถ้ายังมี profile อื่น → switch ไปอันแรก
    const remaining = getProfiles();
    if (remaining.length > 0) {
      try {
        await fetch('/api/auth/switch', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: remaining[0].token }),
        });
        location.reload();
        return;
      } catch {}
    }
    location.replace('/');
  });

  // logout จากทุกบัญชี — เคลียร์ session ทั้งฝั่ง admin + member + localStorage
  $('logout-all-btn').addEventListener('click', async () => {
    const profiles = getProfiles();
    const n = profiles.length;
    const msg = n > 0
      ? `ออกจากทุกบัญชี (${n} บัญชี) ในเครื่องนี้?\n\nระบบจะลบ session ฝั่ง server และล้างข้อมูล profile ทั้งหมดในเบราว์เซอร์นี้`
      : 'ออกจากระบบและล้าง session ทั้งหมดในเครื่องนี้?';
    if (!confirm(msg)) return;

    // ลบ session ฝั่ง server — ทั้ง admin และ member endpoints (ทำพร้อมกันเพราะ cookies แยกกัน)
    await Promise.allSettled([
      fetch('/api/admin/logout',  { method: 'POST', credentials: 'same-origin' }),
      fetch('/api/member/logout', { method: 'POST', credentials: 'same-origin' }),
    ]);

    // ล้าง localStorage ที่เกี่ยวกับ profile/auth ทั้งหมด
    try { localStorage.removeItem(PROFILES_KEY); } catch {}
    try { sessionStorage.clear(); } catch {}

    location.replace('/login');
  });
}

(async () => {
  const session = await detectActiveSession();
  // v1.9.211 — SSO: redirect-based login ด้วย Beat
  const _ssoCont = new URLSearchParams(location.search).get('sso_continue');
  if (!session) {
    location.replace(_ssoCont ? '/login?sso_continue=' + encodeURIComponent(_ssoCont) : '/login');
    return;
  }
  if (_ssoCont) {
    try { const u = decodeURIComponent(_ssoCont); if (u.startsWith(location.origin + '/sso/authorize')) { location.replace(u); return; } } catch (e) { }
  }
  currentRole = session.role;
  currentLabel = session.label;
  currentLogoutPath = session.logoutPath;
  currentIsSuper = !!session.isSuper;
  currentAvatar = session.avatar || null;
  currentModules = new Set(session.modules || []);

  // v1.9.162 — member: ซ่อนเมนูตามสิทธิ์ (module ที่ได้รับ + admin-only ที่ห้าม)
  if (currentRole === 'member') {
    document.querySelectorAll('.nav a[data-route]').forEach(a => {
      const route = a.dataset.route;
      let show;
      if (route === 'hardware-pc-dashboard') {
        // v1.9.339 — link Device & Software: แสดงถ้ามีสิทธิ์เมนูย่อยใดก็ได้ + ชี้ href ไปเมนูแรกที่มีสิทธิ์
        const granted = HW_NAV_ROUTES.filter(r => currentModules.has(ROUTE_MODULE[r]));
        show = granted.length > 0;
        if (show) a.href = '#/' + granted[0];
      } else {
        const reqMod = ROUTE_MODULE[route];
        if (reqMod) show = currentModules.has(reqMod);            // Platform/Customer/Ads → ตามสิทธิ์ module
        else if (HIDE_FROM_MEMBER_NAV.has(route) || ADMIN_ONLY_ROUTES.has(route)) show = false;  // admin-only อื่น ๆ
        else show = true;                                          // dashboard / my profile
      }
      a.style.display = show ? '' : 'none';
    });
    // section admin-only: แสดงเฉพาะถ้ามี item ที่เห็นได้ข้างใน
    document.querySelectorAll('.nav-section[data-admin-section]').forEach(s => {
      const anyVisible = Array.from(s.querySelectorAll('a[data-route]')).some(a => a.style.display !== 'none');
      s.style.display = anyVisible ? '' : 'none';
    });
  }

  attachSidebarHandlers();
  renderProfileSwitcherFooter();

  // Default route — admin → dashboard, member → platforms
  if (!location.hash) {
    // หน้าแรกของทุกบทบาทคือ dashboard
    location.hash = '#/dashboard';
  }
  await navigate();

  // Admin: poll Access Request badge ทุก 60 วินาที
  if (currentRole === 'admin') {
    refreshAccessRequestBadge();
    setInterval(refreshAccessRequestBadge, 60_000);
  }

})();
