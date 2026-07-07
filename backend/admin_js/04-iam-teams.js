// ============== v1.9.162 — IAM (สิทธิ์เข้าถึง module) ==============
async function renderIamPage() {
  const root = _subMain();
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let data;
  try { data = await fetchJson('/api/iam/modules'); }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const mods = data.modules || [];
  root.innerHTML = `
    <div class="card" style="display:block;margin-bottom:14px;background:var(--bg-soft)">
      <div style="font-size:13px;color:var(--text-muted);line-height:1.7">🔐 <strong>IAM</strong> — กำหนดว่าแต่ละ Module (เมนู) เปิดให้พนักงานคนไหนเข้าได้ — เลือก <strong>ทุกคน</strong> หรือ <strong>กำหนดเอง</strong> (รายบุคคล/ทีม) · admin เห็นทุก module เสมอ</div>
    </div>
    ${mods.map(m => {
      const summary = m.mode === 'all'
        ? '<span style="color:var(--green);font-weight:600">👥 ทุกคน</span>'
        : `<span style="color:var(--text-muted)">🎯 กำหนดเอง — ${m.members.length} คน · ${m.teams.length} ทีม</span>`;
      const chips = m.mode === 'all' ? '' : `
        <div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:10px">
          ${m.teams.map(t => `<span style="font-size:11px;padding:2px 9px;border-radius:999px;background:rgba(37,99,235,.10);color:var(--primary)">👥 ${escapeHtml(t.name)}</span>`).join('')}
          ${m.members.map(mm => `<span style="font-size:11px;padding:2px 9px;border-radius:999px;background:var(--bg-soft);border:1px solid var(--border)">👤 ${escapeHtml(mm.name)}</span>`).join('')}
          ${(m.members.length === 0 && m.teams.length === 0) ? '<span style="font-size:11.5px;color:var(--text-soft);font-style:italic">— ยังไม่ได้กำหนดใคร (เห็นเฉพาะ admin) —</span>' : ''}
        </div>`;
      return `
        <div class="card" style="display:block;margin-bottom:12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
            <div style="min-width:0">
              <div style="font-size:15px;font-weight:700">${m.icon} ${escapeHtml(m.label)}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${escapeHtml(m.desc)} · ${summary}</div>
            </div>
            <button class="btn" data-iam-cfg="${m.key}" style="font-size:13px;padding:8px 14px">⚙️ ตั้งค่า</button>
          </div>${chips}
        </div>`;
    }).join('')}`;
  root.querySelectorAll('[data-iam-cfg]').forEach(b => b.addEventListener('click', () => configIamModule(mods.find(x => x.key === b.dataset.iamCfg))));
}
async function configIamModule(mod) {
  if (!mod) return;
  const [teams, memberOpts] = await Promise.all([_loadAiprojTeams(), _loadSkillMemberOpts()]);
  const selMembers = new Set(mod.members.map(x => x.id));
  const selTeams = new Set(mod.teams.map(x => x.id));
  let mode = mod.mode;
  showModal({
    title: `🔐 ตั้งค่าสิทธิ์ — ${mod.label}`, size: 'wide',
    body: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:flex;gap:8px">
          <button type="button" class="iam-mode-btn" data-mode="all" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg-card);cursor:pointer;font-family:inherit;font-weight:600;font-size:13px">👥 ทุกคน</button>
          <button type="button" class="iam-mode-btn" data-mode="restricted" style="flex:1;padding:11px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg-card);cursor:pointer;font-family:inherit;font-weight:600;font-size:13px">🎯 กำหนดเอง</button>
        </div>
        <div id="iam-restricted" style="display:none;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:7px">ทีม (ทุกคนในทีมเห็นได้)</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow-y:auto">
              ${teams.map(t => `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;padding:6px 11px;border:1px solid var(--border);border-radius:8px;cursor:pointer"><input type="checkbox" class="iam-team" value="${t.id}" ${selTeams.has(t.id) ? 'checked' : ''} style="margin:0"/> ${escapeHtml(t.name)}</label>`).join('') || '<span style="font-size:12px;color:var(--text-muted)">— ไม่มีทีม —</span>'}
            </div>
          </div>
          <div>
            <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin-bottom:7px">รายบุคคล</div>
            <input type="text" id="iam-mem-search" placeholder="🔍 ค้นหาชื่อ / ทีม..." autocomplete="off" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;margin-bottom:8px;box-sizing:border-box" />
            <div id="iam-members" style="max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:4px"></div>
          </div>
        </div>
      </div>`,
    onSubmit: async () => {
      await fetchJson(`/api/iam/modules/${mod.key}`, { method: 'PUT', body: JSON.stringify({
        mode,
        member_ids: mode === 'restricted' ? [...selMembers] : [],
        team_ids: mode === 'restricted' ? [...selTeams] : [],
      })});
      showSavedToast('✓ บันทึกสิทธิ์แล้ว');
      renderIamPage();
    },
  });
  setTimeout(() => {
    const restrictedBox = document.getElementById('iam-restricted');
    const setMode = (m) => {
      mode = m;
      document.querySelectorAll('.iam-mode-btn').forEach(b => {
        const on = b.dataset.mode === m;
        b.style.borderColor = on ? 'var(--primary)' : 'var(--border)';
        b.style.background = on ? 'var(--primary-soft)' : 'var(--bg-card)';
        b.style.color = on ? 'var(--primary-dark)' : 'var(--text)';
      });
      if (restrictedBox) restrictedBox.style.display = m === 'restricted' ? 'flex' : 'none';
    };
    document.querySelectorAll('.iam-mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
    setMode(mode);
    document.querySelectorAll('.iam-team').forEach(cb => cb.addEventListener('change', () => {
      const id = parseInt(cb.value, 10);
      if (cb.checked) selTeams.add(id); else selTeams.delete(id);
    }));
    const memBox = document.getElementById('iam-members');
    const renderMembers = (q) => {
      q = (q || '').toLowerCase().trim();
      const list = memberOpts.filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.team || '').toLowerCase().includes(q));
      memBox.innerHTML = list.map(m => `<label style="display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:6px;cursor:pointer;font-size:13px"><input type="checkbox" class="iam-mem" value="${m.id}" ${selMembers.has(m.id) ? 'checked' : ''} style="margin:0"/> <span>${escapeHtml(m.name)}${m.team ? ` <span style="font-size:11px;color:var(--text-soft)">· ${escapeHtml(m.team)}</span>` : ''}</span></label>`).join('') || '<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center">ไม่พบรายชื่อ</div>';
      memBox.querySelectorAll('.iam-mem').forEach(cb => cb.addEventListener('change', () => {
        const id = parseInt(cb.value, 10);
        if (cb.checked) selMembers.add(id); else selMembers.delete(id);
      }));
    };
    renderMembers('');
    const ms = document.getElementById('iam-mem-search');
    if (ms) ms.addEventListener('input', e => renderMembers(e.target.value));
  }, 30);
}

async function renderSecurityPage() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🔑 Extension API Key</h2>
      <button class="btn danger" id="regen-btn">Regenerate Key</button>
    </div>
    <div class="warning-box">
      ⚠️ <strong>เก็บเป็นความลับ:</strong> ใครได้ key นี้ไปจะอ่าน credentials ทั้งหมดในระบบได้
      ถ้าหลุด → กด <strong>Regenerate</strong> เพื่อสร้างใหม่ทันที (extension ของทุกเครื่องต้องอัพเดท key ใหม่)
    </div>
    <div class="card" style="display:block">
      <div class="card-sub" style="margin-bottom:8px">API Key ปัจจุบัน</div>
      <div class="key-block">
        <span id="api-key-value" class="val">…</span>
        <button class="btn" id="copy-key-btn" style="white-space:nowrap">📋 คัดลอก</button>
      </div>
    </div>
    <div class="card" style="display:block;margin-top:14px">
      <div>
        <div class="card-title" style="margin-bottom:8px">วิธีใช้</div>
        <ol style="line-height:1.8;color:var(--text);font-size:13.5px;padding-left:20px;margin:0">
          <li>กดไอคอน FEFL Beat extension บน Chrome toolbar → <strong>ตั้งค่า</strong></li>
          <li>วาง API key ลงในช่อง <strong>API Key</strong></li>
          <li>กด <strong>บันทึก</strong> → Extension จะส่ง key นี้ไปกับทุก request</li>
        </ol>
      </div>
    </div>

    <!-- v1.9.114 — ตั้งค่าหน้า Login (background + tagline) -->
    <div class="page-head" style="margin-top:28px"><h2 class="page-title">🎨 หน้า Login (Appearance)</h2></div>
    <div class="card" style="display:block">
      <div class="card-sub" style="margin-bottom:14px">ตั้งภาพพื้นหลัง (ฝั่งขวา) + ข้อความ tagline ของหน้า login — ภาพจะถูกย่อก่อนบันทึก</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
        <div id="la-preview" style="width:260px;height:160px;border-radius:12px;border:2px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;background-size:cover;background-position:center">
          <span style="color:var(--text-muted);font-size:12px;text-align:center">ยังไม่มีภาพ<br/>(ใช้ gradient default)</span>
        </div>
        <div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:10px">
          <button type="button" class="btn" id="la-upload-btn" style="font-size:13px;padding:8px 14px;text-align:left">📷 อัพโหลดภาพพื้นหลัง</button>
          <button type="button" class="btn danger" id="la-remove-btn" style="font-size:13px;padding:8px 14px;text-align:left;display:none">🗑 ลบภาพ (ใช้ gradient)</button>
          <label style="display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;margin-top:4px">
            Tagline (ข้อความฝั่งขวา)
            <input type="text" id="la-tagline" maxlength="120" placeholder="เช่น AI Solution Hub for Marketing" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
            <span style="font-size:11px;color:var(--text-muted)">ขึ้นบรรทัดใหม่: พิมพ์ \\n หรือเว้นไว้ใช้ค่า default</span>
          </label>
          <div class="hint" id="la-msg" style="display:none;margin-top:2px"></div>
          <button class="btn primary" id="la-save-btn" style="font-size:13px;padding:9px 16px;align-self:flex-start">บันทึกการตั้งค่าหน้า Login</button>
        </div>
        <input type="file" id="la-file-input" accept="image/*" style="display:none" />
      </div>
    </div>
  `;

  let key = '…';
  try {
    const r = await fetchJson('/api/admin/api-key');
    key = r.api_key;
  } catch (e) {
    key = '(โหลดไม่สำเร็จ: ' + e.message + ')';
  }
  $('api-key-value').textContent = key;

  $('copy-key-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(key);
    const b = $('copy-key-btn');
    const orig = b.textContent;
    b.textContent = '✓ คัดลอกแล้ว';
    setTimeout(() => { b.textContent = orig; }, 1500);
  });

  $('regen-btn').addEventListener('click', async () => {
    if (!confirm('Regenerate API key? Extension ทุกเครื่องที่ใช้ key เก่าจะใช้งานไม่ได้จนกว่าจะอัพเดท')) return;
    const r = await fetchJson('/api/admin/api-key/regenerate', { method: 'POST' });
    key = r.api_key;
    $('api-key-value').textContent = key;
    alert('สร้าง key ใหม่แล้ว — กรุณาคัดลอกไปวางใน extension options');
  });

  // v1.9.114 — Login appearance (background + tagline)
  let laBgImage = null;  // current/new base64 (null = ไม่เปลี่ยน, '' = ลบ)
  const laSetPreview = (dataUrl) => {
    const box = $('la-preview');
    const rm = $('la-remove-btn');
    if (dataUrl) {
      box.style.backgroundImage = `url("${dataUrl}")`;
      box.style.borderStyle = 'solid';
      box.innerHTML = '';
      if (rm) rm.style.display = '';
    } else {
      box.style.backgroundImage = '';
      box.style.borderStyle = 'dashed';
      box.innerHTML = '<span style="color:var(--text-muted);font-size:12px;text-align:center">ยังไม่มีภาพ<br/>(ใช้ gradient default)</span>';
      if (rm) rm.style.display = 'none';
    }
  };
  // โหลดค่าปัจจุบัน
  try {
    const a = await fetchJson('/api/login-appearance');
    if (a.bg_image) { laSetPreview(a.bg_image); }
    if (a.tagline && $('la-tagline')) $('la-tagline').value = a.tagline;
  } catch {}
  // upload + compress (max 1600px, JPEG ~0.82)
  const laFile = $('la-file-input');
  $('la-upload-btn').addEventListener('click', () => laFile.click());
  laFile.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1600;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        laBgImage = c.toDataURL('image/jpeg', 0.82);
        laSetPreview(laBgImage);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(f);
    laFile.value = '';
  });
  $('la-remove-btn').addEventListener('click', () => { laBgImage = ''; laSetPreview(''); });
  $('la-save-btn').addEventListener('click', async () => {
    const body = {};
    if (laBgImage !== null) body.bg_image = laBgImage;  // '' = ลบ, base64 = ภาพใหม่
    const tag = ($('la-tagline').value || '').replace(/\\n/g, '\n');
    body.tagline = tag;
    const btn = $('la-save-btn'); btn.disabled = true;
    try {
      await fetchJson('/api/admin/login-appearance', { method: 'POST', body: JSON.stringify(body) });
      const m = $('la-msg'); m.textContent = '✓ บันทึกแล้ว — รีเฟรชหน้า login เพื่อดูผล'; m.style.display = ''; m.style.color = 'var(--green)';
      laBgImage = null;  // reset (saved)
    } catch (e) {
      const m = $('la-msg'); m.textContent = '❌ ' + e.message; m.style.display = ''; m.style.color = 'var(--critical)';
    } finally { btn.disabled = false; }
  });
}

/**
 * แปลง URL pattern (เช่น *.freepik.com/*) → URL ที่กดเข้าได้จริง
 *  - ตัด protocol ออกก่อน, แทน '*.' ด้วย 'www.', ตัด '/* ' ท้าย
 *  - แล้วใส่ https:// กลับเข้าไป
 */
function patternToUrl(pattern) {
  if (!pattern) return '';
  let url = String(pattern).replace(/^https?:\/\//i, '');
  url = url.replace(/^\*\./, 'www.');     // *.freepik.com → www.freepik.com
  url = url.replace(/\/\*$|\*$/, '/');    // /* หรือ * ท้าย → /
  url = url.replace(/\*/g, '');           // ลบ wildcard ที่เหลือ (ถ้ามี)
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

// State สำหรับ Platforms page
let _platformsData = null;
let _platformSort = 'mine';   // 'az' | 'mine' | 'global'
let _teamsOverview = null;     // [{id, name, site_ids}, ...]
let _spotlightTeamId = null;   // null = ไม่เลือก spotlight

async function renderPlatformsPage(initialTab) {
  $('main').innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🚀 Platforms</h2>
    </div>
    <div class="acc-layout">
      <!-- เมนูซ้าย -->
      <div class="acc-menu">
        <button type="button" class="acc-menu-item active" data-plat-tab="platform"><span class="acc-menu-ico">🚀</span> Platform</button>
        <button type="button" class="acc-menu-item" data-plat-tab="skill"><span class="acc-menu-ico">🛒</span> Skill Marketplace</button>
        <button type="button" class="acc-menu-item" data-plat-tab="aiproject"><span class="acc-menu-ico">🤖</span> AI Project</button>
        <button type="button" class="acc-menu-item" data-plat-tab="claude-rl"><span class="acc-menu-ico">⏱️</span> Claude RateLimit</button>
        <button type="button" class="acc-menu-item" data-plat-tab="creditcard"><span class="acc-menu-ico">💳</span> Credit Card</button>
      </div>
      <!-- เนื้อหาขวา -->
      <div class="acc-detail">
        <!-- ============ Platform ============ -->
        <div data-plat-panel="platform">
          ${(currentRole === 'admin' || currentIsSuper) ? `
            <div style="margin-bottom:14px">
              <a href="#/sites" class="btn" id="plat-config-btn" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;padding:8px 14px;text-decoration:none">⚙️ Configuration</a>
            </div>
          ` : ''}
          <div id="p-hint" class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px"></div>

          <div style="display:grid;grid-template-columns:1fr auto auto;gap:10px;margin-bottom:12px;align-items:center;flex-wrap:wrap">
            <div style="position:relative">
              <input id="p-search" type="text" placeholder="🔍 ค้นหา platform (ชื่อ หรือ URL)" autocomplete="off"
                     style="width:100%;padding:10px 14px;font-size:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text)" />
              <span id="p-search-clear" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted);display:none;padding:4px 8px;border-radius:6px">×</span>
            </div>
            <select id="p-sort" style="padding:10px 14px;font-size:13.5px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text);min-width:180px;cursor:pointer">
              <option value="mine">🔥 ที่ฉันใช้บ่อย</option>
              <option value="global">🌐 ใช้บ่อยในระบบ</option>
              <option value="az">🔤 A → Z</option>
            </select>
            <select id="p-spotlight" style="padding:10px 14px;font-size:13.5px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text);min-width:200px;cursor:pointer">
              <option value="">🔦 Spotlight: — ไม่เลือก —</option>
            </select>
          </div>
          <div id="p-spotlight-legend" style="display:none;margin-bottom:14px;padding:10px 14px;background:var(--bg-soft);border-radius:10px;font-size:12px;color:var(--text-muted);line-height:1.7">
            <strong style="color:var(--text)" id="p-spotlight-team-name"></strong> ใช้:
            <span style="display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:rgba(16,185,129,.15);color:#15803d;font-weight:600;margin:0 4px">💚 ทีมใช้ + คุณใช้ได้</span>
            <span style="display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:rgba(245,158,11,.15);color:#92400e;font-weight:600;margin:0 4px">💛 ทีมใช้ แต่คุณยังไม่มีสิทธิ์</span>
            <span style="color:var(--text-soft);margin-left:8px">• ที่เหลือ = ทีมไม่ได้ใช้</span>
          </div>

          <div id="p-list">
            <div class="empty">กำลังโหลด…</div>
          </div>
        </div>

        <!-- ============ Skill Marketplace ============ -->
        <div data-plat-panel="skill" style="display:none">
          <div id="skill-mp-root"><div class="empty">กำลังโหลด…</div></div>
        </div>

        <!-- ============ AI Project ============ -->
        <div data-plat-panel="aiproject" style="display:none">
          <div id="aiproj-root"><div class="empty">กำลังโหลด…</div></div>
        </div>

        <!-- ============ Claude RateLimit ============ -->
        <div data-plat-panel="claude-rl" style="display:none">
          <div id="claude-rl-root"><div class="empty">กำลังโหลด…</div></div>
        </div>

        <!-- ============ Credit Card ============ -->
        <div data-plat-panel="creditcard" style="display:none">
          <div id="creditcard-root"><div class="empty">กำลังโหลด…</div></div>
        </div>
      </div>
    </div>
  `;

  // v1.9.120/132/143 — submenu Platform / Skill Marketplace / AI Project (lazy-load)
  let _skillMpLoaded = false;
  let _aiprojLoaded = false;
  let _clrlLoaded = false;
  let _ccLoaded = false;
  function showPlatPanel(panel) {
    document.querySelectorAll('[data-plat-panel]').forEach(p => { p.style.display = (p.dataset.platPanel === panel) ? '' : 'none'; });
    document.querySelectorAll('[data-plat-tab]').forEach(b => b.classList.toggle('active', b.dataset.platTab === panel));
    // v1.9.348 — sync hash ให้ refresh แล้วกลับมา tab เดิม (replaceState — ไม่ trigger hashchange/navigate)
    try { history.replaceState(null, '', panel === 'platform' ? '#/platforms' : '#/platforms/' + panel); } catch (_) {}
    if (panel === 'skill' && !_skillMpLoaded) { _skillMpLoaded = true; renderSkillMarketplace(); }
    if (panel === 'aiproject' && !_aiprojLoaded) { _aiprojLoaded = true; renderAiProjects(); }
    if (panel === 'claude-rl' && !_clrlLoaded) { _clrlLoaded = true; renderClaudeRL(); }
    if (panel === 'creditcard' && !_ccLoaded) { _ccLoaded = true; renderCreditCard(); }
  }
  document.querySelectorAll('[data-plat-tab]').forEach(b => b.addEventListener('click', () => showPlatPanel(b.dataset.platTab)));
  // v1.9.153 — เปิด tab ตาม deep-link (เช่นจาก dashboard)
  if (initialTab && ['platform', 'skill', 'aiproject', 'claude-rl', 'creditcard'].includes(initialTab)) showPlatPanel(initialTab);

  let data;
  try {
    data = await fetchJson('/api/my-platforms');
  } catch (e) {
    $('p-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _platformsData = data;
  const accessible = data.accessible || [];
  const noAccess = data.no_access || [];
  const viewer = data.viewer;

  // Hint
  if (viewer === 'super_admin') {
    $('p-hint').innerHTML = `
      <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px;padding:10px 14px;color:#92400e">
        🔒 <strong>Super admin view</strong> — แสดง platforms ทั้งหมด · ดูในมุม member ให้ login เป็น member ที่ผูก team
      </div>
    `;
  } else {
    $('p-hint').innerHTML = `เว็บที่คุณ <strong>เข้าถึงได้</strong> และ <strong>ขอสิทธิ์</strong> เพิ่มได้`;
  }

  // wire sort dropdown
  $('p-sort').value = _platformSort;
  $('p-sort').addEventListener('change', (e) => {
    _platformSort = e.target.value;
    renderPlatformsList();
  });

  // wire search
  const searchInput = $('p-search');
  searchInput.addEventListener('input', applyPlatformFilter);
  $('p-search-clear').addEventListener('click', () => {
    searchInput.value = ''; applyPlatformFilter(); searchInput.focus();
  });

  // โหลด teams overview (background, ไม่ block UI)
  fetchJson('/api/teams-overview').then(td => {
    _teamsOverview = td.teams || [];
    populateSpotlightDropdown();
  }).catch(() => {});

  // wire spotlight dropdown
  $('p-spotlight').addEventListener('change', (e) => {
    _spotlightTeamId = e.target.value ? parseInt(e.target.value, 10) : null;
    renderPlatformsList();
  });

  renderPlatformsList();
}

function populateSpotlightDropdown() {
  const sel = $('p-spotlight');
  if (!sel || !_teamsOverview) return;
  // เก็บ value ปัจจุบัน
  const cur = _spotlightTeamId;
  sel.innerHTML = '<option value="">🔦 Spotlight: — ไม่เลือก —</option>' +
    _teamsOverview.map(t =>
      `<option value="${t.id}">🏷 ${escapeHtml(t.name)} (${t.site_ids.length} site)</option>`
    ).join('');
  if (cur) sel.value = String(cur);
}

function sortPlatforms(list, mode) {
  const arr = list.slice();
  if (mode === 'az') {
    arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  } else if (mode === 'mine') {
    // มากสุดก่อน — เท่ากันเรียง global, แล้วชื่อ
    arr.sort((a, b) =>
      (b.my_clicks - a.my_clicks) ||
      (b.global_clicks - a.global_clicks) ||
      (a.name || '').localeCompare(b.name || '', 'th')
    );
  } else {  // 'global'
    arr.sort((a, b) =>
      (b.global_clicks - a.global_clicks) ||
      (a.name || '').localeCompare(b.name || '', 'th')
    );
  }
  return arr;
}

function renderPlatformCard(s, opts) {
  // opts: {disabled?: bool, requestPending?: bool, teamUses?: bool, teamName?: string}
  opts = opts || {};
  const url = patternToUrl(s.url_pattern);
  const initial = (s.name || '?').trim().charAt(0).toUpperCase();
  const displayUrl = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const searchKey = (s.name + ' ' + s.url_pattern).toLowerCase();

  const credLabel = s.cred_count > 0
    ? `${s.cred_count} บัญชี`
    : '<span style="color:var(--warning);">ยังไม่มีบัญชี</span>';

  // Click stats badges
  const stats = [];
  if (s.my_clicks > 0) stats.push(`<span style="color:var(--primary);font-weight:600">🔥 ${s.my_clicks} ของฉัน</span>`);
  if (s.global_clicks > 0) stats.push(`<span style="color:var(--text-muted)">🌐 ${s.global_clicks}</span>`);

  const avatarStyle = opts.disabled
    ? 'filter:grayscale(0.85);opacity:.55'
    : '';
  const avatar = s.logo_data
    ? `<div class="platform-avatar" style="background:#fff;padding:5px;overflow:hidden;${avatarStyle}"><img src="${s.logo_data}" alt="${escapeHtml(s.name)}" style="width:100%;height:100%;object-fit:contain;border-radius:7px" /></div>`
    : `<div class="platform-avatar" style="${avatarStyle}">${escapeHtml(initial)}</div>`;

  // Spotlight team badge — มุมขวาบน
  const teamBadge = opts.teamUses
    ? `<div class="p-team-badge" title="${escapeHtml(opts.teamName || '')} ใช้ platform นี้">🏷 ${escapeHtml(opts.teamName || '')}</div>`
    : '';

  const dataAttrs = `data-search="${escapeHtml(searchKey)}" data-team-uses="${opts.teamUses ? '1' : '0'}"`;
  const titleAttr = `title="${escapeHtml(s.name + ' · ' + displayUrl)}"`;

  if (opts.disabled) {
    // No-access card — compact layout
    const requestBtn = opts.requestPending
      ? `<button class="btn" disabled style="font-size:10.5px;padding:3px 8px;background:var(--bg-soft);color:var(--text-muted);cursor:not-allowed;flex-shrink:0" title="รออนุมัติ">⏳ รออนุมัติ</button>`
      : `<button class="btn primary" data-req-id="${s.id}" data-req-name="${escapeHtml(s.name)}" style="font-size:10.5px;padding:3px 8px;flex-shrink:0">🙏 ขอสิทธิ์</button>`;
    return `
      <div class="platform-card platform-card-disabled" ${dataAttrs} ${titleAttr}
           style="background:var(--bg-soft);border:1px dashed var(--border);cursor:default;text-decoration:none;position:relative">
        ${teamBadge}
        ${avatar}
        <div class="platform-card-info">
          <div class="platform-name" style="color:var(--text-muted)">${escapeHtml(s.name)}</div>
          <div class="platform-url">${escapeHtml(displayUrl)}</div>
          <div class="platform-meta" style="color:var(--text-soft)">
            <span>${stats.length ? stats.join(' · ') : credLabel}</span>
            ${requestBtn}
          </div>
        </div>
      </div>
    `;
  }

  // Accessible card — compact layout
  return `
    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="platform-card" ${dataAttrs} ${titleAttr} style="position:relative">
      ${teamBadge}
      ${avatar}
      <div class="platform-card-info">
        <div class="platform-name">${escapeHtml(s.name)}</div>
        <div class="platform-url">${escapeHtml(displayUrl)}</div>
        <div class="platform-meta">
          <span>${stats.length ? stats.join(' · ') : credLabel}</span>
          <span class="open">→</span>
        </div>
      </div>
    </a>
  `;
}

function renderPlatformsList() {
  if (!_platformsData) return;

  // === Spotlight: คำนวณว่า site ไหน team ใช้บ้าง ===
  let spotlightTeam = null;
  let spotlightSiteIds = new Set();
  if (_spotlightTeamId && _teamsOverview) {
    spotlightTeam = _teamsOverview.find(t => t.id === _spotlightTeamId);
    if (spotlightTeam) spotlightSiteIds = new Set(spotlightTeam.site_ids || []);
  }

  // Sort: ถ้า spotlight on → team ใช้ก่อน, ภายในนั้นค่อย sort ตาม mode
  const sortBySpotlight = (list) => {
    if (!spotlightTeam) return sortPlatforms(list, _platformSort);
    const inTeam = sortPlatforms(list.filter(s => spotlightSiteIds.has(s.id)), _platformSort);
    const others = sortPlatforms(list.filter(s => !spotlightSiteIds.has(s.id)), _platformSort);
    return [...inTeam, ...others];
  };
  const accessible = sortBySpotlight(_platformsData.accessible || []);
  const noAccess = sortBySpotlight(_platformsData.no_access || []);

  // Apply spotlight class to root + show legend
  const listEl = $('p-list');
  if (listEl) listEl.classList.toggle('spotlight-on', !!spotlightTeam);
  const legendEl = $('p-spotlight-legend');
  if (legendEl) {
    if (spotlightTeam) {
      legendEl.style.display = '';
      $('p-spotlight-team-name').textContent = `🏷 ${spotlightTeam.name}`;
    } else {
      legendEl.style.display = 'none';
    }
  }

  const cardOpts = (s, baseOpts) => ({
    ...baseOpts,
    teamUses: spotlightSiteIds.has(s.id),
    teamName: spotlightTeam ? spotlightTeam.name : '',
  });

  const totalCount = accessible.length + noAccess.length;
  // count spotlight breakdown
  let cnt = `${accessible.length} เข้าถึงได้${noAccess.length > 0 ? ` · ${noAccess.length} ต้องขอ` : ''}`;
  if (spotlightTeam) {
    const teamUseAccessible = accessible.filter(s => spotlightSiteIds.has(s.id)).length;
    const teamUseNoAccess = noAccess.filter(s => spotlightSiteIds.has(s.id)).length;
    cnt += ` · 🔦 ${teamUseAccessible}+${teamUseNoAccess} (ทีมใช้)`;
  }
  { const pc = $('p-count'); if (pc) pc.textContent = cnt; }   // v1.9.146 — เอา count บนหัวออกแล้ว (กัน null)

  let html = '';
  if (accessible.length > 0) {
    html += `<div class="platform-grid" id="p-grid-yes">`;
    html += accessible.map(s => renderPlatformCard(s, cardOpts(s, { disabled: false }))).join('');
    html += `</div>`;
  } else if (totalCount > 0) {
    html += `<div class="empty" style="margin-bottom:16px">คุณยังไม่ได้รับสิทธิ์เข้าถึง platform ใด — กดขอสิทธิ์ที่ section ด้านล่าง</div>`;
  }

  if (noAccess.length > 0) {
    html += `
      <div style="margin-top:28px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
        <h3 style="margin:0;font-size:14px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em">🔒 Platforms ที่ยังไม่มีสิทธิ์</h3>
        <span style="font-size:12px;color:var(--text-muted)">— กด "🙏 ขอสิทธิ์" → admin จะได้รับแจ้ง</span>
      </div>
      <div class="platform-grid" id="p-grid-no">
        ${noAccess.map(s => renderPlatformCard(s, cardOpts(s, { disabled: true, requestPending: s.request_pending }))).join('')}
      </div>
    `;
  }

  if (totalCount === 0) {
    html = `<div class="empty">ยังไม่มีแพลตฟอร์มในระบบ${currentRole === 'admin' ? ' — เพิ่มได้ที่ <strong>🛠 Config</strong>' : ''}</div>`;
  }

  html += `<div id="p-no-results" class="empty" style="display:none;margin-top:14px">ไม่เจอ platform ที่ตรงกับคำค้น</div>`;
  $('p-list').innerHTML = html;

  // Wire request buttons
  document.querySelectorAll('button[data-req-id]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const siteId = parseInt(btn.dataset.reqId, 10);
      const name = btn.dataset.reqName;
      const note = prompt(`ขอสิทธิ์เข้าถึง "${name}"?\n\nเหตุผล (ไม่บังคับ — admin จะเห็น):`, '');
      if (note === null) return;   // cancelled
      btn.disabled = true;
      btn.textContent = '⏳ กำลังส่ง...';
      try {
        await fetchJson('/api/access-requests', {
          method: 'POST',
          body: JSON.stringify({ site_id: siteId, note: note.trim() || null }),
        });
        btn.textContent = '⏳ รออนุมัติ';
        btn.style.background = 'var(--bg-soft)';
        btn.style.color = 'var(--text-muted)';
        btn.title = 'admin ได้รับแจ้งแล้ว — รอตอบกลับ';
        showSavedToast('✓ ส่งคำขอแล้ว — admin จะตรวจสอบ');
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '🙏 ขอสิทธิ์';
        showSavedToast('❌ ' + err.message, 'error');
      }
    });
  });

  applyPlatformFilter();
}

function applyPlatformFilter() {
  const searchInput = $('p-search');
  if (!searchInput) return;
  const q = searchInput.value.toLowerCase().trim();
  $('p-search-clear').style.display = q ? '' : 'none';
  let shown = 0;
  document.querySelectorAll('.platform-card').forEach(card => {
    const key = card.dataset.search || '';
    const match = !q || key.includes(q);
    card.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  const noResults = $('p-no-results');
  if (noResults) noResults.style.display = (q && shown === 0) ? '' : 'none';
}

// ============== Teams ==============

// v1.9.139 — เก็บ team ที่ถูกยุบกิ่ง (collapse) — persist ข้าม re-render
let _teamCollapsed = new Set();

async function renderTeamsPage(selectedTeamId, mount) {
  mount = mount || $('peoples-detail') || $('main');  // v1.9.123 — render ลง container อื่นได้ (Peoples tab)
  // Fetch all teams
  let data;
  try {
    data = await fetchJson('/api/admin/teams');
  } catch (e) {
    mount.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const teams = data.teams || [];
  // v1.9.139 — map team → parent (สำหรับ logic ยุบ/ขยายกิ่ง)
  const _teamParentOf = new Map(teams.map(t => [t.id, t.parent_team_id]));
  // ตัด collapsed id ที่ไม่ใช่ parent แล้ว (กันค้าง)
  { const valid = new Set(teams.filter(t => teams.some(c => c.parent_team_id === t.id)).map(t => t.id));
    _teamCollapsed.forEach(id => { if (!valid.has(id)) _teamCollapsed.delete(id); }); }
  // ซ่อน/แสดงแถวตามสถานะ collapse ของบรรพบุรุษ + อัปเดตไอคอน +/−
  function applyTeamCollapse() {
    document.querySelectorAll('.teams-row-wrap').forEach(row => {
      const id = parseInt(row.dataset.teamId, 10);
      let hidden = false, pid = _teamParentOf.get(id), seen = new Set();
      while (pid != null && !seen.has(pid)) {
        seen.add(pid);
        if (_teamCollapsed.has(pid)) { hidden = true; break; }
        pid = _teamParentOf.get(pid);
      }
      row.style.display = hidden ? 'none' : '';
    });
    document.querySelectorAll('.teams-toggle').forEach(btn => {
      btn.textContent = _teamCollapsed.has(parseInt(btn.dataset.teamId, 10)) ? '+' : '−';
    });
  }

  // กำหนด tab default — ถ้ามี ID ใน URL ใช้, ไม่งั้นเลือกทีมแรก
  if (selectedTeamId && !teams.find(t => t.id === selectedTeamId)) {
    selectedTeamId = null;   // ID ไม่มีในระบบแล้ว
  }
  if (!selectedTeamId && teams.length > 0) {
    selectedTeamId = teams[0].id;
  }

  // Render 2-column layout: left = team list, right = team detail
  mount.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">👨‍👩‍👧 Teams</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${currentRole === 'admin' ? '<button class="btn" id="add-temp-staff-btn">+ สร้าง Temporary Staff</button>' : ''}
        <button class="btn primary" id="add-team-btn">+ สร้าง Team ใหม่</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      จัดกลุ่ม member เพื่อกำหนดสิทธิ์เข้าถึง platform — site ที่ผูกกับทีมจะ visible เฉพาะคนในทีมเท่านั้น
    </div>

    <div id="teams-layout" style="display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:flex-start">
      <!-- LEFT: team list with search + drag-reorder -->
      <aside id="teams-sidebar" style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:8px;box-shadow:var(--shadow-sm);position:sticky;top:14px;max-height:calc(100vh - 60px);overflow-y:auto">
        ${teams.length === 0
          ? '<div style="padding:18px 12px;color:var(--text-muted);font-size:13px;text-align:center">ยังไม่มี team — กด <strong>+ สร้าง</strong> ด้านบน</div>'
          : `
            <div style="position:relative;margin:4px 4px 8px">
              <input id="teams-search" type="text" placeholder="🔍 ค้นหาทีม..." autocomplete="off"
                     style="width:100%;padding:7px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);font-family:inherit" />
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;font-size:10.5px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;padding:4px 10px 6px">
              <span id="teams-count-label">${teams.length} ทีม</span>
              <span style="color:var(--text-soft);font-weight:400;text-transform:none;letter-spacing:0">⋮⋮ ลากเพื่อจัดลำดับ</span>
            </div>
            <div id="teams-list">
              ${(() => {
                // v1.9.58 — render เป็นต้นไม้: indent ตาม depth + แสดง breadcrumb path ใน search-key
                const treeRoots = buildTeamTree(teams);
                const flat = flattenTeamTreeDFS(treeRoots);
                const byId = new Map(teams.map(x => [x.id, x]));
                return flat.map(({ team: t, depth, hasChildren }) => {
                  const isActive = t.id === selectedTeamId;
                  const path = getTeamFullPath(t, byId);
                  const searchKey = (path + ' ' + (t.description || '')).toLowerCase();
                  const indentPx = 12 + depth * 14;
                  const toggleSlot = hasChildren
                    ? `<span class="teams-toggle" data-team-id="${t.id}" role="button" aria-label="ยุบ/ขยายกิ่ง" title="ยุบ/ขยายกิ่ง" style="display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;border:1px solid var(--border);border-radius:5px;font-size:13px;line-height:1;font-weight:700;color:var(--text-muted);cursor:pointer;flex-shrink:0;user-select:none;background:var(--bg-card)">−</span>`
                    : `<span style="display:inline-block;width:17px;flex-shrink:0"></span>`;
                  return `
                    <div class="teams-row-wrap" data-team-id="${t.id}" data-search="${escapeHtml(searchKey)}" data-depth="${depth}" draggable="true"
                         style="display:flex;align-items:stretch;gap:2px;margin-bottom:3px;border-radius:8px;transition:opacity .12s">
                      <span class="teams-drag-handle" title="ลากเพื่อจัดลำดับ"
                            style="display:flex;align-items:center;padding:0 4px;color:var(--text-soft);cursor:grab;font-size:14px;border-radius:6px;user-select:none">⋮⋮</span>
                      <button class="teams-row" data-team-id="${t.id}"
                              style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:3px;
                                     text-align:left;
                                     padding:10px 12px 10px ${indentPx}px;
                                     background:${isActive ? 'var(--primary-soft)' : 'transparent'};
                                     border:1px solid ${isActive ? 'rgba(37,99,235,.25)' : 'transparent'};
                                     border-left:${depth > 0 ? '2px solid var(--border)' : 'none'};
                                     border-radius:8px;
                                     cursor:pointer;font-family:inherit;
                                     transition:all .12s;
                                     min-width:0">
                        <div style="display:flex;align-items:center;width:100%;gap:6px">
                          ${toggleSlot}
                          <span style="font-weight:${isActive ? '700' : '600'};font-size:13.5px;color:${isActive ? 'var(--primary)' : 'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">${escapeHtml(t.name)}</span>
                        </div>
                        <div style="font-size:11px;color:var(--text-muted);font-weight:500;display:flex;gap:8px;margin-left:23px">
                          <span>👤 ${t.member_count}</span>
                          <span>🌐 ${t.site_count}</span>
                        </div>
                      </button>
                    </div>
                  `;
                }).join('');
              })()}
            </div>
            <div id="teams-no-results" class="empty" style="display:none;padding:14px;font-size:12px;color:var(--text-muted)">ไม่เจอทีมที่ตรงกับคำค้น</div>
          `
        }
      </aside>

      <!-- RIGHT: team detail -->
      <div id="team-panel" style="min-width:0">
        ${selectedTeamId ? skelStack(4) : '<div class="empty">เลือกทีมจากด้านซ้าย</div>'}
      </div>
    </div>
  `;

  $('add-team-btn').addEventListener('click', showAddTeamModal);
  const _tsBtn = $('add-temp-staff-btn');
  if (_tsBtn) _tsBtn.addEventListener('click', showAddTempStaffModal);

  // Wire team row clicks → update URL hash
  document.querySelectorAll('.teams-row[data-team-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.teamId, 10);
      if (id !== selectedTeamId) {
        location.hash = '#/teams/' + id;
      }
    });
    btn.addEventListener('mouseenter', () => {
      if (parseInt(btn.dataset.teamId, 10) !== selectedTeamId) {
        btn.style.background = 'var(--bg-hover)';
      }
    });
    btn.addEventListener('mouseleave', () => {
      if (parseInt(btn.dataset.teamId, 10) !== selectedTeamId) {
        btn.style.background = 'transparent';
      }
    });
  });

  // v1.9.139 — Wire ปุ่ม +/− ยุบ/ขยายกิ่ง (stopPropagation ไม่ให้เด้งเลือกทีม)
  document.querySelectorAll('.teams-toggle').forEach(tg => {
    tg.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = parseInt(tg.dataset.teamId, 10);
      if (_teamCollapsed.has(id)) _teamCollapsed.delete(id); else _teamCollapsed.add(id);
      applyTeamCollapse();
    });
  });

  // === Search filter ===
  const searchInput = $('teams-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      if (!q) {
        // ไม่ค้นหา → คืนค่าการมองเห็นตามสถานะยุบ/ขยายกิ่ง
        applyTeamCollapse();
        const noRes0 = $('teams-no-results'); if (noRes0) noRes0.style.display = 'none';
        const lbl0 = $('teams-count-label'); if (lbl0) lbl0.textContent = `${teams.length} ทีม`;
        return;
      }
      let shown = 0;
      document.querySelectorAll('.teams-row-wrap').forEach(row => {
        const key = row.dataset.search || '';
        const match = key.includes(q);
        row.style.display = match ? '' : 'none';   // ค้นหา → แสดงทุก match (ข้าม collapse)
        if (match) shown++;
      });
      const noRes = $('teams-no-results');
      if (noRes) noRes.style.display = (shown === 0) ? '' : 'none';
      const lbl = $('teams-count-label');
      if (lbl) lbl.textContent = `${shown} / ${teams.length} ทีม`;
    });
  }

  // v1.9.139 — ใช้สถานะ collapse เริ่มต้น (กรณี persist จากก่อนหน้า)
  applyTeamCollapse();

  // === Drag-to-reorder ===
  const listEl = $('teams-list');
  if (listEl) {
    let draggedRow = null;
    listEl.querySelectorAll('.teams-row-wrap').forEach(row => {
      row.addEventListener('dragstart', (e) => {
        draggedRow = row;
        row.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
        // เก็บ id ใน dataTransfer สำหรับ cross-window safety (ไม่ใช้จริงเพราะ same window)
        try { e.dataTransfer.setData('text/plain', row.dataset.teamId); } catch {}
      });
      row.addEventListener('dragend', () => {
        if (draggedRow) draggedRow.style.opacity = '';
        draggedRow = null;
        // เคลียร์ all visual indicators
        listEl.querySelectorAll('.teams-row-wrap').forEach(r => {
          r.style.borderTop = '';
          r.style.borderBottom = '';
        });
      });
      row.addEventListener('dragover', (e) => {
        if (!draggedRow || draggedRow === row) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // visual indicator: highlight แนวบน/ล่างของ row นี้ตามตำแหน่ง mouse
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        listEl.querySelectorAll('.teams-row-wrap').forEach(r => {
          r.style.borderTop = '';
          r.style.borderBottom = '';
        });
        if (above) row.style.borderTop = '2px solid var(--primary)';
        else row.style.borderBottom = '2px solid var(--primary)';
      });
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (!draggedRow || draggedRow === row) return;
        const rect = row.getBoundingClientRect();
        const above = e.clientY < rect.top + rect.height / 2;
        // Reorder DOM
        if (above) row.parentNode.insertBefore(draggedRow, row);
        else row.parentNode.insertBefore(draggedRow, row.nextSibling);
        // เคลียร์ visual
        listEl.querySelectorAll('.teams-row-wrap').forEach(r => {
          r.style.borderTop = '';
          r.style.borderBottom = '';
        });
        // Save to backend
        const newOrder = Array.from(listEl.querySelectorAll('.teams-row-wrap'))
          .map(r => parseInt(r.dataset.teamId, 10));
        try {
          await fetchJson('/api/admin/teams/reorder', {
            method: 'PUT',
            body: JSON.stringify({ team_ids: newOrder }),
          });
        } catch (err) {
          alert('บันทึกลำดับไม่สำเร็จ: ' + err.message);
        }
      });
    });
  }

  // Load selected team detail
  if (selectedTeamId) {
    await loadTeamDetail(selectedTeamId);
  }
}

// v1.9.58 — สร้าง <option> สำหรับ parent picker — มี indent ตาม depth
function buildParentTeamOptions(teams, currentParentId, excludeIds) {
  const tree = buildTeamTree(teams);
  const flat = flattenTeamTreeDFS(tree);
  let html = `<option value="">— ระดับบนสุด (root) —</option>`;
  for (const { team, depth } of flat) {
    if (excludeIds && excludeIds.has(team.id)) continue;
    const indent = '    '.repeat(depth);
    const arrow = depth > 0 ? '↳ ' : '';
    const sel = (currentParentId === team.id) ? ' selected' : '';
    html += `<option value="${team.id}"${sel}>${escapeHtml(indent + arrow + team.name)}</option>`;
  }
  return html;
}
// v1.9.58 — หา IDs ของลูกหลานทั้งหมดของ rootId (รวม rootId ด้วย) — ใช้กัน cycle
function getTeamDescendantIds(teams, rootId) {
  const result = new Set([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const t of teams) {
      if (t.parent_team_id != null && result.has(t.parent_team_id) && !result.has(t.id)) {
        result.add(t.id);
        added = true;
      }
    }
  }
  return result;
}

// v1.9.229 — สร้างพนักงานชั่วคราว (ชื่อ+เบอร์) → member row (is_temp), ผูกอุปกรณ์/แผนกได้, claim เป็นจริงตอน login OTP
async function showAddTempStaffModal() {
  // v1.9.262 — แผนกเลือกจากรายชื่อทีม หรือพิมพ์เองได้ (datalist)
  let _tsTeams = (_teamsCache && _teamsCache.length) ? _teamsCache : [];
  if (!_tsTeams.length) { try { _tsTeams = (await fetchJson('/api/admin/teams')).teams || []; } catch { _tsTeams = []; } }
  const _tsDeptOptions = [...new Set(_tsTeams.map(t => t.name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'th'))
    .map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
  showModal({
    title: '🕓 สร้าง Temporary Staff',
    body: `
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px;line-height:1.6">
        ใส่แค่ <strong>ชื่อ + เบอร์</strong> เพื่อ<strong>ผูกอุปกรณ์ + ระบุแผนกชั่วคราว</strong> ก่อนเจ้าตัวสมัครจริง<br>
        เมื่อเจ้าของเบอร์ login ด้วย OTP สำเร็จ → <strong>ยุบรวมเป็น account จริงให้อัตโนมัติ</strong> (อุปกรณ์/ทีมที่ผูกไว้ติดไปด้วย)
      </div>
      <div class="field">
        <label>ชื่อ-สกุล</label>
        <input id="ts-name" type="text" placeholder="เช่น สมชาย ใจดี" />
      </div>
      <div class="field">
        <label>เบอร์มือถือ — optional</label>
        <input id="ts-phone" type="tel" inputmode="numeric" placeholder="0812345678 (เว้นว่างได้)" />
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">ไม่ใส่ก็ได้ · ถ้าใส่ (เบอร์ที่เจ้าตัวจะใช้ login OTP) เมื่อ login สำเร็จ ระบบจะดึงอุปกรณ์/ทีมที่ผูกไว้ → account จริงให้อัตโนมัติ</div>
      </div>
      <div class="field">
        <label>แผนก (ชั่วคราว) — optional</label>
        <input id="ts-dept" type="text" list="ts-dept-list" autocomplete="off" placeholder="เลือกแผนก หรือพิมพ์เอง เช่น Event ชั่วคราว / Outsource" />
        <datalist id="ts-dept-list">${_tsDeptOptions}</datalist>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">เลือกจากรายชื่อทีมที่มี หรือพิมพ์ชื่อแผนกใหม่ได้</div>
      </div>
    `,
    onSubmit: async () => {
      const name = $('ts-name').value.trim();
      const phone = $('ts-phone').value.trim();
      if (!name) throw new Error('กรอกชื่อ');
      // v1.9.263 — เบอร์ optional · ถ้าใส่ต้องครบ
      if (phone && phone.replace(/\D/g, '').length < 9) throw new Error('เบอร์ไม่ครบ (หรือเว้นว่างไว้ก็ได้)');
      const r = await fetchJson('/api/admin/temp-staff', {
        method: 'POST',
        body: JSON.stringify({ name, phone: phone || null, department: $('ts-dept').value.trim() || null }),
      });
      _hwMembersCache = []; _membersCache = [];   // ให้ owner picker / members list โหลดใหม่ (เห็น temp staff)
      showSavedToast('✓ สร้าง Temporary Staff: ' + name + (r.phone ? ' (' + r.phone + ')' : ' (ไม่มีเบอร์)'));
    },
  });
}

async function showAddTeamModal() {
  // โหลด teams ปัจจุบันเพื่อสร้าง parent picker
  let teams = [];
  try { teams = (await fetchJson('/api/admin/teams')).teams || []; } catch { /* ignore */ }
  const parentOptionsHtml = buildParentTeamOptions(teams, null, null);
  showModal({
    title: 'สร้าง Team ใหม่',
    body: `
      <div class="field">
        <label>ชื่อทีม</label>
        <input id="m-name" type="text" placeholder="เช่น Marketing, Sales" />
      </div>
      <div class="field">
        <label>คำอธิบาย (optional)</label>
        <input id="m-desc" type="text" placeholder="ทีมเกี่ยวกับ..." />
      </div>
      <div class="field">
        <label>ทีมแม่ (optional) — จัดเป็นทีมย่อยภายใต้</label>
        <select id="m-parent" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">${parentOptionsHtml}</select>
      </div>
    `,
    onSubmit: async () => {
      const name = $('m-name').value.trim();
      if (!name) throw new Error('กรอกชื่อทีม');
      const parentVal = $('m-parent').value;
      const r = await fetchJson('/api/admin/teams', {
        method: 'POST',
        body: JSON.stringify({
          name,
          description: $('m-desc').value.trim() || null,
          parent_team_id: parentVal ? parseInt(parentVal, 10) : null,
        }),
      });
      // เด้งไป tab ของ team ใหม่ที่เพิ่งสร้าง
      if (r && r.id) {
        location.hash = '#/teams/' + r.id;
      } else {
        await renderTeamsPage();
      }
    },
  });
}

// Render team detail content into #team-panel (called by tab click / page load)
let _currentTeam = null;
let _allMembers = null;   // cache list of all members for "add to team" picker
let _allSites = null;     // cache list of all sites
// v1.9.57 — sort state สำหรับ Team detail member list
let _teamMembersSort = 'default';   // 'default' | 'name' | 'pc-age'
let _lastTeamMembersData = null;    // raw members array (เก็บไว้ re-render เมื่อ sort เปลี่ยน)
let _lastTeamMembersTeamId = null;

// v1.9.58 — Teams hierarchy helpers
function buildTeamTree(teams) {
  const byId = new Map();
  teams.forEach(t => byId.set(t.id, { ...t, children: [] }));
  const roots = [];
  byId.forEach(t => {
    const pid = t.parent_team_id;
    if (pid != null && byId.has(pid)) byId.get(pid).children.push(t);
    else roots.push(t);
  });
  const sortLvl = (arr) => {
    arr.sort((a, b) =>
      ((a.display_order ?? 0) - (b.display_order ?? 0))
      || ((a.name || '').localeCompare(b.name || '', 'th'))
    );
    arr.forEach(n => sortLvl(n.children));
  };
  sortLvl(roots);
  return roots;
}
function flattenTeamTreeDFS(roots, depth = 0, out = []) {
  for (const node of roots) {
    out.push({ team: node, depth, hasChildren: node.children.length > 0 });
    flattenTeamTreeDFS(node.children, depth + 1, out);
  }
  return out;
}
// แสดง path "Parent > Sub > Sub-sub" เพื่อใช้ใน search/filter ของ sidebar
function getTeamFullPath(team, byId) {
  const path = [];
  let cur = team;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur.name || '');
    cur = (cur.parent_team_id != null) ? byId.get(cur.parent_team_id) : null;
  }
  return path.join(' › ');
}

async function loadTeamDetail(teamId) {
  const panel = $('team-panel');
  if (!panel) return;
  let data;
  try {
    data = await fetchJson('/api/admin/teams/' + teamId);
  } catch (e) {
    panel.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _currentTeam = data.team;

  // Update count badge บน sidebar row ของ team นี้ — ให้ตัวเลขทันสมัยหลังเพิ่ม/ลบ
  const rowBtn = document.querySelector(`.teams-row[data-team-id="${teamId}"]`);
  if (rowBtn) {
    const counter = rowBtn.querySelector('div:last-child');
    if (counter) {
      counter.innerHTML = `<span>👤 ${data.members.length}</span><span>🌐 ${data.sites.length}</span>`;
    }
  }

  // v1.9.58 — breadcrumb (parent path) + sub_teams ที่ backend ส่งมา
  const parentPath = data.parent_path || [];
  const subTeams = data.sub_teams || [];
  const breadcrumbHtml = parentPath.length === 0 ? '' : `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;font-size:11.5px;color:var(--text-muted)">
      ${parentPath.map((p, i) => `
        <a href="#/teams/${p.id}" style="color:var(--primary);text-decoration:none;font-weight:600">${escapeHtml(p.name)}</a>
        <span style="color:var(--text-soft)">›</span>
      `).join('')}
      <span style="color:var(--text-soft);font-weight:500">${escapeHtml(data.team.name)}</span>
    </div>
  `;
  const subTeamsHtml = subTeams.length === 0 ? '' : `
    <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border)">
      <div style="font-size:11px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">📁 ทีมย่อย (${subTeams.length})</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${subTeams.map(s => `
          <a href="#/teams/${s.id}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:8px;font-size:12px;font-weight:600;background:rgba(37,99,235,.08);color:var(--primary);border:1px solid rgba(37,99,235,.2);text-decoration:none;white-space:nowrap" title="คลิกเพื่อเปิดทีมย่อย">
            👥 ${escapeHtml(s.name)}
            <span style="color:var(--text-muted);font-weight:500;font-size:11px">${s.member_count} · ${s.site_count}</span>
          </a>
        `).join('')}
      </div>
    </div>
  `;
  // Render team header + sub-tab structure (Members | Site Access) — เหมือนเดิมแต่ inline
  panel.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-top-left-radius:0;border-top-right-radius:12px;border-bottom-left-radius:12px;border-bottom-right-radius:12px;padding:18px 20px;margin-bottom:14px">
      ${breadcrumbHtml}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 4px;font-size:18px;font-weight:700">${escapeHtml(data.team.name)}</h3>
          <div style="font-size:13px;color:var(--text-muted)">
            ${data.team.description ? escapeHtml(data.team.description) : '<span style="font-style:italic">ไม่มีคำอธิบาย</span>'}
          </div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0">
          <button class="btn" id="edit-team-btn" style="font-size:12.5px;padding:6px 12px">✏️ แก้ไข</button>
          <button class="btn danger" id="delete-team-btn" style="font-size:12.5px;padding:6px 12px">🗑 ลบ</button>
        </div>
      </div>
      ${subTeamsHtml}
    </div>

    <div id="team-tabs" style="display:flex;gap:6px;margin:0 0 14px;border-bottom:1px solid var(--border);flex-wrap:wrap">
      <button class="team-tab active" data-tab="members" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--primary);font-weight:600;cursor:pointer;border-bottom:2px solid var(--primary)">👥 Members</button>
      <button class="team-tab" data-tab="sites" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--text-muted);cursor:pointer">🌐 Site Access</button>
      <button class="team-tab" data-tab="unassigned" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--text-muted);cursor:pointer">📦 คอมส่วนกลาง ${(data.unassigned_pcs || []).length > 0 ? `<span style="display:inline-flex;align-items:center;margin-left:4px;background:rgba(245,158,11,.15);color:#92400e;font-size:11px;font-weight:700;padding:1px 8px;border-radius:999px">${(data.unassigned_pcs || []).length}</span>` : ''}</button>
    </div>
    <div id="tab-members" class="team-tab-pane"></div>
    <div id="tab-sites" class="team-tab-pane" style="display:none"></div>
    <div id="tab-unassigned" class="team-tab-pane" style="display:none"></div>
  `;

  document.querySelectorAll('#team-tabs .team-tab').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#team-tabs .team-tab').forEach(x => {
        x.classList.toggle('active', x === b);
        x.style.color = x === b ? 'var(--primary)' : 'var(--text-muted)';
        x.style.fontWeight = x === b ? '600' : '500';
        x.style.borderBottom = x === b ? '2px solid var(--primary)' : '';
      });
      document.querySelectorAll('.team-tab-pane').forEach(p => p.style.display = 'none');
      const target = b.dataset.tab;
      document.getElementById('tab-' + target).style.display = '';
    });
  });

  $('edit-team-btn').addEventListener('click', () => {
    if (_currentTeam) showEditTeamModal(_currentTeam, teamId);
  });
  $('delete-team-btn').addEventListener('click', async () => {
    if (!confirm('ลบทีมนี้? (member ที่อยู่ในทีมจะหลุด, site access ที่ผูกไว้จะถูกถอน)')) return;
    await fetchJson('/api/admin/teams/' + teamId, { method: 'DELETE' });
    location.hash = '#/teams';
  });

  renderTeamMembers(teamId, data.members);
  renderTeamSites(teamId, data.sites);
  renderTeamUnassignedPcs(teamId, data.unassigned_pcs || []);
}

// v1.9.67 — Tab: คอมส่วนกลาง (unassigned PCs ใน subtree ของทีมนี้)
function renderTeamUnassignedPcs(teamId, pcs) {
  const el = $('tab-unassigned');
  if (!el) return;
  if (pcs.length === 0) {
    el.innerHTML = `
      <div class="empty" style="padding:24px;text-align:center;line-height:1.6">
        <div style="font-size:48px;margin-bottom:6px">📭</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px">ยังไม่มีคอมพิวเตอร์ส่วนกลางสำหรับทีมนี้</div>
        <div style="font-size:12.5px;color:var(--text-muted)">
          PC ที่ยังไม่มี owner จะแสดงที่นี่ — ระบุ "ทีม/แผนกที่สังกัด" + "ตำแหน่งเก็บ" ในหน้า edit PC
        </div>
      </div>
    `;
    return;
  }
  // sort: by team name → by name
  const sorted = [...pcs].sort((a, b) => {
    const tn = (a.unassigned_team_name || '').localeCompare(b.unassigned_team_name || '', 'th');
    if (tn !== 0) return tn;
    return (a.name || '').localeCompare(b.name || '', 'th');
  });

  // group by unassigned_team_name
  const groups = new Map();
  sorted.forEach(pc => {
    const k = pc.unassigned_team_name || '(ไม่ระบุทีม)';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(pc);
  });

  const html = `
    <div class="hint" style="margin-bottom:12px;color:var(--text-muted);font-size:12.5px">
      📦 รายการ PC ของทีม + ทีมย่อยทั้งหมดที่ <strong>ไม่มี owner</strong> (เก็บเป็นคอมส่วนกลาง/stock) — รวม ${pcs.length} เครื่อง
    </div>
    ${Array.from(groups.entries()).map(([teamName, list]) => `
      <div style="margin-bottom:14px">
        <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;display:flex;align-items:center;gap:8px">
          🏢 ${escapeHtml(teamName)}
          <span style="background:var(--bg-soft);color:var(--text-muted);font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600">${list.length}</span>
        </div>
        ${list.map(pc => renderTeamUnassignedPcCard(pc)).join('')}
      </div>
    `).join('')}
  `;
  el.innerHTML = html;

  // Wire click → detail modal
  el.querySelectorAll('button[data-tu-pc-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pcId = parseInt(btn.dataset.tuPcId, 10);
      const pc = pcs.find(x => x.id === pcId);
      if (pc) { await _ensureHwCaches(); showHardwareDetail(pc, () => loadTeamDetail(teamId)); }
    });
  });
}

function renderTeamUnassignedPcCard(pc) {
  const tile = renderMyDevicePurchaseTile(pc.purchased_at);
  const ageStr = calcHwAgeStr(pc.purchased_at);
  const specs = [];
  if (pc.cpu) specs.push(`🔧 ${escapeHtml(pc.cpu)}`);
  if (pc.ram) specs.push(`🧠 ${escapeHtml(pc.ram)}`);
  if (pc.storage) specs.push(`💾 ${escapeHtml(pc.storage)}`);
  if (pc.os) specs.push(`💿 ${escapeHtml(pc.os)}${pc.os_version ? ' ' + escapeHtml(pc.os_version) : ''}`);
  const statusBadge = hwStatusBadge(pc.status, { size: 'sm' });
  const headLine = pc.model
    ? `${escapeHtml(pc.name)} <span style="color:var(--text-muted);font-weight:500;font-size:12px">— ${escapeHtml(pc.model)}</span>`
    : escapeHtml(pc.name);
  const photoBlock = pc.photo_data
    ? `<img src="${pc.photo_data}" alt="" style="width:64px;height:48px;object-fit:cover;border-radius:5px;border:1px solid var(--border);flex-shrink:0;display:block" />`
    : `<div style="width:64px;height:48px;border-radius:5px;border:1px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px">📦</div>`;
  const storageChip = pc.storage_location
    ? `<div style="display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:600;background:rgba(99,102,241,.12);color:#3730a3;border:1px solid rgba(99,102,241,.25)">📍 ${escapeHtml(pc.storage_location)}</div>`
    : `<span style="font-size:11px;color:var(--critical);font-style:italic">⚠ ยังไม่ระบุที่เก็บ</span>`;

  return `
    <button type="button" data-tu-pc-id="${pc.id}" title="คลิกดูรายละเอียด + แก้ไข"
       style="display:flex;gap:10px;align-items:flex-start;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:9px 11px;margin-bottom:6px;width:100%;text-align:left;font-family:inherit;cursor:pointer;transition:background .12s,border-color .12s"
       onmouseenter="this.style.background='var(--bg-card)';this.style.borderColor='var(--primary)'"
       onmouseleave="this.style.background='var(--bg-soft)';this.style.borderColor='var(--border)'">
      ${photoBlock}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
        ${renderHwAssetLine(pc.asset_number, { compact: true })}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:13px;color:var(--text)">💻 ${headLine}</span>
          ${statusBadge}
          <span style="display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:700;background:rgba(245,158,11,.10);color:#92400e">🔓 ไม่ระบุผู้ดูแล</span>
          <span style="font-size:10.5px;color:var(--primary);font-weight:600">📖 รายละเอียด</span>
        </div>
        ${specs.length ? `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">${specs.join(' · ')}</div>` : ''}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:2px">
          ${storageChip}
          ${ageStr ? `<span style="font-size:11px;color:var(--accent);font-weight:600">⏱ ${escapeHtml(ageStr)}</span>` : ''}
        </div>
      </div>
      ${tile}
    </button>
  `;
}

// v1.9.57 — sort: default = ตามที่ backend ส่งมา (added_at DESC), name = ชื่อ A-Z, pc-age = อายุคอม PC เก่าสุดของ member นั้น
function sortTeamMembers(members, key) {
  if (key === 'name') {
    return [...members].sort((a, b) => {
      const an = a.display_name || a.email || a.phone || '';
      const bn = b.display_name || b.email || b.phone || '';
      return an.localeCompare(bn, 'th');
    });
  }
  if (key === 'pc-age') {
    const oldestPcMonths = (m) => {
      const pcs = m.pcs || [];
      if (pcs.length === 0) return -1;
      let max = 0;
      for (const pc of pcs) {
        if (!pc.purchased_at) continue;
        const mt = /^(\d{4})-(\d{2})/.exec(String(pc.purchased_at));
        if (!mt) continue;
        const y = parseInt(mt[1], 10);
        const mo = parseInt(mt[2], 10);
        if (mo < 1 || mo > 12) continue;
        const now = new Date();
        const months = (now.getFullYear() - y) * 12 + (now.getMonth() - (mo - 1));
        if (months > max) max = months;
      }
      return max;
    };
    return [...members].sort((a, b) => {
      const aa = oldestPcMonths(a);
      const bb = oldestPcMonths(b);
      // ทั้งคู่ไม่มี PC → sort by name
      if (aa === -1 && bb === -1) {
        const an = a.display_name || a.email || a.phone || '';
        const bn = b.display_name || b.email || b.phone || '';
        return an.localeCompare(bn, 'th');
      }
      if (aa === -1) return 1;   // ไม่มี PC → ปลายแถว
      if (bb === -1) return -1;
      return bb - aa;             // อายุมาก (เก่า) → ขึ้นก่อน
    });
  }
  return members;
}

// v1.9.263 — แผง slide-out รายชื่อ Alumni (อดีตพนักงาน) — เรียงตามวันสุดท้ายล่าสุด · คลิกดูโปรไฟล์
function _showTeamAlumniPanel(list) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  const rowHtml = (m) => {
    const display = m.display_name || m.email || m.phone || 'ไม่ระบุชื่อ';
    const initial = ((display || '?').trim().charAt(0) || '?').toUpperCase();
    const av = m.avatar_data
      ? `<img src="${m.avatar_data}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:16px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
    const lwd = m.last_working_day ? fmtDateThai(m.last_working_day) : '—';
    return `<div class="hw-card" data-alum-id="${m.id}" title="คลิกดูข้อมูลส่วนบุคคล" style="display:flex;align-items:center;gap:11px;border:1px solid var(--border);border-radius:11px;padding:9px 12px;margin-bottom:7px;cursor:pointer">
      ${av}
      <div style="flex:1;min-width:0">
        <div style="font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(display)}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">📅 วันทำงานวันสุดท้าย: ${escapeHtml(lwd)}</div>
      </div>
      <span style="font-size:18px;color:var(--text-muted);flex-shrink:0">›</span>
    </div>`;
  };
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:420px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body" style="padding:4px 24px 28px">
        <div style="font-size:18px;font-weight:800;margin:6px 0 4px">🎓 Alumni (${list.length})</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">อดีตพนักงาน · เรียงจากวันทำงานวันสุดท้ายล่าสุด · คลิกเพื่อดูรายละเอียด</div>
        ${list.length ? list.map(rowHtml).join('') : '<div class="empty">— ไม่มี Alumni —</div>'}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 260); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
  wrap.querySelectorAll('[data-alum-id]').forEach(el => el.addEventListener('click', () => {
    const id = parseInt(el.dataset.alumId, 10);
    const mem = list.find(x => x.id === id);
    if (mem) _pcdOwnerPanel(id, () => loadTeamDetail(_lastTeamMembersTeamId), mem, mem.pcs || []);
  }));
}

function renderTeamMembers(teamId, members) {
  // v1.9.57 — เก็บ state สำหรับ re-sort
  _lastTeamMembersTeamId = teamId;
  _lastTeamMembersData = members;
  // v1.9.263 — แยก Alumni (อดีตพนักงาน) ออกจากรายชื่อหลัก
  const activeMembers = (members || []).filter(m => !m.is_alumni);
  const alumniMembers = (members || []).filter(m => m.is_alumni)
    .sort((a, b) => (b.last_working_day || '').localeCompare(a.last_working_day || ''));
  const sortedMembers = sortTeamMembers(activeMembers, _teamMembersSort);
  const sortSelectStyle = 'padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);font-family:inherit';
  const html = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="card-sub">${activeMembers.length} member</span>
        <select id="tm-sort" title="เรียงรายชื่อ" style="${sortSelectStyle}">
          <option value="default"${_teamMembersSort === 'default' ? ' selected' : ''}>🕒 วันที่เพิ่ม (ล่าสุด)</option>
          <option value="name"${_teamMembersSort === 'name' ? ' selected' : ''}>🔤 ชื่อ (A-Z)</option>
          <option value="pc-age"${_teamMembersSort === 'pc-age' ? ' selected' : ''}>⏱ อายุคอมฯ (เก่าสุดก่อน)</option>
        </select>
        ${alumniMembers.length ? `<button type="button" id="tm-alumni-btn" title="ดูอดีตพนักงาน" style="font-size:11.5px;padding:5px 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-family:inherit;font-weight:600">🎓 Alumni (${alumniMembers.length})</button>` : ''}
      </div>
      <button class="btn primary" id="add-member-btn" style="font-size:12.5px;padding:6px 12px">+ เพิ่ม Member</button>
    </div>
    ${sortedMembers.length === 0
      ? '<div class="empty">ยังไม่มี member ในทีม</div>'
      : sortedMembers.map(m => {
          const display = m.display_name || m.email || m.phone;
          // v1.9.56 — avatar (รูปจริง หรือวงกลม initial)
          const initial = ((display || '?').trim().charAt(0) || '?').toUpperCase();
          const avatarHtml = m.avatar_data
            ? `<img src="${m.avatar_data}" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;border:1px solid var(--border);flex-shrink:0" />`
            : `<div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:18px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
          // v1.9.59 — "จากทีมย่อย" สำหรับสมาชิกที่ไม่ได้อยู่ทีมนี้โดยตรง (มาจาก descendants)
          const subTeamNames = m.sub_team_names || [];
          const isIndirect = (m.direct === false) && subTeamNames.length > 0;
          const fromSubteamChip = isIndirect ? `
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
              <span style="font-size:11px;color:var(--text-muted);font-weight:500">📁 จากทีมย่อย:</span>
              ${subTeamNames.map(n => `
                <span style="display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.10);color:#92400e;border:1px solid rgba(245,158,11,.30);white-space:nowrap">📁 ${escapeHtml(n)}</span>
              `).join('')}
            </div>
          ` : '';
          // v1.14 — extra direct grants (sites ที่ member มีสิทธิ์โดยตรง แต่ team ไม่ได้ผูกไว้)
          const extras = m.extra_sites || [];
          const extraCapsules = extras.length === 0 ? '' : `
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:5px;align-items:center">
              <span style="font-size:11px;color:var(--text-muted);font-weight:500">นอกเหนือจากทีม:</span>
              ${extras.map(es => `
                <span class="extra-cap" data-mid="${m.id}" data-sid="${es.id}" data-sname="${escapeHtml(es.name)}"
                      style="display:inline-flex;align-items:center;gap:5px;padding:2px 4px 2px 9px;border-radius:999px;font-size:11px;font-weight:500;background:rgba(124,58,237,.10);color:var(--accent);border:1px solid rgba(124,58,237,.20)">
                  🔵 ${escapeHtml(es.name)}
                  <button class="extra-cap-x" data-mid="${m.id}" data-sid="${es.id}" data-sname="${escapeHtml(es.name)}"
                          title="ลบ direct grant ของ ${escapeHtml(es.name)}"
                          style="border:none;background:rgba(220,38,38,.10);color:var(--critical);width:16px;height:16px;border-radius:999px;cursor:pointer;font-size:10px;line-height:1;padding:0;display:inline-flex;align-items:center;justify-content:center">×</button>
                </span>
              `).join('')}
            </div>
          `;
          // v1.9.54 — team chips: ทีมอื่น ๆ ที่ member นี้สังกัดอยู่ (ยกเว้นทีมปัจจุบัน)
          const otherTeams = (m.teams || []).filter(t => t.id !== teamId);
          const teamChips = otherTeams.length === 0 ? '' : `
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;align-items:center">
              <span style="font-size:11px;color:var(--text-muted);font-weight:500">อยู่ทีม:</span>
              ${otherTeams.map(t => `
                <span style="display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(37,99,235,.10);color:var(--primary);border:1px solid rgba(37,99,235,.20);white-space:nowrap" title="${escapeHtml(t.name)}">👥 ${escapeHtml(t.name)}</span>
              `).join('')}
            </div>
          `;
          // v1.9.55 — PC spec: สำหรับ admin ใช้ตัดสินใจเรื่องอุปกรณ์ในอนาคต (เช่น "ของคนนี้เก่าแล้วต้องเปลี่ยน")
          const pcs = m.pcs || [];
          const pcSection = pcs.length === 0 ? '' :
            `<div style="margin-top:8px">${pcs.map(pc => renderTeamMemberPcCard(pc)).join('')}</div>`;
          // v1.9.59 — ปุ่ม "ลบออก" เฉพาะสมาชิกตรง (direct=true); สมาชิก indirect แสดง label แทน
          const removeBtnOrLabel = (m.direct !== false)
            ? `<button class="btn danger" data-rm="${m.id}" style="font-size:12.5px;padding:6px 12px;flex-shrink:0">ลบออก</button>`
            : `<span style="font-size:11px;color:var(--text-muted);font-style:italic;flex-shrink:0;align-self:flex-start;padding:7px 0;text-align:right;line-height:1.4">— จากทีมย่อย<br/>(จัดการที่ทีมต้นทาง) —</span>`;
          return `
            <div class="card" style="display:flex;align-items:flex-start;gap:12px${isIndirect ? ';background:rgba(245,158,11,.04)' : ''}">
              ${avatarHtml}
              <div style="flex:1;min-width:0">
                <div class="card-title" data-mprofile="${m.id}" style="cursor:pointer;display:inline-block" title="คลิกดูข้อมูลส่วนบุคคล" onmouseenter="this.style.color='var(--primary)'" onmouseleave="this.style.color=''">${escapeHtml(display)} <span style="font-size:11px;color:var(--text-muted);font-weight:400">›</span></div>
                <div class="card-sub">${escapeHtml(m.phone)}${m.email ? ' · ' + escapeHtml(m.email) : ''}${m.enabled === 0 ? ' · <span style="color:var(--critical)">⛔ ระงับ</span>' : ''}</div>
                ${fromSubteamChip}
                ${teamChips}
                ${extraCapsules}
                ${pcSection}
                ${m.uses_own_computer ? `<div style="margin-top:8px;display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:9px;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.25);font-size:12px;color:#7c3aed;font-weight:600">🙋 ใช้คอมพิวเตอร์ของตนเอง${m.own_computer_info ? `<span style="color:var(--text-muted);font-weight:400">· ${escapeHtml(m.own_computer_info)}</span>` : ''}</div>` : ''}
                ${(!m.is_alumni && m.replaces_member_id && m.replaces_member_label) ? `
                  <div style="margin-top:8px;margin-left:24px;display:flex;align-items:center;gap:8px;padding:6px 11px;border-left:2px solid rgba(37,99,235,.35);background:rgba(37,99,235,.05);border-radius:0 8px 8px 0;font-size:12px">
                    <span style="color:var(--primary);font-weight:700">↳ 🔄 มาแทน</span>
                    ${m.replaces_member_avatar
                      ? `<img src="${m.replaces_member_avatar}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
                      : `<div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:11px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((m.replaces_member_label || '?').trim().charAt(0).toUpperCase())}</div>`}
                    <span style="color:var(--text);font-weight:600">${escapeHtml(m.replaces_member_label)}</span>
                    ${m.replaces_last_working_day ? `<span style="color:var(--text-muted);font-size:11px">· ${escapeHtml(fmtDateThai(m.replaces_last_working_day))}</span>` : ''}
                    <span style="font-size:10.5px;color:#92400e;background:rgba(245,158,11,.12);padding:1px 8px;border-radius:999px;font-weight:600">🎓 Alumni</span>
                  </div>
                ` : ''}
              </div>
              ${removeBtnOrLabel}
            </div>
          `;
        }).join('')}
  `;
  $('tab-members').innerHTML = html;

  // v1.9.57 — sort dropdown → re-render ด้วย data เดิม
  const sortSel = $('tm-sort');
  if (sortSel) {
    sortSel.addEventListener('change', (e) => {
      _teamMembersSort = e.target.value;
      if (_lastTeamMembersData && _lastTeamMembersTeamId) {
        renderTeamMembers(_lastTeamMembersTeamId, _lastTeamMembersData);
      }
    });
  }

  // v1.9.62 — คลิก PC card → เปิด detail modal (ภาพ + spec + ปุ่ม Edit)
  document.querySelectorAll('#tab-members button[data-tm-pc-id]').forEach(b => {
    b.addEventListener('click', async () => {
      const pcId = parseInt(b.dataset.tmPcId, 10);
      for (const m of (_lastTeamMembersData || [])) {
        const pc = (m.pcs || []).find(p => p.id === pcId);
        if (pc) {
          await _ensureHwCaches();
          showHardwareDetail(pc, () => loadTeamDetail(_lastTeamMembersTeamId));
          return;
        }
      }
    });
  });

  // v1.9.260 — คลิกชื่อ member → slide-in ข้อมูลส่วนบุคคล (เหมือนหน้า Members)
  document.querySelectorAll('#tab-members [data-mprofile]').forEach(el => el.addEventListener('click', () => {
    const id = parseInt(el.dataset.mprofile, 10);
    const mem = (_lastTeamMembersData || []).find(x => x.id === id);
    if (mem) _pcdOwnerPanel(id, () => loadTeamDetail(_lastTeamMembersTeamId), mem, mem.pcs || []);
  }));
  // v1.9.263 — ปุ่ม Alumni → slide-out รายชื่ออดีตพนักงาน
  const _alumBtn = $('tm-alumni-btn');
  if (_alumBtn) _alumBtn.addEventListener('click', () => _showTeamAlumniPanel(alumniMembers));

  $('add-member-btn').addEventListener('click', () => showAddMemberToTeamModal(teamId, members));
  document.querySelectorAll('#tab-members button[data-rm]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('ลบ member ออกจากทีม?')) return;
      await fetchJson(`/api/admin/teams/${teamId}/members/${b.dataset.rm}`, { method: 'DELETE' });
      await loadTeamDetail(teamId);
    });
  });
  // x button on extra-cap → confirm + revoke direct grant
  document.querySelectorAll('#tab-members .extra-cap-x').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mid = parseInt(b.dataset.mid, 10);
      const sid = parseInt(b.dataset.sid, 10);
      const sname = b.dataset.sname;
      if (!confirm(`ลบสิทธิ์ direct grant ของ "${sname}" สำหรับ member นี้?`)) return;
      try {
        await fetchJson(`/api/admin/members/${mid}/site-direct-access/${sid}`, {
          method: 'PUT',
          body: JSON.stringify({ grant: false }),
        });
        showSavedToast('✓ ลบสิทธิ์แล้ว');
        await loadTeamDetail(teamId);
      } catch (err) {
        showSavedToast('❌ ' + err.message, 'error');
      }
    });
  });
}

async function showAddMemberToTeamModal(teamId, currentMembers) {
  // refresh members ทุกครั้ง — กัน stale cache (member ที่เพิ่งเพิ่มจะไม่ขาด)
  try { _allMembers = (await fetchJson('/api/admin/members')).members; } catch { _allMembers = _allMembers || []; }
  const inIds = new Set(currentMembers.map(m => m.id));
  const candidates = _allMembers.filter(m => !inIds.has(m.id));
  if (candidates.length === 0) {
    alert('ไม่มี member เพิ่มเติม — สมาชิกทั้งหมดอยู่ในทีมแล้ว');
    return;
  }

  let selectedId = null;
  let searchQ = '';

  showModal({
    title: 'เพิ่ม Member เข้าทีม',
    size: 'wide',
    body: `
      <div class="field">
        <label>ค้นหาแล้วเลือก member</label>
        <input id="atm-search" type="text" placeholder="🔍 ค้นหาชื่อ / email / เบอร์..." autocomplete="off"
          style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box" />
        <div id="atm-count" style="font-size:11.5px;color:var(--text-muted);margin-top:6px">ทั้งหมด ${candidates.length} คน</div>
        <div id="atm-list" style="margin-top:8px;max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);padding:6px;display:flex;flex-direction:column;gap:2px"></div>
        <input type="hidden" id="atm-selected-id" value="" />
      </div>
    `,
    onSubmit: async () => {
      const id = parseInt($('atm-selected-id').value, 10);
      if (!id) throw new Error('กรุณาเลือก member ที่ต้องการเพิ่ม');
      await fetchJson(`/api/admin/teams/${teamId}/members`, {
        method: 'POST', body: JSON.stringify({ member_id: id }),
      });
      await loadTeamDetail(teamId);
    },
  });

  const refresh = () => {
    const listEl = $('atm-list');
    const countEl = $('atm-count');
    if (!listEl) return;
    const ql = searchQ.trim().toLowerCase();
    const filtered = candidates.filter(m => {
      if (!ql) return true;
      return (m.display_name || '').toLowerCase().includes(ql)
          || (m.email || '').toLowerCase().includes(ql)
          || (m.phone || '').toLowerCase().includes(ql);
    });
    if (countEl) {
      countEl.textContent = ql
        ? `แสดง ${filtered.length} / ${candidates.length} คน`
        : `ทั้งหมด ${candidates.length} คน`;
    }
    if (filtered.length === 0) {
      listEl.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12.5px">ไม่พบ member ที่ตรง "${escapeHtml(searchQ)}"</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(m => {
      const isSel = m.id === selectedId;
      return `
        <button type="button" data-mid="${m.id}" style="cursor:pointer;padding:7px 9px;border-radius:6px;display:flex;align-items:flex-start;gap:10px;background:${isSel ? 'rgba(37,99,235,.10)' : 'transparent'};border:1px solid ${isSel ? 'var(--primary)' : 'transparent'};font-family:inherit;text-align:left;width:100%;box-sizing:border-box;transition:background .12s">
          ${renderHwMemberRow(m, false, { showTeams: true })}
          ${isSel ? '<span style="color:var(--primary);font-weight:700;font-size:18px;flex-shrink:0;line-height:1;margin-top:6px">✓</span>' : ''}
        </button>
      `;
    }).join('');
    listEl.querySelectorAll('button[data-mid]').forEach(btn => {
      const mid = parseInt(btn.dataset.mid, 10);
      btn.addEventListener('mouseenter', () => { if (mid !== selectedId) btn.style.background = 'var(--bg-soft)'; });
      btn.addEventListener('mouseleave', () => { if (mid !== selectedId) btn.style.background = 'transparent'; });
      btn.addEventListener('click', () => {
        selectedId = mid;
        const sel = $('atm-selected-id');
        if (sel) sel.value = String(mid);
        refresh();
      });
      // ดับเบิ้ลคลิก = บันทึก (shortcut UX)
      btn.addEventListener('dblclick', () => {
        selectedId = mid;
        const sel = $('atm-selected-id');
        if (sel) sel.value = String(mid);
        const okBtn = document.querySelector('.modal-bg .modal #m-ok');
        if (okBtn) okBtn.click();
      });
    });
  };

  // wire หลัง DOM mount
  setTimeout(() => {
    const inp = $('atm-search');
    if (inp) {
      inp.addEventListener('input', (e) => {
        searchQ = e.target.value;
        refresh();
      });
      inp.focus();
    }
    refresh();
  }, 10);
}

async function renderTeamSites(teamId, sites) {
  // โหลด site ทั้งหมดเพื่อสร้างกล่อง "Available"
  if (!_allSites) {
    try { _allSites = (await fetchJson('/api/admin/sites')).sites; } catch { _allSites = []; }
  }
  const inIds = new Set(sites.map(s => s.id));
  const available = _allSites.filter(s => !inIds.has(s.id));

  const html = `
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span>💡 <strong>Drag</strong> site จากซ้าย → ขวาเพื่อเพิ่ม, ลาก ขวา → ซ้ายเพื่อถอด, หรือกดปุ่ม → ←</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <!-- Column: Available -->
      <div class="dnd-col" data-side="available" style="background:var(--bg-soft);border:1.5px dashed var(--border);border-radius:10px;padding:12px;min-height:280px;transition:all .2s">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
          <div style="font-weight:600;font-size:13.5px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis">📚 Site ทั้งหมด <span class="card-sub" id="dnd-avail-count">(${available.length})</span></div>
          <button class="btn primary" id="dnd-add-all" ${available.length === 0 ? 'disabled' : ''}
                  style="font-size:11px;padding:4px 10px;white-space:nowrap;flex-shrink:0">+ เพิ่มทั้งหมด</button>
        </div>
        <input type="text" id="dnd-avail-search" placeholder="🔍 ค้นหา..." autocomplete="off"
               style="width:100%;padding:7px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);margin-bottom:8px" />
        <div class="dnd-list" data-list="available" style="display:flex;flex-direction:column;gap:6px;max-height:500px;overflow-y:auto">
          ${available.length === 0
            ? '<div class="empty" style="padding:18px 10px">ทุก site อยู่ในทีมแล้ว</div>'
            : available.map(s => `
              <div class="dnd-item" draggable="true" data-site-id="${s.id}" data-side="available" data-search="${escapeHtml((s.name + ' ' + s.url_pattern).toLowerCase())}"
                   style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:9px 11px;cursor:grab;display:flex;align-items:center;gap:8px;font-size:12.5px;transition:all .15s">
                <span style="color:var(--text-muted);font-size:14px;line-height:1">⋮⋮</span>
                <div style="flex:1;min-width:0;overflow:hidden">
                  <div style="font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)}</div>
                  <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.url_pattern)}</div>
                </div>
                <button class="dnd-action" data-action="add" data-site-id="${s.id}" title="เพิ่มเข้าทีม"
                        style="background:var(--primary);color:#fff;border:none;border-radius:6px;width:28px;height:24px;cursor:pointer;font-size:14px;line-height:1">→</button>
              </div>
            `).join('')}
        </div>
      </div>

      <!-- Column: In team -->
      <div class="dnd-col" data-side="in-team" style="background:rgba(37,99,235,.04);border:1.5px dashed rgba(37,99,235,.3);border-radius:10px;padding:12px;min-height:280px;transition:all .2s">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px">
          <div style="font-weight:600;font-size:13.5px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis">✓ ใน Team <span class="card-sub" id="dnd-in-count">(${sites.length})</span></div>
          <button class="btn danger" id="dnd-remove-all" ${sites.length === 0 ? 'disabled' : ''}
                  style="font-size:11px;padding:4px 10px;white-space:nowrap;flex-shrink:0">ถอดทั้งหมด</button>
        </div>
        <input type="text" id="dnd-in-search" placeholder="🔍 ค้นหา..." autocomplete="off"
               style="width:100%;padding:7px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);margin-bottom:8px" />
        <div class="dnd-list" data-list="in-team" style="display:flex;flex-direction:column;gap:6px;max-height:500px;overflow-y:auto">
          ${sites.length === 0
            ? '<div class="empty" style="padding:18px 10px">ลาก site จากซ้ายมาที่นี่</div>'
            : sites.map(s => {
              const isAll = s.access_type === 'all';
              const accessBadge = isAll
                ? '<span style="display:inline-block;padding:1px 7px;border-radius:6px;font-size:10px;font-weight:600;background:rgba(37,99,235,.12);color:var(--primary)">All</span>'
                : `<span style="display:inline-block;padding:1px 7px;border-radius:6px;font-size:10px;font-weight:600;background:rgba(124,58,237,.12);color:var(--accent)">Select(${s.credentials.length})</span>`;
              return `
                <div class="dnd-item" draggable="true" data-site-id="${s.id}" data-side="in-team" data-search="${escapeHtml((s.name + ' ' + s.url_pattern).toLowerCase())}"
                     style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:9px 11px;cursor:grab;font-size:12.5px;transition:all .15s">
                  <div style="display:flex;align-items:center;gap:8px">
                    <button class="dnd-action" data-action="remove" data-site-id="${s.id}" title="ถอดออกจากทีม"
                            style="background:rgba(220,38,38,.1);color:var(--critical);border:none;border-radius:6px;width:28px;height:24px;cursor:pointer;font-size:14px;line-height:1">←</button>
                    <div style="flex:1;min-width:0;overflow:hidden">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <span style="font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)}</span>
                        ${accessBadge}
                      </div>
                      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.url_pattern)}</div>
                    </div>
                    <button class="dnd-edit" data-edit-site="${s.id}" title="แก้ไข access type / credentials"
                            style="background:none;color:var(--text-muted);border:1px solid var(--border);border-radius:6px;width:28px;height:24px;cursor:pointer;font-size:11px">✏️</button>
                  </div>
                </div>
              `;
            }).join('')}
        </div>
      </div>
    </div>
  `;
  $('tab-sites').innerHTML = html;

  // === Drag & Drop wiring ===
  const root = $('tab-sites');

  root.querySelectorAll('.dnd-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        siteId: parseInt(item.dataset.siteId, 10),
        side: item.dataset.side,
      }));
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.4';
    });
    item.addEventListener('dragend', () => { item.style.opacity = ''; });
  });

  root.querySelectorAll('.dnd-col').forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.style.borderStyle = 'solid';
      col.style.background = col.dataset.side === 'in-team'
        ? 'rgba(37,99,235,.08)' : 'var(--bg-hover)';
    });
    col.addEventListener('dragleave', (e) => {
      // ตรวจว่าเมาส์ออกจาก col จริงๆ (ไม่ใช่แค่เข้า child)
      if (!col.contains(e.relatedTarget)) {
        col.style.borderStyle = 'dashed';
        col.style.background = '';
      }
    });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.style.borderStyle = 'dashed';
      col.style.background = '';
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const targetSide = col.dataset.side;
      // ลากภายใน col เดิม → ไม่ทำอะไร
      if (payload.side === targetSide) return;
      try {
        if (targetSide === 'in-team') {
          // available → in-team: เพิ่มด้วย access_type='all'
          await fetchJson(`/api/admin/teams/${teamId}/sites`, {
            method: 'POST',
            body: JSON.stringify({ site_id: payload.siteId, access_type: 'all' }),
          });
        } else {
          // in-team → available: ถอดออก
          await fetchJson(`/api/admin/teams/${teamId}/sites/${payload.siteId}`, { method: 'DELETE' });
        }
        await loadTeamDetail(teamId);
      } catch (err) {
        alert('ไม่สำเร็จ: ' + err.message);
      }
    });
  });

  // === ปุ่ม fallback (→ / ← / ✏️) — กรณี drag ไม่สะดวก เช่น mobile ===
  root.querySelectorAll('.dnd-action').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const siteId = parseInt(btn.dataset.siteId, 10);
      try {
        if (action === 'add') {
          await fetchJson(`/api/admin/teams/${teamId}/sites`, {
            method: 'POST',
            body: JSON.stringify({ site_id: siteId, access_type: 'all' }),
          });
        } else {
          if (!confirm('ถอด site นี้ออกจากทีม?')) return;
          await fetchJson(`/api/admin/teams/${teamId}/sites/${siteId}`, { method: 'DELETE' });
        }
        await loadTeamDetail(teamId);
      } catch (err) {
        alert('ไม่สำเร็จ: ' + err.message);
      }
    });
  });

  root.querySelectorAll('.dnd-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = parseInt(btn.dataset.editSite, 10);
      const site = sites.find(s => s.id === sid);
      if (site) showEditTeamSiteModal(teamId, site);
    });
  });

  // === Search filters ===
  const wireSearch = (inputId, listSel) => {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    inp.addEventListener('input', () => {
      const q = inp.value.toLowerCase().trim();
      root.querySelectorAll(`.dnd-list[data-list="${listSel}"] .dnd-item`).forEach(item => {
        const key = item.dataset.search || '';
        item.style.display = (!q || key.includes(q)) ? '' : 'none';
      });
    });
  };
  wireSearch('dnd-avail-search', 'available');
  wireSearch('dnd-in-search', 'in-team');

  // === Bulk actions: เพิ่มทั้งหมด / ถอดทั้งหมด ===
  // หมายเหตุ: ทำงานเฉพาะ items ที่ visible (หลัง filter) → user สามารถใช้ search
  //          กับ "เพิ่มทั้งหมด/ถอดทั้งหมด" เพื่อ bulk เฉพาะกลุ่มที่กรองได้
  const bulkAction = async (listSel, opts) => {
    const visibleItems = Array.from(
      root.querySelectorAll(`.dnd-list[data-list="${listSel}"] .dnd-item`)
    ).filter(item => item.style.display !== 'none');
    if (visibleItems.length === 0) {
      alert(opts.emptyMsg);
      return;
    }
    const filterVal = (document.getElementById(opts.searchId)?.value || '').trim();
    const filterMsg = filterVal ? ` (filter: "${filterVal}")` : '';
    if (!confirm(`${opts.confirmPrefix} ${visibleItems.length} site${filterMsg}?`)) return;

    const btn = document.getElementById(opts.btnId);
    if (btn) {
      btn.disabled = true;
      btn._origText = btn.textContent;
      btn.textContent = `⏳ กำลัง ${opts.verb} ${visibleItems.length}...`;
    }

    const ids = visibleItems.map(i => parseInt(i.dataset.siteId, 10));
    const results = await Promise.allSettled(ids.map(opts.apiCall));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      alert(`${opts.verb}สำเร็จ ${ids.length - failed}/${ids.length} site (ล้มเหลว ${failed})`);
    }
    await loadTeamDetail(teamId);   // reload — re-render ทั้งหมด, btn จะถูกสร้างใหม่
  };

  const addAllBtn = document.getElementById('dnd-add-all');
  if (addAllBtn) {
    addAllBtn.addEventListener('click', () => bulkAction('available', {
      emptyMsg: 'ไม่มี site ให้เพิ่ม',
      confirmPrefix: 'เพิ่ม',
      verb: 'เพิ่ม',
      searchId: 'dnd-avail-search',
      btnId: 'dnd-add-all',
      apiCall: (siteId) => fetchJson(`/api/admin/teams/${teamId}/sites`, {
        method: 'POST',
        body: JSON.stringify({ site_id: siteId, access_type: 'all' }),
      }),
    }));
  }

  const rmAllBtn = document.getElementById('dnd-remove-all');
  if (rmAllBtn) {
    rmAllBtn.addEventListener('click', () => bulkAction('in-team', {
      emptyMsg: 'ไม่มี site ให้ถอด',
      confirmPrefix: 'ถอด',
      verb: 'ถอด',
      searchId: 'dnd-in-search',
      btnId: 'dnd-remove-all',
      apiCall: (siteId) => fetchJson(`/api/admin/teams/${teamId}/sites/${siteId}`, {
        method: 'DELETE',
      }),
    }));
  }
}

async function showEditTeamSiteModal(teamId, site) {
  // Need full credentials list of the site to pick from
  let allCreds = [];
  try {
    const r = await fetchJson('/api/admin/sites/' + site.id);
    allCreds = r.credentials || [];
  } catch (e) {
    alert('โหลด credentials ไม่ได้: ' + e.message);
    return;
  }
  const selectedIds = new Set((site.credentials || []).map(c => c.id));

  showModal({
    title: `แก้ไข Access — ${site.name}`,
    body: `
      <div class="field">
        <label>วิธีเข้าถึง</label>
        <select id="m-access" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          <option value="all" ${site.access_type === 'all' ? 'selected' : ''}>All credentials — ทุก credential ของ site</option>
          <option value="select" ${site.access_type === 'select' ? 'selected' : ''}>Select — เลือก credentials เฉพาะ</option>
        </select>
      </div>
      <div class="field" id="m-cred-list-wrap" ${site.access_type === 'all' ? 'style="display:none"' : ''}>
        <label>เลือก credentials ที่ทีมเข้าถึงได้ (${allCreds.length} ทั้งหมด)</label>
        <div style="border:1px solid var(--border);border-radius:8px;padding:8px;max-height:240px;overflow-y:auto;background:var(--bg-soft)">
          ${allCreds.length === 0 ? '<div class="hint">site นี้ยังไม่มี credential</div>' :
            allCreds.map(c => `
              <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px" class="cred-pick-row">
                <input type="checkbox" name="m-cred" value="${c.id}" ${selectedIds.has(c.id) ? 'checked' : ''}>
                <span><strong>${escapeHtml(c.label || '(no label)')}</strong> — ${escapeHtml(c.username)}</span>
              </label>
            `).join('')}
        </div>
      </div>
    `,
    onSubmit: async () => {
      const access = document.getElementById('m-access').value;
      const body = { access_type: access };
      if (access === 'select') {
        const checked = Array.from(document.querySelectorAll('input[name="m-cred"]:checked'))
          .map(i => parseInt(i.value, 10));
        body.credential_ids = checked;
      } else {
        body.credential_ids = [];   // clear selections (not used)
      }
      await fetchJson(`/api/admin/teams/${teamId}/sites/${site.id}`, {
        method: 'PATCH', body: JSON.stringify(body),
      });
      await loadTeamDetail(teamId);
    },
  });
  // toggle credential list visibility
  setTimeout(() => {
    const acc = document.getElementById('m-access');
    const wrap = document.getElementById('m-cred-list-wrap');
    if (acc && wrap) {
      acc.addEventListener('change', () => { wrap.style.display = acc.value === 'select' ? '' : 'none'; });
    }
  }, 0);
}

async function showEditTeamModal(team, teamId) {
  // โหลด teams ปัจจุบันเพื่อสร้าง parent picker (กัน self + descendants)
  let teams = [];
  try { teams = (await fetchJson('/api/admin/teams')).teams || []; } catch { /* ignore */ }
  const excludeIds = getTeamDescendantIds(teams, teamId);
  const parentOptionsHtml = buildParentTeamOptions(teams, team.parent_team_id ?? null, excludeIds);
  showModal({
    title: 'แก้ไขข้อมูล Team',
    body: `
      <div class="field">
        <label>ชื่อทีม</label>
        <input id="m-name" type="text" value="${escapeHtml(team.name)}" />
      </div>
      <div class="field">
        <label>คำอธิบาย</label>
        <input id="m-desc" type="text" value="${escapeHtml(team.description || '')}" />
      </div>
      <div class="field">
        <label>ทีมแม่ — จัดเป็นทีมย่อยภายใต้ (เปลี่ยนได้)</label>
        <select id="m-parent" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">${parentOptionsHtml}</select>
        <div class="hint" style="font-size:11px;color:var(--text-muted);margin-top:4px">ตัวเอง + ทีมย่อยของตัวเองถูก exclude อัตโนมัติ — กันสร้าง loop</div>
      </div>
    `,
    onSubmit: async () => {
      const name = $('m-name').value.trim();
      if (!name) throw new Error('กรอกชื่อทีม');
      const parentVal = $('m-parent').value;
      await fetchJson('/api/admin/teams/' + teamId, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          description: $('m-desc').value.trim() || null,
          parent_team_id: parentVal ? parseInt(parentVal, 10) : null,
        }),
      });
      // Re-render full page เพื่อ update ชื่อใน tab strip ด้วย
      await renderTeamsPage(teamId);
    },
  });
}

// ============== Access Requests (admin) ==============
let _arCurrentTab = 'pending';

async function renderAccessRequestsPage(mount) {
  mount = mount || $('peoples-detail') || $('main');  // v1.9.123 — render ลง container อื่นได้ (Peoples tab)
  mount.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🔔 Access Requests</h2>
      <span class="card-sub" id="ar-count">—</span>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      Member ขอสิทธิ์เข้าถึง platform — accept = ให้ direct grant ทุก credential ของ site นั้น (refine ได้ภายหลังที่ Config)
    </div>

    <div id="ar-tabs" style="display:flex;gap:6px;margin-bottom:14px;border-bottom:1px solid var(--border)">
      <button class="ar-tab" data-tab="pending"  data-default="1" style="background:none;border:none;padding:10px 14px;font-size:13.5px;cursor:pointer">⏳ Pending <span class="ar-tab-count"></span></button>
      <button class="ar-tab" data-tab="accepted" style="background:none;border:none;padding:10px 14px;font-size:13.5px;cursor:pointer">✓ Accepted <span class="ar-tab-count"></span></button>
      <button class="ar-tab" data-tab="rejected" style="background:none;border:none;padding:10px 14px;font-size:13.5px;cursor:pointer">✗ Rejected <span class="ar-tab-count"></span></button>
    </div>

    <div id="ar-list">
      ${skelStack(4)}
    </div>
  `;

  // Wire tab clicks
  document.querySelectorAll('.ar-tab').forEach(b => {
    b.addEventListener('click', () => {
      _arCurrentTab = b.dataset.tab;
      loadAccessRequests();
    });
  });

  await loadAccessRequests();
}

async function loadAccessRequests() {
  const listEl = $('ar-list');
  listEl.innerHTML = skelStack(4);

  let data;
  try {
    data = await fetchJson('/api/admin/access-requests?status=' + _arCurrentTab);
  } catch (e) {
    listEl.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }

  const requests = data.requests || [];
  const counts = data.counts || {};
  $('ar-count').textContent = `${requests.length} รายการ (${_arCurrentTab})`;

  // Update tab styles + counts
  document.querySelectorAll('.ar-tab').forEach(b => {
    const isActive = b.dataset.tab === _arCurrentTab;
    b.style.color = isActive ? 'var(--primary)' : 'var(--text-muted)';
    b.style.fontWeight = isActive ? '600' : '500';
    b.style.borderBottom = isActive ? '2px solid var(--primary)' : '2px solid transparent';
    const cnt = counts[b.dataset.tab] || 0;
    const cntSpan = b.querySelector('.ar-tab-count');
    if (cntSpan) cntSpan.textContent = cnt > 0 ? `(${cnt})` : '';
  });

  if (requests.length === 0) {
    const messages = {
      pending: 'ยังไม่มี request ที่รออนุมัติ 🎉',
      accepted: 'ยังไม่มี request ที่ผ่านการอนุมัติ',
      rejected: 'ยังไม่มี request ที่ถูกปฏิเสธ',
    };
    listEl.innerHTML = `<div class="empty">${messages[_arCurrentTab] || 'ไม่มีข้อมูล'}</div>`;
    return;
  }

  listEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
    ${requests.map(r => renderAccessRequestRow(r)).join('')}
  </div>`;

  // Wire action buttons
  listEl.querySelectorAll('button[data-ar-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAccessRequestAction(btn));
  });
}

function renderAccessRequestRow(r) {
  const memberName = r.display_name || r.email || r.phone || `Member #${r.member_id}`;
  const memberInitial = memberName.trim().charAt(0).toUpperCase();
  const siteInitial = (r.site_name || '?').trim().charAt(0).toUpperCase();
  const requestedAgo = fmtRelativeTh(r.requested_at);
  const decided = r.decided_at
    ? `${fmtRelativeTh(r.decided_at)}${r.decided_by ? ' โดย ' + escapeHtml(r.decided_by) : ''}`
    : '';

  const siteAvatar = r.logo_data
    ? `<div style="width:40px;height:40px;border-radius:10px;background:#fff;border:1px solid var(--border);overflow:hidden;flex-shrink:0;padding:4px"><img src="${r.logo_data}" alt="${escapeHtml(r.site_name)}" style="width:100%;height:100%;object-fit:contain" /></div>`
    : `<div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;font-weight:700;font-size:15px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(siteInitial)}</div>`;

  const statusBadge = {
    pending: '<span style="display:inline-flex;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.12);color:#92400e">⏳ Pending</span>',
    accepted: '<span style="display:inline-flex;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">✓ Accepted</span>',
    rejected: '<span style="display:inline-flex;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(220,38,38,.10);color:var(--critical)">✗ Rejected</span>',
  }[r.status] || '';

  const actions = r.status === 'pending'
    ? `<div style="display:flex;gap:6px">
        <button class="btn primary" data-ar-action="accept" data-ar-id="${r.id}" style="font-size:12.5px;padding:6px 14px">✓ Accept</button>
        <button class="btn danger" data-ar-action="reject" data-ar-id="${r.id}" style="font-size:12.5px;padding:6px 14px">✗ Reject</button>
      </div>`
    : '';

  return `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <!-- Member -->
      <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1">
        <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:14px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(memberInitial)}</div>
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(memberName)}</div>
          <div style="font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.email || r.phone || '')}</div>
        </div>
      </div>

      <!-- Arrow -->
      <div style="font-size:18px;color:var(--text-soft);flex-shrink:0">→</div>

      <!-- Site -->
      <div style="display:flex;align-items:center;gap:10px;min-width:200px;flex:1">
        ${siteAvatar}
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.site_name)}</div>
          <div style="font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace">${escapeHtml(r.url_pattern)}</div>
        </div>
      </div>

      <!-- Status + meta -->
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:180px">
        ${statusBadge}
        <div style="font-size:11px;color:var(--text-muted)">ขอเมื่อ ${escapeHtml(requestedAgo)}</div>
        ${decided ? `<div style="font-size:11px;color:var(--text-muted)">ตัดสิน ${decided}</div>` : ''}
      </div>

      <!-- Note -->
      ${r.note ? `<div style="flex-basis:100%;padding:10px 12px;background:var(--bg-soft);border-radius:8px;font-size:12.5px;color:var(--text-muted);font-style:italic">💬 ${escapeHtml(r.note)}</div>` : ''}

      ${actions ? `<div style="flex-basis:100%;display:flex;justify-content:flex-end">${actions}</div>` : ''}
    </div>
  `;
}

async function handleAccessRequestAction(btn) {
  const id = btn.dataset.arId;
  const action = btn.dataset.arAction;
  const verb = action === 'accept' ? 'อนุมัติ' : 'ปฏิเสธ';
  if (!confirm(`ยืนยัน${verb} request นี้?`)) return;
  let note = null;
  if (action === 'reject') {
    note = prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ):', '') || null;
  }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⏳';
  try {
    await fetchJson(`/api/admin/access-requests/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ action, note }),
    });
    showSavedToast(action === 'accept' ? '✓ อนุมัติแล้ว' : '✗ ปฏิเสธแล้ว');
    await loadAccessRequests();
    refreshAccessRequestBadge();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    showSavedToast('❌ ' + e.message, 'error');
  }
}

// Refresh badge ในเมนูซ้าย — แสดง count ที่ทั้ง parent group + sub-item
async function refreshAccessRequestBadge() {
  if (currentRole !== 'admin') return;
  try {
    const r = await fetchJson('/api/admin/access-requests/pending-count');
    const setBadge = (el) => {
      if (!el) return;
      if (r.count > 0) {
        el.textContent = String(r.count);
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    };
    setBadge($('nav-peoples-badge'));           // v1.9.123 — sidebar Peoples link
    setBadge($('peoples-req-badge'));           // in-page Access Requests submenu item (ถ้าอยู่ในหน้า Peoples)
  } catch {}
}

