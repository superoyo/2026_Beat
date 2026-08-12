// ============== v1.9.132 — Skill Marketplace ==============
const SKILL_CATEGORIES = [
  { key: 'development', icon: '💻', label: 'Development' },
  { key: 'devops', icon: '🚀', label: 'DevOps & Infrastructure' },
  { key: 'security', icon: '🔒', label: 'Security' },
  { key: 'design', icon: '🎨', label: 'Design & Creative' },
  { key: 'documents', icon: '📄', label: 'Documents' },
  { key: 'communication', icon: '💬', label: 'Communication' },
  { key: 'marketing', icon: '📣', label: 'Marketing' },
  { key: 'integration', icon: '🔌', label: 'Integration' },
  { key: 'other', icon: '📦', label: 'Other' },
];
let _skillCat = '__all__';
let _skillSearch = '';
let _skillCats = null;     // v1.9.135 — โหลดจาก API (fallback SKILL_CATEGORIES)
function _cats() { return (_skillCats && _skillCats.length) ? _skillCats : SKILL_CATEGORIES; }
function _skillCatLabel(k) { const c = _cats().find(x => x.key === k); return c ? c.icon + ' ' + c.label : k; }
async function _loadSkillCats(force) {
  if (_skillCats && !force) return _skillCats;
  try { const r = await fetchJson('/api/skill-categories'); _skillCats = (r.categories || []).map(c => ({ id: c.id, key: c.key, icon: c.icon || '📦', label: c.label })); }
  catch { _skillCats = null; }
  return _skillCats;
}

async function renderSkillMarketplace() {
  const root = $('skill-mp-root');
  if (!root) return;
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let data;
  try { await _loadSkillCats(); data = await fetchJson('/api/skills'); }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const counts = data.category_counts || {};
  const chip = (key, icon, label, n) => {
    const active = key === _skillCat;
    return `<button type="button" class="skill-cat" data-cat="${key}" style="flex-shrink:0;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--bg-card)'};color:${active ? '#fff' : 'var(--text)'}">${icon} ${escapeHtml(label)}${n != null ? ` <span style="opacity:.7">${n}</span>` : ''}</button>`;
  };
  let chips = chip('__all__', '🗂', 'ทั้งหมด', data.total);
  _cats().forEach(c => { chips += chip(c.key, c.icon, c.label, counts[c.key] || 0); });
  const isAdmin = currentRole === 'admin';
  const q = _skillSearch.trim().toLowerCase();
  let all = data.skills || [];
  if (_skillCat !== '__all__') all = all.filter(s => s.category === _skillCat);
  if (q) all = all.filter(s => (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || (s.tags || '').toLowerCase().includes(q));
  const cards = all.length === 0
    ? '<div class="empty" style="padding:30px;text-align:center;color:var(--text-muted)">— ไม่พบ skill —</div>'
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">` + all.map(s => `
        <div class="card skill-card" data-skill-id="${s.id}" style="display:flex;flex-direction:column;gap:9px;padding:18px;cursor:pointer">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span style="font-size:11px;color:var(--text-muted)">${_skillCatLabel(s.category)}</span>
            <span style="font-size:11.5px;color:var(--text-soft)">⬇ ${s.download_count}</span>
          </div>
          <div style="font-weight:700;font-size:15px;line-height:1.3">${escapeHtml(s.name)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);line-height:1.5;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(s.description || '')}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px">${(s.tags || '').split(',').filter(Boolean).slice(0, 3).map(t => `<span style="font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--bg-soft);color:var(--text-muted)">${escapeHtml(t.trim())}</span>`).join('')}</div>
          <div style="display:flex;align-items:center;gap:7px;border-top:1px solid var(--border);padding-top:8px">
            ${_mpickAvatar({ name: s.owner_name || s.uploader_name, avatar: s.owner_avatar }, 22)}
            <span style="font-size:11.5px;color:var(--text-soft);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.owner_name || s.uploader_name || '—')}${s.example_count ? ` · ${s.example_count} ex` : ''}</span>
          </div>
        </div>`).join('') + `</div>`;
  root.innerHTML = `
    <div id="skill-scroll" style="overflow-y:auto;max-height:calc(100vh - 110px)">
      <!-- hero — เลื่อนหายไปตอน scroll -->
      <div style="text-align:center;padding:2px 0 12px">
        <div style="font-size:23px;font-weight:800;letter-spacing:-0.02em">🛒 Skill Marketplace</div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">ค้นหา skill เพื่อเสริมความสามารถให้ AI agent · ทุกคนอัพโหลดได้</div>
      </div>
      <!-- search bar — sticky ค้างบนตอน scroll -->
      <div style="position:sticky;top:0;z-index:6;background:var(--bg-soft);padding:8px 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="position:relative;flex:1;min-width:200px">
          <span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:15px">🔍</span>
          <input id="skill-search" type="text" value="${escapeHtml(_skillSearch)}" placeholder="Search Skills..." autocomplete="off"
                 style="width:100%;padding:11px 16px 11px 42px;font-size:14.5px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);color:var(--text);box-shadow:var(--shadow-sm)" />
        </div>
        ${isAdmin ? '<button type="button" class="btn" id="skill-cat-manage" style="font-size:13px;padding:10px 14px;white-space:nowrap">⚙️ จัดการหมวดหมู่</button>' : ''}
        <button type="button" class="btn primary" id="skill-upload-btn" style="font-size:13px;padding:10px 16px;white-space:nowrap">+ อัพโหลด Skill</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;overflow-x:auto;padding:2px 0 10px">
        <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-right:2px">${data.total} skills</span>
        ${chips}
      </div>
      <div id="skill-grid" style="padding-bottom:8px">${cards}</div>
    </div>`;
  const si = $('skill-search');
  let _t;
  si.addEventListener('input', (e) => { clearTimeout(_t); const v = e.target.value; _t = setTimeout(() => { _skillSearch = v; renderSkillMarketplace().then(() => { const el = $('skill-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); }, 280); });
  root.querySelectorAll('.skill-cat').forEach(b => b.addEventListener('click', () => { _skillCat = b.dataset.cat; renderSkillMarketplace(); }));
  root.querySelectorAll('.skill-card').forEach(c => c.addEventListener('click', () => showSkillDetail(parseInt(c.dataset.skillId, 10))));
  $('skill-upload-btn').addEventListener('click', openSkillUploadModal);
  if (isAdmin) $('skill-cat-manage').addEventListener('click', openSkillCategoryManager);
}

// v1.9.135 — จัดการหมวดหมู่ (admin)
async function openSkillCategoryManager() {
  await _loadSkillCats(true);
  const renderRows = () => (_cats()).map(c => `
    <div class="sk-cat-row" data-cat-id="${c.id || ''}" data-cat-key="${escapeHtml(c.key)}" style="display:flex;gap:8px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
      <input class="sk-cat-icon" value="${escapeHtml(c.icon)}" maxlength="4" style="width:44px;text-align:center;padding:7px;border:1px solid var(--border);border-radius:6px;font-size:15px" />
      <input class="sk-cat-label" value="${escapeHtml(c.label)}" style="flex:1;padding:7px 9px;border:1px solid var(--border);border-radius:6px;font-family:inherit" />
      <span style="font-size:11px;color:var(--text-soft);font-family:ui-monospace,Menlo,monospace;min-width:80px">${escapeHtml(c.key)}</span>
      <button type="button" class="btn" data-cat-save style="font-size:11.5px;padding:5px 9px">💾</button>
      <button type="button" class="btn danger" data-cat-del style="font-size:11.5px;padding:5px 9px">🗑</button>
    </div>`).join('');
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide" style="max-height:86vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0;font-size:17px;font-weight:700">⚙️ จัดการหมวดหมู่ Skill</h3>
        <button class="btn" id="skc-close" style="font-size:13px;padding:6px 12px">✕ ปิด</button>
      </div>
      <div id="skc-list">${renderRows()}</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <input id="skc-new-icon" value="📦" maxlength="4" style="width:44px;text-align:center;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:15px" />
        <input id="skc-new-label" placeholder="ชื่อหมวดหมู่ใหม่" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-family:inherit" />
        <button type="button" class="btn primary" id="skc-add" style="font-size:13px;padding:8px 14px">+ เพิ่ม</button>
      </div>
      <div class="hint" id="skc-msg" style="margin-top:8px;display:none"></div>
    </div>`;
  document.body.appendChild(bg);
  const close = () => { bg.remove(); renderSkillMarketplace(); };
  bg.querySelector('#skc-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  const msg = (t, err) => { const m = bg.querySelector('#skc-msg'); m.textContent = t; m.style.display = ''; m.style.color = err ? 'var(--critical)' : 'var(--green)'; };
  const reload = async () => { await _loadSkillCats(true); bg.querySelector('#skc-list').innerHTML = renderRows(); wireRows(); };
  function wireRows() {
    bg.querySelectorAll('.sk-cat-row').forEach(row => {
      row.querySelector('[data-cat-save]').addEventListener('click', async () => {
        try { await fetchJson(`/api/skill-categories/${row.dataset.catId}`, { method: 'PATCH', body: JSON.stringify({ icon: row.querySelector('.sk-cat-icon').value, label: row.querySelector('.sk-cat-label').value.trim() }) }); msg('✓ บันทึกแล้ว'); }
        catch (e) { msg('❌ ' + e.message, true); }
      });
      row.querySelector('[data-cat-del]').addEventListener('click', async () => {
        if (!confirm(`ลบหมวดหมู่ "${row.dataset.catKey}"? (skill ในหมวดนี้จะไม่ถูกลบ แต่จะไม่มีหมวด)`)) return;
        try { await fetchJson(`/api/skill-categories/${row.dataset.catId}`, { method: 'DELETE' }); await reload(); }
        catch (e) { msg('❌ ' + e.message, true); }
      });
    });
  }
  wireRows();
  bg.querySelector('#skc-add').addEventListener('click', async () => {
    const label = bg.querySelector('#skc-new-label').value.trim();
    if (!label) { msg('กรอกชื่อหมวดหมู่', true); return; }
    try { await fetchJson('/api/skill-categories', { method: 'POST', body: JSON.stringify({ icon: bg.querySelector('#skc-new-icon').value, label }) }); bg.querySelector('#skc-new-label').value = ''; await reload(); msg('✓ เพิ่มแล้ว'); }
    catch (e) { msg('❌ ' + e.message, true); }
  });
}

async function showSkillDetail(skillId) {
  const root = $('skill-mp-root');
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let s;
  try { s = await fetchJson(`/api/skills/${skillId}`); }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const editBtns = s.can_edit ? `
    <button type="button" class="btn" id="skill-edit-btn" style="font-size:12.5px;padding:7px 12px">✏️ แก้ไข</button>
    <button type="button" class="btn danger" id="skill-del-btn" style="font-size:12.5px;padding:7px 12px">🗑 ลบ</button>` : '';
  root.innerHTML = `
    <button type="button" class="btn" id="skill-back" style="font-size:13px;padding:7px 14px;margin-bottom:14px">← กลับ Marketplace</button>
    <div class="card" style="display:block">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:8px">
        <div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${_skillCatLabel(s.category)}</div>
          <h2 style="margin:0;font-size:22px;font-weight:800">${escapeHtml(s.name)}</h2>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${editBtns}<button type="button" class="btn primary" id="skill-dl-btn" style="font-size:13px;padding:8px 16px">⬇ Download Skill</button></div>
      </div>
      <div style="font-size:13.5px;color:var(--text-muted);line-height:1.6;margin-bottom:12px">${escapeHtml(s.description || '')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">${(s.tags || '').split(',').filter(Boolean).map(t => `<span style="font-size:11px;padding:2px 9px;border-radius:999px;background:var(--bg-soft);color:var(--text-muted)">${escapeHtml(t.trim())}</span>`).join('')}</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-soft);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:10px 0;margin-bottom:16px">
        <span>👤 เจ้าของ: <strong style="color:var(--text)">${escapeHtml(s.owner_name || '—')}</strong></span>
        <span>📤 อัพโหลดโดย: ${escapeHtml(s.uploader_name || '—')}</span>
        <span>⬇ ${s.download_count} downloads</span>
      </div>
      <div style="display:flex;gap:20px;border-bottom:1px solid var(--border);margin-bottom:14px">
        <button class="sk-tab active" data-sk-pane="detail" style="padding:8px 4px;border:none;background:transparent;border-bottom:2px solid var(--primary);cursor:pointer;font-family:inherit;font-size:14px;font-weight:600;color:var(--primary)">รายละเอียด</button>
        <button class="sk-tab" data-sk-pane="example" style="padding:8px 4px;border:none;background:transparent;border-bottom:2px solid transparent;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600;color:var(--text-muted)">Example</button>
      </div>
      <div data-sk-pane-body="detail">
        <pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12.5px;line-height:1.6;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;padding:14px;max-height:500px;overflow-y:auto;margin:0">${escapeHtml(s.content || '(ไม่มีเนื้อหา)')}</pre>
      </div>
      <div data-sk-pane-body="example" style="display:none"></div>
    </div>`;
  $('skill-back').addEventListener('click', () => renderSkillMarketplace());
  $('skill-dl-btn').addEventListener('click', () => downloadSkill(skillId));
  let _exLoaded = false;
  root.querySelectorAll('.sk-tab').forEach(t => t.addEventListener('click', () => {
    const pane = t.dataset.skPane;
    root.querySelectorAll('.sk-tab').forEach(x => { const on = x === t; x.style.color = on ? 'var(--primary)' : 'var(--text-muted)'; x.style.borderBottomColor = on ? 'var(--primary)' : 'transparent'; });
    root.querySelectorAll('[data-sk-pane-body]').forEach(pb => pb.style.display = pb.dataset.skPaneBody === pane ? '' : 'none');
    if (pane === 'example' && !_exLoaded) { _exLoaded = true; loadSkillExamples(skillId); }
  }));
  if (s.can_edit) {
    $('skill-edit-btn').addEventListener('click', () => openSkillEditModal(s));
    $('skill-del-btn').addEventListener('click', async () => {
      if (!confirm(`ลบ skill "${s.name}"?`)) return;
      try { await fetchJson(`/api/skills/${skillId}`, { method: 'DELETE' }); showSavedToast('✓ ลบแล้ว'); renderSkillMarketplace(); }
      catch (e) { showSavedToast('❌ ' + e.message, 'error'); }
    });
  }
}

async function downloadSkill(skillId) {
  try {
    const r = await fetchJson(`/api/skills/${skillId}/download`);
    const href = r.file_data.startsWith('data:') ? r.file_data : `data:${r.mime || 'application/octet-stream'};base64,${r.file_data}`;
    const a = document.createElement('a');
    a.href = href; a.download = r.file_name || 'skill';
    document.body.appendChild(a); a.click(); a.remove();
    showSavedToast('⬇ ดาวน์โหลดแล้ว');
  } catch (e) { showSavedToast('❌ ' + e.message, 'error'); }
}

async function loadSkillExamples(skillId) {
  const box = document.querySelector('[data-sk-pane-body="example"]');
  if (!box) return;
  box.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let r;
  try { r = await fetchJson(`/api/skills/${skillId}/examples`); }
  catch (e) { box.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const exs = r.examples || [];
  const addBtn = `<button type="button" class="btn primary" id="ex-add-btn" style="font-size:13px;padding:8px 14px;margin-bottom:14px">+ เพิ่ม Example</button>`;
  const list = exs.length === 0
    ? '<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ยังไม่มี example — ใครๆ ก็เพิ่มได้</div>'
    : exs.map(ex => {
        const resultCol = !ex.has_result
          ? '<div style="color:var(--text-muted);font-size:12.5px;font-style:italic">— ไม่มีไฟล์ผลลัพธ์ —</div>'
          : ex.is_image
            ? `<img data-ex-img="${ex.id}" alt="result" style="max-width:100%;max-height:240px;border-radius:8px;border:1px solid var(--border);cursor:zoom-in;display:block" title="คลิกเพื่อดูเต็ม" />`
            : `<button type="button" class="btn" data-ex-dl="${ex.id}" style="font-size:12.5px;padding:7px 12px">⬇ ${escapeHtml(ex.result_filename || 'download')}</button>`;
        const delBtn = ex.can_delete ? `<button type="button" class="btn danger" data-ex-del="${ex.id}" style="font-size:11px;padding:3px 8px">🗑</button>` : '';
        return `
          <div style="border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px">
              <span style="font-size:11.5px;color:var(--text-soft)">โดย <strong style="color:var(--text)">${escapeHtml(ex.creator_name || '—')}</strong></span>
              ${delBtn}
            </div>
            <div class="sk-ex-cols" style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
              <div>
                <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Prompt</div>
                <div style="white-space:pre-wrap;font-size:13px;line-height:1.5;background:var(--bg-soft);border-radius:8px;padding:11px">${escapeHtml(ex.prompt || '—')}</div>
              </div>
              <div>
                <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">ผลลัพธ์</div>
                ${resultCol}
              </div>
            </div>
          </div>`;
      }).join('');
  box.innerHTML = addBtn + list;
  box.querySelectorAll('img[data-ex-img]').forEach(async img => {
    try {
      const res = await fetchJson(`/api/skills/${skillId}/examples/${img.dataset.exImg}/result`);
      const src = res.file_data.startsWith('data:') ? res.file_data : `data:${res.mime};base64,${res.file_data}`;
      img.src = src;
      img.addEventListener('click', () => window.open(src, '_blank'));
    } catch {}
  });
  box.querySelectorAll('[data-ex-dl]').forEach(b => b.addEventListener('click', () => downloadExampleResult(skillId, b.dataset.exDl)));
  box.querySelectorAll('[data-ex-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('ลบ example นี้?')) return;
    try { await fetchJson(`/api/skills/${skillId}/examples/${b.dataset.exDel}`, { method: 'DELETE' }); loadSkillExamples(skillId); }
    catch (e) { showSavedToast('❌ ' + e.message, 'error'); }
  }));
  $('ex-add-btn').addEventListener('click', () => openSkillExampleModal(skillId));
}
async function downloadExampleResult(skillId, exId) {
  try {
    const r = await fetchJson(`/api/skills/${skillId}/examples/${exId}/result`);
    const href = r.file_data.startsWith('data:') ? r.file_data : `data:${r.mime};base64,${r.file_data}`;
    const a = document.createElement('a'); a.href = href; a.download = r.file_name || 'result';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { showSavedToast('❌ ' + e.message, 'error'); }
}
function openSkillExampleModal(skillId) {
  const up = { data: null, name: null, mime: null };
  showModal({
    title: '+ เพิ่ม Example', size: 'wide',
    body: `
      <div style="display:flex;flex-direction:column;gap:12px">
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">Prompt (ข้อความ)
          <textarea id="ex-prompt" rows="4" placeholder="ใส่ prompt ที่ใช้..." style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;resize:vertical"></textarea></label>
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">ผลลัพธ์ (อัพโหลดไฟล์อะไรก็ได้ — รูป/เอกสาร/ฯลฯ)
          <label class="btn" style="cursor:pointer;text-align:center;padding:9px">📎 เลือกไฟล์ผลลัพธ์<input type="file" id="ex-file" style="display:none" /></label></label>
        <div id="ex-file-name" style="font-size:12px;color:var(--text-muted)"></div>
      </div>`,
    onSubmit: async () => {
      const prompt = $('ex-prompt').value.trim();
      if (!prompt && !up.data) throw new Error('ใส่ prompt หรืออัพโหลดผลลัพธ์อย่างน้อยอย่างใดอย่างหนึ่ง');
      await fetchJson(`/api/skills/${skillId}/examples`, { method: 'POST', body: JSON.stringify({
        prompt, result_filename: up.name, result_mime: up.mime, result_data: up.data,
      })});
      showSavedToast('✓ เพิ่ม example แล้ว');
      loadSkillExamples(skillId);
    },
  });
  setTimeout(() => {
    const fi = $('ex-file'); if (!fi) return;
    fi.addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      up.name = f.name; up.mime = f.type || 'application/octet-stream';
      $('ex-file-name').textContent = '📄 ' + f.name;
      const rd = new FileReader(); rd.onload = (ev) => { up.data = ev.target.result; }; rd.readAsDataURL(f);
    });
  }, 30);
}

function _parseSkillFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text || '');
  const out = {};
  if (m) m[1].split('\n').forEach(line => {
    const mm = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (mm) out[mm[1]] = mm[2].replace(/^["']|["']$/g, '').trim();
  });
  return out;
}
let _skillMemberOpts = null;
async function _loadSkillMemberOpts() {
  if (_skillMemberOpts) return _skillMemberOpts;
  try { const r = await fetchJson('/api/skill-member-options'); _skillMemberOpts = r.members || []; }
  catch { _skillMemberOpts = []; }
  return _skillMemberOpts;
}
// v1.9.137 — searchable member picker (รูปเล็ก + ชื่อ + ทีม/แผนก) แทน native <select>
function _mpickAvatar(m, size) {
  if (m && m.avatar) return `<img src="${m.avatar}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;flex-shrink:0" />`;
  const ini = escapeHtml((((m && m.name) || '?').trim().slice(0, 1) || '?').toUpperCase());
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;font-size:${Math.round(size * 0.42)}px;font-weight:700;flex-shrink:0">${ini}</span>`;
}
function _mpickFace(m, size) {
  const sub = m && m.team ? `<span style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.team)}</span>` : '';
  return `${_mpickAvatar(m, size)}<span style="display:flex;flex-direction:column;min-width:0;line-height:1.25"><span style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.name)}</span>${sub}</span>`;
}
function _memberPickerHtml(pid, selId, emptyLabel) {
  return `
    <div class="mpick" data-mpick="${pid}" style="position:relative">
      <input type="hidden" id="${pid}" value="${selId != null ? selId : ''}" />
      <button type="button" class="mpick-trigger" id="${pid}-trg" style="width:100%;display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);cursor:pointer;text-align:left;min-height:42px;font-family:inherit">
        <span class="mpick-face" style="display:flex;align-items:center;gap:8px;min-width:0;flex:1"><span style="color:var(--text-muted);font-size:13px">${escapeHtml(emptyLabel)}</span></span>
        <span style="color:var(--text-muted);font-size:11px">▾</span>
      </button>
      <div class="mpick-panel" id="${pid}-pnl" style="display:none;margin-top:6px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);box-shadow:0 8px 24px rgba(15,23,42,.12);overflow:hidden">
        <div style="padding:8px;border-bottom:1px solid var(--border)"><input type="text" class="mpick-search" id="${pid}-srch" placeholder="🔍 ค้นหาชื่อ / ทีม..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-family:inherit;font-size:13px;box-sizing:border-box" /></div>
        <div class="mpick-list" id="${pid}-lst" style="max-height:240px;overflow-y:auto;padding:5px"></div>
      </div>
    </div>`;
}
function _initMemberPicker(pid, opts, emptyLabel, onChange, addNew) {
  const root = document.querySelector(`[data-mpick="${pid}"]`);
  if (!root) return;
  const hidden = document.getElementById(pid);
  const trg = document.getElementById(pid + '-trg');
  const pnl = document.getElementById(pid + '-pnl');
  const srch = document.getElementById(pid + '-srch');
  const lst = document.getElementById(pid + '-lst');
  const face = trg.querySelector('.mpick-face');
  const byId = {};
  opts.forEach(m => { byId[String(m.id)] = m; });
  function paintFace() {
    const m = byId[String(hidden.value)];
    face.innerHTML = m ? _mpickFace(m, 24) : `<span style="color:var(--text-muted);font-size:13px">${escapeHtml(emptyLabel)}</span>`;
  }
  function rowHtml(m) {
    const sub = m.team ? `<span style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.team)}</span>` : '';
    return `<div class="mpick-item" data-id="${m.id}" style="display:flex;align-items:center;gap:9px;padding:6px 9px;cursor:pointer;border-radius:7px">${_mpickAvatar(m, 30)}<span style="display:flex;flex-direction:column;min-width:0;line-height:1.3"><span style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.name)}</span>${sub}</span></div>`;
  }
  function renderList(rawQ) {
    const q = (rawQ || '').toLowerCase().trim();
    const filtered = opts.filter(m => !q || (m.name || '').toLowerCase().includes(q) || (m.team || '').toLowerCase().includes(q));
    const head = `<div class="mpick-item" data-id="" style="padding:8px 9px;cursor:pointer;border-radius:7px;font-size:12.5px;color:var(--text-muted)">${escapeHtml(emptyLabel)}</div>`;
    let html = head + (filtered.length ? filtered.map(rowHtml).join('') : `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:12.5px">ไม่พบรายชื่อ</div>`);
    // v1.9.299 — พิมพ์ชื่อใหม่ที่ไม่มีในระบบ → ปุ่มเพิ่มสมาชิกใหม่ (opt-in ผ่าน addNew)
    const typed = (rawQ || '').trim();
    if (typeof addNew === 'function' && typed && !opts.some(m => (m.name || '').toLowerCase() === q)) {
      html += `<div class="mpick-addnew" style="display:flex;align-items:center;gap:8px;padding:9px;margin-top:4px;border-top:1px solid var(--border);cursor:pointer;border-radius:7px;color:var(--primary);font-size:13px;font-weight:600">＋ <span>เพิ่ม "<b>${escapeHtml(typed)}</b>" เป็นสมาชิกใหม่</span></div>`;
    }
    lst.innerHTML = html;
    lst.querySelectorAll('.mpick-item').forEach(it => it.addEventListener('click', () => { hidden.value = it.dataset.id; paintFace(); close(); if (typeof onChange === 'function') onChange(it.dataset.id); }));
    const addBtn = lst.querySelector('.mpick-addnew');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const newOpt = await addNew(typed);
      if (!newOpt) return;
      opts.push(newOpt); byId[String(newOpt.id)] = newOpt;
      hidden.value = String(newOpt.id); paintFace(); close();
      if (typeof onChange === 'function') onChange(String(newOpt.id));
    });
  }
  function open() { pnl.style.display = 'block'; srch.value = ''; renderList(''); setTimeout(() => srch.focus(), 10); }
  function close() { pnl.style.display = 'none'; }
  trg.addEventListener('click', () => { pnl.style.display === 'block' ? close() : open(); });
  srch.addEventListener('input', e => renderList(e.target.value));
  srch.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const first = lst.querySelector('.mpick-item[data-id]:not([data-id=""])'); if (first) first.click(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  paintFace();
}
// v1.9.300 — Month-Year calendar picker (custom — รองรับทุก browser รวม Safari ที่ไม่ support input type=month)
const _MTH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function _monthPickerHtml(pid, value, placeholder) {
  return `
    <div class="mthpick" data-mthpick="${pid}" style="position:relative">
      <input type="hidden" id="${pid}" value="${value || ''}" />
      <button type="button" id="${pid}-trg" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);cursor:pointer;text-align:left;font-family:inherit;font-size:13.5px;min-height:42px;box-sizing:border-box">
        <span class="mthpick-face"></span>
        <span style="font-size:14px">📅</span>
      </button>
      <div class="mthpick-pnl" id="${pid}-pnl" style="display:none;position:absolute;z-index:50;top:calc(100% + 5px);left:0;right:0;min-width:230px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);box-shadow:0 8px 24px rgba(15,23,42,.18);padding:10px"></div>
    </div>`;
}
function _initMonthPicker(pid, placeholder, allowClear) {
  const root = document.querySelector(`[data-mthpick="${pid}"]`);
  if (!root) return;
  const hidden = document.getElementById(pid);
  const trg = document.getElementById(pid + '-trg');
  const pnl = document.getElementById(pid + '-pnl');
  const face = trg.querySelector('.mthpick-face');
  const valid = (v) => v && /^\d{4}-\d{2}$/.test(v);
  let navYear = valid(hidden.value) ? parseInt(hidden.value.slice(0, 4), 10) : new Date().getFullYear();
  function paintFace() {
    // v1.9.340 — แสดงปี ค.ศ. ให้สอดคล้องกับหน้าอื่น (input value เป็น ค.ศ. อยู่แล้ว)
    const v = hidden.value;
    face.innerHTML = valid(v)
      ? `<span style="color:var(--text);font-weight:600">${_MTH_SHORT[parseInt(v.slice(5, 7), 10) - 1]} ${parseInt(v.slice(0, 4), 10)}</span>`
      : `<span style="color:var(--text-muted)">${escapeHtml(placeholder)}</span>`;
  }
  function renderPanel() {
    const v = hidden.value;
    const selY = valid(v) ? parseInt(v.slice(0, 4), 10) : null;
    const selM = valid(v) ? parseInt(v.slice(5, 7), 10) : null;
    pnl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <button type="button" data-mth-nav="-1" style="border:none;background:var(--bg-soft);border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:16px;font-family:inherit">‹</button>
        <span style="font-weight:700;font-size:14.5px">${navYear}</span>
        <button type="button" data-mth-nav="1" style="border:none;background:var(--bg-soft);border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:16px;font-family:inherit">›</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">
        ${_MTH_SHORT.map((mn, i) => { const sel = selY === navYear && selM === i + 1; return `<button type="button" data-mth="${i + 1}" style="border:1px solid ${sel ? 'var(--primary)' : 'var(--border)'};background:${sel ? 'var(--primary)' : 'var(--bg-card)'};color:${sel ? '#fff' : 'var(--text)'};border-radius:7px;padding:9px 4px;cursor:pointer;font-size:12.5px;font-family:inherit;font-weight:${sel ? 700 : 500}">${mn}</button>`; }).join('')}
      </div>
      ${allowClear ? `<button type="button" data-mth-clear="1" style="width:100%;margin-top:8px;border:none;background:var(--bg-soft);border-radius:7px;padding:7px;cursor:pointer;font-size:12px;color:var(--text-muted);font-family:inherit">✕ ล้าง (= ปัจจุบัน)</button>` : ''}`;
    pnl.querySelectorAll('[data-mth-nav]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); navYear += parseInt(b.dataset.mthNav, 10); renderPanel(); }));
    pnl.querySelectorAll('[data-mth]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); hidden.value = navYear + '-' + String(parseInt(b.dataset.mth, 10)).padStart(2, '0'); paintFace(); close(); }));
    const clr = pnl.querySelector('[data-mth-clear]'); if (clr) clr.addEventListener('click', (e) => { e.stopPropagation(); hidden.value = ''; paintFace(); close(); });
  }
  function open() { navYear = valid(hidden.value) ? parseInt(hidden.value.slice(0, 4), 10) : new Date().getFullYear(); renderPanel(); pnl.style.display = 'block'; }
  function close() { pnl.style.display = 'none'; }
  trg.addEventListener('click', (e) => { e.stopPropagation(); pnl.style.display === 'block' ? close() : open(); });
  document.addEventListener('click', (e) => { if (!root.contains(e.target)) close(); });
  paintFace();
}

// v1.9.299 — เลือกสถานะสมาชิกใหม่ (พนักงานใหม่ / alumni) — คืน 'new' | 'alumni' | null
function _pickNewMemberKind(name) {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.style.zIndex = '4000';
    bg.innerHTML = `
      <div class="modal" style="max-width:380px">
        <h3 style="margin:0 0 6px;font-size:16px;font-weight:700">＋ เพิ่มสมาชิกใหม่</h3>
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:16px">สร้างโปรไฟล์ "<b style="color:var(--text)">${escapeHtml(name)}</b>" — เลือกสถานะ</div>
        <div style="display:flex;flex-direction:column;gap:9px">
          <button type="button" id="nmk-new" class="btn primary" style="width:100%;padding:12px;font-size:14px">🙋 พนักงานใหม่</button>
          <button type="button" id="nmk-alum" class="btn" style="width:100%;padding:12px;font-size:14px">🎓 Alumni (อดีตพนักงาน)</button>
          <button type="button" id="nmk-cancel" class="btn" style="width:100%;padding:8px;color:var(--text-muted);font-size:12.5px">ยกเลิก</button>
        </div>
      </div>`;
    document.body.appendChild(bg);
    const done = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('#nmk-new').onclick = () => done('new');
    bg.querySelector('#nmk-alum').onclick = () => done('alumni');
    bg.querySelector('#nmk-cancel').onclick = () => done(null);
    bg.addEventListener('click', e => { if (e.target === bg) done(null); });
  });
}

// v1.9.299 — addNew callback: สร้าง member (temp-staff) + ตั้ง alumni → คืน option ใหม่ (หรือ null)
async function _addNewMemberFromPicker(name) {
  const kind = await _pickNewMemberKind(name);
  if (!kind) return null;
  try {
    const res = await fetchJson('/api/admin/temp-staff', { method: 'POST', body: JSON.stringify({ name }) });
    const newId = res.id;
    if (kind === 'alumni') {
      await fetchJson('/api/admin/members/' + newId + '/alumni', { method: 'PATCH', body: JSON.stringify({ is_alumni: true, last_working_day: null }) });
    }
    if (Array.isArray(_hwMembersCache)) _hwMembersCache.push({ id: newId, display_name: name, email: null, avatar_data: null, teams: [], is_alumni: kind === 'alumni' });
    showSavedToast(kind === 'alumni' ? '✓ เพิ่ม Alumni แล้ว' : '✓ เพิ่มพนักงานใหม่แล้ว');
    return { id: newId, name, avatar: null, team: kind === 'alumni' ? '🎓 Alumni' : '🙋 พนักงานใหม่' };
  } catch (e) { alert('สร้างสมาชิกไม่สำเร็จ: ' + (e.message || e)); return null; }
}

function _skillFormBody(s, memberOpts) {
  const catOpts = _cats().map(c => `<option value="${c.key}" ${s && s.category === c.key ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('');
  const selStyle = 'padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit';
  return `
    <div style="display:flex;flex-direction:column;gap:12px">
      ${s ? '' : `<div class="hint" style="font-size:12.5px;color:var(--text-muted)">อัพโหลดไฟล์ SKILL.md (หรือไฟล์อื่น) — ถ้าเป็น .md ระบบจะดึงชื่อ/คำอธิบายจาก frontmatter ให้</div>
      <label class="btn" style="cursor:pointer;text-align:center;padding:10px">📎 เลือกไฟล์ Skill<input type="file" id="sk-file" style="display:none" /></label>
      <div id="sk-file-name" style="font-size:12px;color:var(--text-muted)"></div>`}
      <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">ชื่อ Skill <input id="sk-name" value="${s ? escapeHtml(s.name) : ''}" style="${selStyle}" /></label>
      <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">คำอธิบาย <textarea id="sk-desc" rows="2" style="${selStyle};resize:vertical">${s ? escapeHtml(s.description || '') : ''}</textarea></label>
      <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">หมวดหมู่ <select id="sk-cat" style="${selStyle}">${catOpts}</select></label>
      <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">Tags (คั่นด้วย ,) <input id="sk-tags" value="${s ? escapeHtml(s.tags || '') : ''}" placeholder="เช่น development, ui" style="${selStyle}" /></label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">📤 ผู้อัพโหลด ${_memberPickerHtml('sk-uploader', s ? s.uploader_member_id : null, '— ตัวฉัน (อัตโนมัติ) —')}</div>
        <div style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">👤 เจ้าของ ${_memberPickerHtml('sk-owner', s ? s.owner_member_id : null, '— ตามผู้อัพโหลด —')}</div>
      </div>
      ${s ? `<label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">เนื้อหา SKILL.md <textarea id="sk-content" rows="8" style="${selStyle};font-family:ui-monospace,Menlo,monospace;font-size:12px;resize:vertical">${escapeHtml(s.content || '')}</textarea></label>` : ''}
    </div>`;
}
async function openSkillUploadModal() {
  await _loadSkillCats(); const memberOpts = await _loadSkillMemberOpts();
  const up = { data: null, name: null, mime: null, content: null };
  showModal({
    title: '+ อัพโหลด Skill', size: 'wide', body: _skillFormBody(null, memberOpts),
    onSubmit: async () => {
      const name = $('sk-name').value.trim();
      if (!name) throw new Error('กรอกชื่อ skill');
      const upId = $('sk-uploader').value, ownId = $('sk-owner').value;
      await fetchJson('/api/skills', { method: 'POST', body: JSON.stringify({
        name, description: $('sk-desc').value.trim(), category: $('sk-cat').value,
        tags: $('sk-tags').value.trim(), content: up.content,
        file_name: up.name, file_data: up.data, file_mime: up.mime,
        uploader_member_id: upId ? parseInt(upId, 10) : null,
        owner_member_id: ownId ? parseInt(ownId, 10) : null,
      })});
      showSavedToast('✓ สร้าง skill แล้ว');
      _skillCat = '__all__'; renderSkillMarketplace();
    },
  });
  setTimeout(() => {
    _initMemberPicker('sk-uploader', memberOpts, '— ตัวฉัน (อัตโนมัติ) —');
    _initMemberPicker('sk-owner', memberOpts, '— ตามผู้อัพโหลด —');
    const fi = $('sk-file');
    if (!fi) return;
    fi.addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      up.name = f.name; up.mime = f.type || 'application/octet-stream';
      $('sk-file-name').textContent = '📄 ' + f.name;
      const rd = new FileReader();
      rd.onload = (ev) => { up.data = ev.target.result; };
      rd.readAsDataURL(f);
      if (/\.(md|markdown|txt)$/i.test(f.name) || (f.type || '').startsWith('text')) {
        const rd2 = new FileReader();
        rd2.onload = (e2) => {
          up.content = e2.target.result;
          const fm = _parseSkillFrontmatter(up.content);
          if (fm.name && !$('sk-name').value) $('sk-name').value = fm.name;
          if (fm.description && !$('sk-desc').value) $('sk-desc').value = fm.description;
        };
        rd2.readAsText(f);
      }
    });
  }, 30);
}
async function openSkillEditModal(s) {
  await _loadSkillCats(); const memberOpts = await _loadSkillMemberOpts();
  showModal({
    title: `✏️ แก้ไข — ${s.name}`, size: 'wide', body: _skillFormBody(s, memberOpts),
    onSubmit: async () => {
      const name = $('sk-name').value.trim();
      if (!name) throw new Error('กรอกชื่อ skill');
      const upId = $('sk-uploader').value, ownId = $('sk-owner').value;
      await fetchJson(`/api/skills/${s.id}`, { method: 'PATCH', body: JSON.stringify({
        name, description: $('sk-desc').value.trim(), category: $('sk-cat').value,
        tags: $('sk-tags').value.trim(), content: $('sk-content') ? $('sk-content').value : undefined,
        uploader_member_id: upId ? parseInt(upId, 10) : undefined,
        owner_member_id: ownId ? parseInt(ownId, 10) : undefined,
      })});
      showSavedToast('✓ บันทึกแล้ว');
      showSkillDetail(s.id);
    },
  });
  setTimeout(() => {
    _initMemberPicker('sk-uploader', memberOpts, '— ตัวฉัน (อัตโนมัติ) —');
    _initMemberPicker('sk-owner', memberOpts, '— ตามผู้อัพโหลด —');
  }, 30);
}

// ============== v1.9.143 — AI Project (gallery เว็บ AI) ==============
let _aiprojDept = '__all__';
let _aiprojSearch = '';
let _aiprojTeams = null;
const _AIPROJ_THMON = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function _aiprojMonthLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return '';
  const [y, m] = ym.split('-').map(Number);
  if (m < 1 || m > 12) return '';
  return `${_AIPROJ_THMON[m - 1]} ${y + 543}`;   // ปี พ.ศ.
}
async function _loadAiprojTeams() {
  if (_aiprojTeams) return _aiprojTeams;
  try { const r = await fetchJson('/api/team-options'); _aiprojTeams = r.teams || []; }
  catch { _aiprojTeams = []; }
  return _aiprojTeams;
}

async function renderAiProjects() {
  const root = $('aiproj-root');
  if (!root) return;
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let data;
  try { data = await fetchJson('/api/ai-projects'); }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const counts = data.department_counts || {};
  const q = _aiprojSearch.trim().toLowerCase();
  let all = data.projects || [];
  if (_aiprojDept !== '__all__') {
    all = all.filter(p => (p.department || '(ไม่ระบุแผนก)') === _aiprojDept);
  }
  if (q) all = all.filter(p =>
    (p.title || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q) ||
    (p.tags || '').toLowerCase().includes(q) || (p.url || '').toLowerCase().includes(q) ||
    (p.department || '').toLowerCase().includes(q));
  // filter chips (แผนก)
  const chip = (key, label, n) => {
    const active = key === _aiprojDept;
    return `<button type="button" class="aiproj-dept" data-dept="${escapeHtml(key)}" style="flex-shrink:0;padding:8px 14px;border-radius:10px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--bg-card)'};color:${active ? '#fff' : 'var(--text)'}">${escapeHtml(label)}${n != null ? ` <span style="opacity:.7">${n}</span>` : ''}</button>`;
  };
  let chips = chip('__all__', '🗂 ทั้งหมด', data.total);
  Object.keys(counts).sort((a, b) => a.localeCompare(b, 'th')).forEach(d => { chips += chip(d, '🏢 ' + d, counts[d]); });
  const cards = all.length === 0
    ? '<div class="empty" style="padding:30px;text-align:center;color:var(--text-muted)">— ไม่พบ AI Project —</div>'
    : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">` + all.map(p => {
        // v1.9.368 — ปุ่มเปิดลิงก์ภายนอกบนการ์ด (เติม https:// ถ้าไม่มี)
        const safeUrl = p.url ? (/^https?:\/\//i.test(p.url) ? p.url : 'https://' + p.url) : '';
        // v1.9.369 — pin: เจ้าของ/admin กดปักหมุดได้ · คนอื่นเห็นป้าย 📌 อย่างเดียว
        const pinCtrl = p.can_edit
          ? `<button type="button" class="aiproj-pin" data-id="${p.id}" data-pinned="${p.pinned ? '1' : '0'}" title="${p.pinned ? 'เลิกปักหมุด' : 'ปักหมุดขึ้นบนสุด'}" style="position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:none;cursor:pointer;font-size:14px;background:${p.pinned ? 'var(--primary)' : 'rgba(0,0,0,.55)'};color:#fff;backdrop-filter:blur(3px)">📌</button>`
          : (p.pinned ? `<span title="ปักหมุด" style="position:absolute;top:8px;left:8px;display:inline-flex;align-items:center;gap:3px;height:26px;padding:0 9px;border-radius:8px;background:var(--primary);color:#fff;font-size:11px;font-weight:700;backdrop-filter:blur(3px)">📌 Pinned</span>` : '');
        return `
        <div class="card aiproj-card" data-id="${p.id}" style="display:flex;flex-direction:column;padding:0;cursor:pointer;overflow:hidden${p.pinned ? ';box-shadow:0 0 0 2px var(--primary)' : ''}">
          <div style="width:100%;aspect-ratio:16/9;background:var(--bg-soft);overflow:hidden;flex-shrink:0;position:relative">
            ${p.image_data ? `<img src="${p.image_data}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />` : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-soft);font-size:34px">🤖</div>`}
            ${pinCtrl}
            ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="aiproj-open" title="เปิดเว็บไซต์ในแท็บใหม่" style="position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font-size:14px;text-decoration:none;backdrop-filter:blur(3px)">🔗</a>` : ''}
          </div>
          <div style="padding:13px 15px;display:flex;flex-direction:column;gap:7px;flex:1">
            ${p.department ? `<span style="align-self:flex-start;font-size:10.5px;padding:1px 8px;border-radius:999px;background:rgba(37,99,235,.10);color:var(--primary);font-weight:600">🏢 ${escapeHtml(p.department)}</span>` : ''}
            <div style="font-weight:700;font-size:15px;line-height:1.3">${escapeHtml(p.title)}</div>
            <div style="font-size:12.5px;color:var(--text-muted);line-height:1.5;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${escapeHtml(p.description || '')}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${(p.tags || '').split(',').filter(Boolean).slice(0, 3).map(t => `<span style="font-size:10.5px;padding:1px 7px;border-radius:999px;background:var(--bg-soft);color:var(--text-muted)">${escapeHtml(t.trim())}</span>`).join('')}</div>
            <div style="display:flex;align-items:center;gap:7px;border-top:1px solid var(--border);padding-top:8px;margin-top:2px">
              ${_mpickAvatar({ name: p.owner_name || p.creator_name, avatar: p.owner_avatar }, 20)}
              <span style="font-size:11px;color:var(--text-soft);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1">${escapeHtml(p.owner_name || p.creator_name || '—')}</span>
              ${p.started_month ? `<span style="font-size:10.5px;color:var(--text-soft);white-space:nowrap" title="เริ่มสร้าง">📅 ${_aiprojMonthLabel(p.started_month)}</span>` : ''}
            </div>
            ${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="aiproj-open btn" style="font-size:12px;padding:7px 10px;text-decoration:none;text-align:center;justify-content:center;display:flex;align-items:center;gap:5px">🔗 เปิดเว็บไซต์</a>` : ''}
          </div>
        </div>`;
      }).join('') + `</div>`;
  root.innerHTML = `
    <div id="aiproj-scroll" style="overflow-y:auto;max-height:calc(100vh - 110px)">
      <!-- hero — เลื่อนหายไปตอน scroll -->
      <div style="text-align:center;padding:2px 0 12px">
        <div style="font-size:23px;font-weight:800;letter-spacing:-0.02em">🤖 AI Project</div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">รวมเว็บ/โปรเจกต์ AI ในองค์กร · ทุกคนเพิ่มได้</div>
      </div>
      <!-- search bar — sticky ค้างบนตอน scroll -->
      <div style="position:sticky;top:0;z-index:6;background:var(--bg-soft);padding:8px 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div style="position:relative;flex:1;min-width:200px">
          <span style="position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-muted);font-size:15px">🔍</span>
          <input id="aiproj-search" type="text" value="${escapeHtml(_aiprojSearch)}" placeholder="ค้นหา AI Project..." autocomplete="off"
                 style="width:100%;padding:11px 16px 11px 42px;font-size:14.5px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);color:var(--text);box-shadow:var(--shadow-sm)" />
        </div>
        <button type="button" class="btn primary" id="aiproj-add-btn" style="font-size:13px;padding:10px 16px;white-space:nowrap">+ เพิ่มเว็บ</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;overflow-x:auto;padding:2px 0 10px">
        <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-right:2px">${data.total} โปรเจกต์</span>
        ${chips}
      </div>
      <div id="aiproj-grid" style="padding-bottom:8px">${cards}</div>
    </div>`;
  const si = $('aiproj-search');
  let _t;
  si.addEventListener('input', (e) => { clearTimeout(_t); const v = e.target.value; _t = setTimeout(() => { _aiprojSearch = v; renderAiProjects().then(() => { const el = $('aiproj-search'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }); }, 280); });
  root.querySelectorAll('.aiproj-dept').forEach(b => b.addEventListener('click', () => { _aiprojDept = b.dataset.dept; renderAiProjects(); }));
  root.querySelectorAll('.aiproj-card').forEach(c => c.addEventListener('click', () => showAiProjectDetail(parseInt(c.dataset.id, 10))));
  // v1.9.368 — ปุ่มเปิดลิงก์บนการ์ด: กดแล้วเปิดแท็บใหม่ ไม่เด้งเข้าหน้ารายละเอียด
  root.querySelectorAll('.aiproj-open').forEach(a => a.addEventListener('click', (e) => e.stopPropagation()));
  // v1.9.369 — ปักหมุด/เลิกปักหมุดจากการ์ด (ไม่เด้งเข้าหน้ารายละเอียด)
  root.querySelectorAll('.aiproj-pin').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    const id = parseInt(b.dataset.id, 10);
    const next = b.dataset.pinned !== '1';
    b.disabled = true;
    try {
      await fetchJson(`/api/ai-projects/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: next }) });
      showSavedToast(next ? '📌 ปักหมุดขึ้นบนสุดแล้ว' : '✓ เลิกปักหมุดแล้ว');
      renderAiProjects();
    } catch (err) { b.disabled = false; showSavedToast('❌ ' + err.message, 'error'); }
  }));
  $('aiproj-add-btn').addEventListener('click', () => openAiProjectModal(null));
}

async function showAiProjectDetail(id) {
  const root = $('aiproj-root');
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let p;
  try { p = await fetchJson(`/api/ai-projects/${id}`); }
  catch (e) { root.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const editBtns = p.can_edit ? `
    <button type="button" class="btn" id="aiproj-edit-btn" style="font-size:12.5px;padding:7px 12px">✏️ แก้ไข</button>
    <button type="button" class="btn danger" id="aiproj-del-btn" style="font-size:12.5px;padding:7px 12px">🗑 ลบ</button>` : '';
  // v1.9.369 — ปุ่มปักหมุด (เจ้าของ/admin)
  const pinBtn = p.can_edit
    ? `<button type="button" class="btn" id="aiproj-pin-btn" style="font-size:12.5px;padding:7px 12px${p.pinned ? ';background:var(--primary);color:#fff;border-color:var(--primary)' : ''}">📌 ${p.pinned ? 'เลิกปักหมุด' : 'ปักหมุด'}</button>`
    : '';
  const safeUrl = p.url && /^https?:\/\//i.test(p.url) ? p.url : (p.url ? 'https://' + p.url : '');
  root.innerHTML = `
    <button type="button" class="btn" id="aiproj-back" style="font-size:13px;padding:7px 14px;margin-bottom:14px">← กลับ AI Project</button>
    <div class="card" style="display:block;overflow:hidden;padding:0">
      <div style="width:100%;max-height:340px;aspect-ratio:16/9;background:var(--bg-soft);overflow:hidden">
        ${p.image_data ? `<img src="${p.image_data}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />` : `<div style="width:100%;height:100%;min-height:160px;display:flex;align-items:center;justify-content:center;color:var(--text-soft);font-size:48px">🤖</div>`}
      </div>
      <div style="padding:20px 22px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:8px">
          <div>
            ${p.pinned ? `<div style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:700;color:#fff;background:var(--primary);padding:2px 10px;border-radius:999px;margin-bottom:6px">📌 Pinned</div>` : ''}
            ${p.department ? `<div style="font-size:12px;color:var(--primary);font-weight:600;margin-bottom:4px">🏢 ${escapeHtml(p.department)}</div>` : ''}
            <h2 style="margin:0;font-size:22px;font-weight:800">${escapeHtml(p.title)}</h2>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">${pinBtn}${editBtns}${safeUrl ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" class="btn primary" style="font-size:13px;padding:8px 16px;text-decoration:none">🔗 เปิดเว็บไซต์</a>` : ''}</div>
        </div>
        <div style="font-size:13.5px;color:var(--text-muted);line-height:1.6;margin-bottom:12px;white-space:pre-wrap">${escapeHtml(p.description || '')}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">${(p.tags || '').split(',').filter(Boolean).map(t => `<span style="font-size:11px;padding:2px 9px;border-radius:999px;background:var(--bg-soft);color:var(--text-muted)">${escapeHtml(t.trim())}</span>`).join('')}</div>
        ${safeUrl ? `<div style="font-size:12.5px;color:var(--text-soft);margin-bottom:12px;word-break:break-all">🔗 <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary)">${escapeHtml(p.url)}</a></div>` : ''}
        <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--text-soft);border-top:1px solid var(--border);padding-top:12px">
          <span>👤 เจ้าของ: <strong style="color:var(--text)">${escapeHtml(p.owner_name || 'ไม่ระบุ')}</strong></span>
          <span>🛠️ ผู้สร้าง: ${escapeHtml(p.creator_name || 'ไม่ระบุ')}</span>
          ${p.started_month ? `<span>📅 เริ่มสร้าง: <strong style="color:var(--text)">${_aiprojMonthLabel(p.started_month)}</strong></span>` : ''}
        </div>
      </div>
    </div>`;
  $('aiproj-back').addEventListener('click', () => renderAiProjects());
  if (p.can_edit) {
    $('aiproj-edit-btn').addEventListener('click', () => openAiProjectModal(p));
    $('aiproj-del-btn').addEventListener('click', async () => {
      if (!confirm(`ลบ AI Project "${p.title}"?`)) return;
      try { await fetchJson(`/api/ai-projects/${id}`, { method: 'DELETE' }); showSavedToast('✓ ลบแล้ว'); renderAiProjects(); }
      catch (e) { showSavedToast('❌ ' + e.message, 'error'); }
    });
    // v1.9.369 — ปักหมุด/เลิกปักหมุดจากหน้ารายละเอียด
    const pb = $('aiproj-pin-btn');
    if (pb) pb.addEventListener('click', async () => {
      const next = !p.pinned;
      pb.disabled = true;
      try {
        await fetchJson(`/api/ai-projects/${id}/pin`, { method: 'POST', body: JSON.stringify({ pinned: next }) });
        showSavedToast(next ? '📌 ปักหมุดขึ้นบนสุดแล้ว' : '✓ เลิกปักหมุดแล้ว');
        showAiProjectDetail(id);
      } catch (e) { pb.disabled = false; showSavedToast('❌ ' + e.message, 'error'); }
    });
  }
}

async function openAiProjectModal(proj) {
  const teams = await _loadAiprojTeams();
  const memberOpts = await _loadSkillMemberOpts();
  const st = { image: proj ? (proj.image_data || null) : null, imageChanged: false };
  const inS = 'padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-family:inherit;font-size:13px;width:100%;box-sizing:border-box';
  const deptOpts = `<option value="">— ไม่ระบุแผนก —</option>` +
    teams.map(t => `<option value="${escapeHtml(t.name)}" ${proj && proj.department === t.name ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('');
  const imgInner = st.image
    ? `<img src="${st.image}" style="width:100%;height:100%;object-fit:cover" />`
    : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-soft);gap:4px"><div style="font-size:30px">🖼️</div><div style="font-size:11.5px">ยังไม่มีรูป (16:9)</div></div>`;
  showModal({
    title: proj ? `✏️ แก้ไข — ${proj.title}` : '+ เพิ่ม AI Project',
    size: 'wide',
    body: `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
          <div id="aiproj-img-preview" style="width:200px;aspect-ratio:16/9;border-radius:10px;border:1px solid var(--border);overflow:hidden;background:var(--bg-soft);flex-shrink:0">${imgInner}</div>
          <div style="flex:1;min-width:160px;display:flex;flex-direction:column;gap:6px">
            <label class="btn" style="cursor:pointer;text-align:center;padding:9px;font-size:13px">📷 ${proj && proj.image_data ? 'เปลี่ยนรูป' : 'อัพโหลดรูป'}<input type="file" id="aiproj-img-file" accept="image/*" style="display:none" /></label>
            <div class="hint" style="font-size:11.5px;color:var(--text-muted)">รูปจะถูก crop เป็น 16:9 ก่อนบันทึก เพื่อให้การ์ดมีขนาดเท่ากัน</div>
          </div>
        </div>
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">ชื่อโปรเจกต์ / เว็บ <input id="aiproj-title" value="${proj ? escapeHtml(proj.title) : ''}" style="${inS}" /></label>
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">URL <input id="aiproj-url" value="${proj ? escapeHtml(proj.url || '') : ''}" placeholder="https://..." style="${inS}" /></label>
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">คำอธิบาย <textarea id="aiproj-desc" rows="3" style="${inS};resize:vertical">${proj ? escapeHtml(proj.description || '') : ''}</textarea></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">แผนก <select id="aiproj-dept" style="${inS}">${deptOpts}</select></label>
          <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">เริ่มสร้างเมื่อ (เดือน) <input id="aiproj-month" type="month" value="${proj ? escapeHtml(proj.started_month || '') : ''}" style="${inS}" /></label>
        </div>
        <label style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">Tags (คั่นด้วย ,) <input id="aiproj-tags" value="${proj ? escapeHtml(proj.tags || '') : ''}" placeholder="เช่น chatbot, image, internal" style="${inS}" /></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">🛠️ ผู้สร้าง ${_memberPickerHtml('aiproj-creator', proj ? proj.creator_member_id : null, '— ตัวฉัน (อัตโนมัติ) —')}
            <label style="font-size:11.5px;color:var(--text-muted);display:flex;align-items:center;gap:6px;margin-top:2px;cursor:pointer;font-weight:400"><input type="checkbox" id="aiproj-creator-none" style="margin:0" /> ไม่ระบุผู้สร้าง</label>
          </div>
          <div style="font-size:13px;font-weight:600;display:flex;flex-direction:column;gap:4px">👤 เจ้าของ ${_memberPickerHtml('aiproj-owner', proj ? proj.owner_member_id : null, '— ตามผู้สร้าง —')}</div>
        </div>
      </div>`,
    onSubmit: async () => {
      const title = $('aiproj-title').value.trim();
      if (!title) throw new Error('กรอกชื่อโปรเจกต์');
      const crNone = !!($('aiproj-creator-none') && $('aiproj-creator-none').checked);
      const crId = $('aiproj-creator').value, ownId = $('aiproj-owner').value;
      const payload = {
        title,
        url: $('aiproj-url').value.trim(),
        description: $('aiproj-desc').value.trim(),
        department: $('aiproj-dept').value,
        tags: $('aiproj-tags').value.trim(),
        started_month: $('aiproj-month').value || null,
        owner_member_id: ownId ? parseInt(ownId, 10) : (proj ? undefined : null),
      };
      // v1.9.144 — ผู้สร้าง: ไม่ระบุ / เลือกคน / default(ตัวฉัน)
      if (crNone) { payload.creator_unspecified = true; payload.creator_member_id = null; }
      else if (crId) { payload.creator_member_id = parseInt(crId, 10); }
      else { payload.creator_member_id = (proj ? undefined : null); }
      if (st.imageChanged || !proj) payload.image_data = st.image || null;
      if (proj) {
        await fetchJson(`/api/ai-projects/${proj.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        showSavedToast('✓ บันทึกแล้ว');
        showAiProjectDetail(proj.id);
      } else {
        await fetchJson('/api/ai-projects', { method: 'POST', body: JSON.stringify(payload) });
        showSavedToast('✓ เพิ่มแล้ว');
        _aiprojDept = '__all__'; renderAiProjects();
      }
    },
  });
  setTimeout(() => {
    _initMemberPicker('aiproj-creator', memberOpts, '— ตัวฉัน (อัตโนมัติ) —');
    _initMemberPicker('aiproj-owner', memberOpts, '— ตามผู้สร้าง —');
    // v1.9.144 — checkbox "ไม่ระบุผู้สร้าง" — toggle ปิด picker เมื่อเลือกไม่ระบุ
    const crNoneCb = document.getElementById('aiproj-creator-none');
    const crPick = document.querySelector('[data-mpick="aiproj-creator"]');
    const _syncCrNone = () => { if (crPick) { crPick.style.opacity = crNoneCb.checked ? '0.45' : ''; crPick.style.pointerEvents = crNoneCb.checked ? 'none' : ''; } };
    if (crNoneCb) {
      if (proj && proj.creator_member_id == null && !proj.creator_name) crNoneCb.checked = true;   // edit: ผู้สร้างถูกตั้งเป็นไม่ระบุไว้
      crNoneCb.addEventListener('change', _syncCrNone);
      _syncCrNone();
    }
    const fi = document.getElementById('aiproj-img-file');
    if (fi) fi.addEventListener('change', (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = (ev) => openCropModal(ev.target.result, (cropped) => {
        st.image = cropped; st.imageChanged = true;
        const pv = document.getElementById('aiproj-img-preview');
        if (pv) pv.innerHTML = `<img src="${cropped}" style="width:100%;height:100%;object-fit:cover" />`;
      }, { aspectRatio: 16 / 9, outputWidth: 480, outputHeight: 270, outputType: 'image/jpeg', outputQuality: 0.85, title: '✂️ Crop รูปเว็บไซต์ (16:9)' });
      rd.readAsDataURL(f);
      fi.value = '';
    });
  }, 30);
}

// v1.9.148 — หน้า My Team (renderSupervisePage) ถูกลบออก — ย้ายไป My Profile > Team tab แทน

// v1.9.129 — คลิกคนใน Team → เปิด panel ขวา แสดง Profile + Device (M365 style)
async function openSupervisedMemberPanel(memberId, memberName) {
  document.querySelectorAll('.sup-panel-wrap').forEach(e => e.remove());
  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div class="sup-panel-body"><div class="empty" style="padding:24px">กำลังโหลด…</div></div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const close = () => { wrap.classList.remove('is-open'); setTimeout(() => wrap.remove(), 260); };
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', close);
  wrap.querySelector('.sup-panel-close').addEventListener('click', close);
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
  const body = wrap.querySelector('.sup-panel-body');
  try {
    const data = await fetchJson(`/api/member/supervised/${memberId}`);
    renderSupPanel(body, data, memberId);
  } catch (e) {
    body.innerHTML = `<div class="empty" style="padding:24px;color:var(--critical)">❌ ${escapeHtml(e.message)}</div>`;
  }
}
function _supFmtDate(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); } }
function _supFmtEpoch(ms) { if (ms == null) return '—'; try { return new Date(Number(ms)).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ms); } }
async function loadSupUsage(body, memberId) {
  const box = body.querySelector('[data-sup-pane-body="usage"]');
  box.innerHTML = '<div style="padding:14px;color:var(--text-muted)">กำลังโหลด…</div>';
  try {
    const r = await fetchJson(`/api/member/supervised/${memberId}/stats?days=30`);
    if (!r.platforms || r.platforms.length === 0) { box.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-muted)">— ไม่มีการใช้งานใน 30 วันล่าสุด —</div>'; return; }
    box.innerHTML = `<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px">รวม <strong>${r.total_clicks}</strong> ครั้ง · 30 วันล่าสุด</div>` +
      r.platforms.map(p => `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px">
          <div style="min-width:0"><div style="font-weight:600;font-size:13px">${escapeHtml(p.site_name)}</div><div style="font-size:11px;color:var(--text-muted)">ล่าสุด ${escapeHtml(_supFmtDate(p.last_used_at))}</div></div>
          <div style="font-weight:700;color:var(--primary);font-size:15px;flex-shrink:0">${p.click_count}</div>
        </div>`).join('');
  } catch (e) { box.innerHTML = `<div class="empty" style="padding:20px;color:var(--critical)">❌ ${escapeHtml(e.message)}</div>`; }
}
async function loadSupCheckin(body, memberId) {
  const box = body.querySelector('[data-sup-pane-body="checkin"]');
  const token = getWazzupToken();
  if (!token) { box.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-muted)">⚠️ ต้อง login ด้วย <strong>Wazzup</strong> ในเซสชันนี้ก่อน</div>'; return; }
  box.innerHTML = '<div style="padding:14px;color:var(--text-muted)">กำลังโหลด…</div>';
  try {
    const r = await fetchJson(`/api/member/supervised/${memberId}/beacon`, { headers: { 'Authorization': `Bearer ${token}` } });
    const t = r.checkInToday, l = r.checkInLastTime;
    const row = (label, val) => `<div style="padding:11px;border:1px solid var(--border);border-radius:9px;margin-bottom:8px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${label}</div><div style="font-size:13.5px">${val}</div></div>`;
    let html = '';
    html += row('เช็คอินวันนี้', t ? `📍 ${escapeHtml(t.locationName || '—')} · ${escapeHtml(t.type || '')} · ${escapeHtml(_supFmtEpoch(t.timestamp))}` : '<span style="color:var(--text-muted)">ยังไม่ check-in</span>');
    if (l) html += row('ล่าสุด', `📍 ${escapeHtml(l.checkInLocation || '—')} · ${escapeHtml(_supFmtDate(l.checkInAtThailandTime || l.checkInAt))}`);
    box.innerHTML = html;
  } catch (e) { box.innerHTML = `<div class="empty" style="padding:20px;color:var(--critical)">❌ ${escapeHtml(e.message)}</div>`; }
}
function renderSupPanel(body, data, memberId) {
  const p = data.profile;
  const devs = data.devices || [];
  const initial = (p.display_name || p.email || '?').trim().charAt(0).toUpperCase();
  const photo = p.avatar_data
    ? `<img src="${p.avatar_data}" style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--border)" />`
    : `<div style="width:96px;height:96px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:36px;display:inline-flex;align-items:center;justify-content:center">${escapeHtml(initial)}</div>`;
  const fmtDate = iso => iso ? new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const teamChips = (p.teams || []).map(t => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:500;background:rgba(37,99,235,.10);color:var(--primary);border:1px solid rgba(37,99,235,.20)">${escapeHtml(t.name)}</span>`).join('') || '<span style="color:var(--text-muted)">—</span>';
  const HW_LABEL = { pc: '💻 คอมพิวเตอร์', device: '📱 อุปกรณ์', network: '📡 เครือข่าย' };
  // v1.9.385 — admin (super หรือ admin-member) แก้ไขข้อมูล HR ได้
  const _supIsAdmin = (typeof currentRole !== 'undefined' && currentRole === 'admin') || (typeof currentIsSuper !== 'undefined' && currentIsSuper);
  const _dash = '<span style="color:var(--text-soft)">—</span>';
  const profileHtml = `
    <div style="display:grid;grid-template-columns:130px 1fr;gap:11px 14px;font-size:13.5px">
      <div style="color:var(--text-muted)">เบอร์มือถือ</div><div>${p.phone ? '📞 ' + escapeHtml(p.phone) : '—'}</div>
      <div style="color:var(--text-muted)">อีเมล</div><div style="word-break:break-all">${p.email ? escapeHtml(p.email) : '—'}</div>
      <div style="color:var(--text-muted)">วันเกิด</div><div>${p.birthdate ? escapeHtml(p.birthdate) : '—'}</div>
      <div style="color:var(--text-muted)">ขนาดเสื้อ</div><div>${p.shirt_size ? escapeHtml(p.shirt_size) : '—'}</div>
      <div style="color:var(--text-muted)">เข้าระบบล่าสุด</div><div>${escapeHtml(fmtDate(p.last_login_at))}</div>
      <div style="color:var(--text-muted)">ทีม</div><div style="display:flex;flex-wrap:wrap;gap:4px">${teamChips}</div>
    </div>
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px">
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">📋 ข้อมูลตามระบบ HR</div>
        ${_supIsAdmin ? `<button class="btn" id="sup-hr-edit" style="font-size:11.5px;padding:4px 10px">✏️ แก้ไข</button>` : ''}
      </div>
      <div id="sup-hr-view" style="display:grid;grid-template-columns:130px 1fr;gap:9px 14px;font-size:13.5px">
        <div style="color:var(--text-muted)">ชื่อ (ตาม HR)</div><div id="sup-hr-name">${p.hr_name ? escapeHtml(p.hr_name) : _dash}</div>
        <div style="color:var(--text-muted)">รหัสพนักงาน</div><div id="sup-hr-empid">${p.hr_employee_id ? escapeHtml(p.hr_employee_id) : _dash}</div>
      </div>
      ${_supIsAdmin ? `<div id="sup-hr-form" style="display:none;margin-top:6px">
        <div class="field" style="margin-bottom:8px"><label style="font-size:12px">ชื่อ (ตามระบบ HR)</label><input id="sup-hr-name-in" type="text" value="${escapeHtml(p.hr_name || '')}" style="width:100%" /></div>
        <div class="field" style="margin-bottom:8px"><label style="font-size:12px">รหัสพนักงาน (ตามระบบ HR)</label><input id="sup-hr-empid-in" type="text" value="${escapeHtml(p.hr_employee_id || '')}" placeholder="ใช้จับคู่ประวัติการลา" style="width:100%" /></div>
        <div style="display:flex;gap:8px"><button class="btn primary" id="sup-hr-save" style="font-size:12.5px">บันทึก</button><button class="btn" id="sup-hr-cancel" style="font-size:12.5px">ยกเลิก</button></div>
        <div id="sup-hr-msg" style="font-size:11.5px;margin-top:7px;display:none"></div>
      </div>` : ''}
    </div>`;
  const deviceHtml = devs.length === 0
    ? '<div class="empty" style="padding:20px;color:var(--text-muted)">— ไม่มีอุปกรณ์ที่ผูกไว้ —</div>'
    : devs.map(d => `
      <div style="display:flex;gap:12px;align-items:center;padding:11px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">
        ${d.photo_data ? `<img src="${d.photo_data}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0" />` : `<div style="width:48px;height:48px;border-radius:8px;background:var(--bg-soft);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">${(HW_LABEL[d.hw_type] || '🖥️').split(' ')[0]}</div>`}
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13.5px">${escapeHtml(d.name)}</div>
          <div style="font-size:11.5px;color:var(--text-muted)">${escapeHtml(HW_LABEL[d.hw_type] || d.hw_type)}${d.os ? ' · ' + escapeHtml(d.os) : ''}${d.model ? ' · ' + escapeHtml(d.model) : ''}</div>
        </div>
      </div>`).join('');
  // v1.9.265/268 — คอมฯที่ผูกในอดีต (Previous Device) — แสดง section เสมอ (มีหรือไม่มีก็เห็น)
  const prevDevs = data.previous_devices || [];
  const prevHtml = `
    <div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
      <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🔄 คอมฯที่ผูกในอดีต <span style="color:var(--text-soft)">${prevDevs.length}</span></div>
      ${prevDevs.length ? prevDevs.map(d => {
        const fr = (d.assigned_at || '').slice(0, 7), to = (d.unassigned_at || '').slice(0, 7);
        return `<div style="display:flex;gap:12px;align-items:center;padding:9px 11px;border:1px solid var(--border);border-radius:10px;margin-bottom:7px">
          <div style="width:42px;height:42px;border-radius:8px;background:var(--bg-soft);display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;opacity:.7">${(HW_LABEL[d.hw_type] || '🖥️').split(' ')[0]}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${escapeHtml(d.name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${escapeHtml(d.model || '—')}${fr ? ' · ' + escapeHtml(fmtMonthYearThai(fr)) : ''}${to ? ' – ' + escapeHtml(fmtMonthYearThai(to)) : ''}</div>
            <div style="font-size:11px;color:var(--primary);margin-top:1px">📍 ตอนนี้: ${escapeHtml(d.where_now)}</div>
          </div>
        </div>`;
      }).join('') : '<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:4px 0">— ไม่เคยผูกเครื่องอื่นมาก่อน —</div>'}
    </div>`;
  body.innerHTML = `
    <div style="text-align:center;margin-bottom:18px">
      ${photo}
      <div style="font-size:19px;font-weight:700;margin-top:10px">${escapeHtml(p.display_name || '(ไม่ได้ตั้งชื่อ)')}</div>
    </div>
    <div style="display:flex;gap:18px;border-bottom:1px solid var(--border);margin-bottom:16px;overflow-x:auto">
      <button class="sup-tab active" data-sup-pane="profile">Profile</button>
      <button class="sup-tab" data-sup-pane="device">Device <span style="opacity:.7">(${devs.length})</span></button>
      <button class="sup-tab" data-sup-pane="usage">การใช้งาน</button>
      <button class="sup-tab" data-sup-pane="checkin">Check-in</button>
      <button class="sup-tab" data-sup-pane="leave">🌴 ประวัติการลา</button>
    </div>
    <div data-sup-pane-body="profile">${profileHtml}</div>
    <div data-sup-pane-body="device" style="display:none">${deviceHtml}${prevHtml}</div>
    <div data-sup-pane-body="usage" style="display:none"></div>
    <div data-sup-pane-body="checkin" style="display:none"></div>
    <div data-sup-pane-body="leave" style="display:none"></div>
  `;
  const loaded = {};
  body.querySelectorAll('.sup-tab').forEach(t => t.addEventListener('click', () => {
    const pane = t.dataset.supPane;
    body.querySelectorAll('.sup-tab').forEach(x => x.classList.toggle('active', x === t));
    body.querySelectorAll('[data-sup-pane-body]').forEach(pb => pb.style.display = pb.dataset.supPaneBody === pane ? '' : 'none');
    if (pane === 'usage' && !loaded.usage) { loaded.usage = true; loadSupUsage(body, memberId); }
    if (pane === 'checkin' && !loaded.checkin) { loaded.checkin = true; loadSupCheckin(body, memberId); }
    if (pane === 'leave') loadSupLeave(body, p);   // v1.9.385 — โหลดใหม่ทุกครั้ง (เผื่อแก้รหัส/โหลด Absence เพิ่ม)
  }));
  // v1.9.385 — admin แก้ไขข้อมูล HR
  if (_supIsAdmin) {
    const editBtn = body.querySelector('#sup-hr-edit');
    const view = body.querySelector('#sup-hr-view');
    const form = body.querySelector('#sup-hr-form');
    const closeForm = () => { form.style.display = 'none'; view.style.display = 'grid'; if (editBtn) editBtn.textContent = '✏️ แก้ไข'; };
    if (editBtn) editBtn.addEventListener('click', () => {
      const open = form.style.display === 'none';
      form.style.display = open ? '' : 'none'; view.style.display = open ? 'none' : 'grid';
      editBtn.textContent = open ? '✕ ปิด' : '✏️ แก้ไข';
    });
    const cancel = body.querySelector('#sup-hr-cancel');
    if (cancel) cancel.addEventListener('click', closeForm);
    const save = body.querySelector('#sup-hr-save');
    if (save) save.addEventListener('click', async () => {
      const nm = body.querySelector('#sup-hr-name-in').value.trim();
      const eid = body.querySelector('#sup-hr-empid-in').value.trim();
      const msg = body.querySelector('#sup-hr-msg');
      save.disabled = true;
      try {
        const r = await fetchJson(`/api/member/${memberId}/hr`, { method: 'PATCH', body: JSON.stringify({ hr_name: nm, hr_employee_id: eid }) });
        p.hr_name = r.hr_name; p.hr_employee_id = r.hr_employee_id;
        body.querySelector('#sup-hr-name').innerHTML = r.hr_name ? escapeHtml(r.hr_name) : _dash;
        body.querySelector('#sup-hr-empid').innerHTML = r.hr_employee_id ? escapeHtml(r.hr_employee_id) : _dash;
        msg.style.display = ''; msg.style.color = 'var(--green)'; msg.textContent = '✓ บันทึกแล้ว';
        setTimeout(() => { closeForm(); msg.style.display = 'none'; }, 800);
      } catch (e) {
        msg.style.display = ''; msg.style.color = 'var(--critical)'; msg.textContent = '❌ ' + e.message;
      } finally { save.disabled = false; }
    });
  }
}
// v1.9.385 — แท็บประวัติการลาใน slide-out: ดึงจาก _absData (โหลดที่ Absence) จับคู่ด้วย hr_employee_id
async function loadSupLeave(body, profile) {
  const box = body.querySelector('[data-sup-pane-body="leave"]');
  if (!box) return;
  const empId = profile.hr_employee_id;
  // v1.9.395 — ถ้าเซสชันยังไม่มีข้อมูล ลองโหลด snapshot ที่เก็บไว้ในเซิร์ฟเวอร์ (ดูได้เลยไม่ต้องดึงใหม่)
  if ((typeof _absData === 'undefined' || !_absData || !_absData.length) && typeof _absLoadSnapshot === 'function') {
    box.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-muted);font-size:12.5px">⏳ กำลังโหลดข้อมูลการลาที่เก็บไว้…</div>';
    await _absLoadSnapshot(false);
  }
  if (typeof _absData === 'undefined' || !_absData || !_absData.length) {
    box.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-muted);font-size:12.5px">⚠️ ยังไม่มีข้อมูลการลาที่เก็บไว้ — ไปที่ <strong>My Profile → Absence</strong> แล้วกด “ดึงข้อมูลใหม่” ก่อน</div>';
    return;
  }
  if (!empId) {
    box.innerHTML = '<div class="empty" style="padding:20px;color:var(--text-muted);font-size:12.5px">⚠️ ยังไม่ได้ตั้ง <strong>รหัสพนักงาน (HR)</strong> ของคนนี้ — กดแก้ไขในแท็บ Profile ก่อน</div>';
    return;
  }
  const entries = _absEntriesForEmp(empId);
  if (!entries.length) {
    box.innerHTML = `<div class="empty" style="padding:20px;color:var(--text-muted);font-size:12.5px">— ไม่พบการลาที่ตรงกับรหัสพนักงาน <strong>${escapeHtml(empId)}</strong> ในปี 2026 —</div>`;
    return;
  }
  _supRenderLeaveCal(box, entries, empId);
}
let _supLeaveYM = '';
function _supRenderLeaveCal(box, entries, empId) {
  const months = [...new Set(entries.map(e => e.ym))].sort();
  if (!_supLeaveYM || !months.includes(_supLeaveYM)) _supLeaveYM = months[months.length - 1];
  const idx = months.indexOf(_supLeaveYM);
  const [Y, M] = _supLeaveYM.split('-').map(Number);
  const daysIn = new Date(Y, M, 0).getDate();
  const firstDow = new Date(Y, M - 1, 1).getDay();
  const _now = new Date();
  const todayD = (_now.getFullYear() === Y && _now.getMonth() + 1 === M) ? _now.getDate() : 0;
  const byDay = new Map();
  entries.filter(e => e.ym === _supLeaveYM).forEach(e => { if (!byDay.has(e.day)) byDay.set(e.day, []); byDay.get(e.day).push(e); });
  const MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const dow = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += `<div style="background:var(--bg-soft);border-radius:6px;min-height:46px;opacity:.35"></div>`;
  for (let d = 1; d <= daysIn; d++) {
    const arr = byDay.get(d) || [];
    const isToday = d === todayD;
    const cancel = arr.length && arr.every(e => e.kind === 'cancel');
    const bg = arr.length ? (cancel ? 'rgba(220,38,38,.10)' : 'rgba(16,185,129,.14)') : (isToday ? 'rgba(37,99,235,.08)' : 'var(--bg-card)');
    cells += `<div title="${escapeHtml(arr.map(e => (e.kind === 'cancel' ? 'ยกเลิก: ' : '') + (e.leaveType || 'ลา')).join(', '))}" style="background:${bg};border:1px solid ${isToday ? 'var(--primary)' : 'var(--border)'};border-radius:6px;min-height:46px;padding:3px 4px;display:flex;flex-direction:column;overflow:hidden">
      <span style="font-size:10px;font-weight:700;color:${isToday ? 'var(--primary)' : 'var(--text-muted)'}">${d}</span>
      ${arr.length ? `<span style="font-size:9px;line-height:1.2;margin-top:1px;color:${cancel ? 'var(--critical)' : 'var(--green)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cancel ? '❌' : _absLeaveIcon(arr[0].leaveType)} ${escapeHtml(arr[0].leaveType || 'ลา')}</span>` : ''}
    </div>`;
  }
  const total = entries.filter(e => e.kind !== 'cancel').length;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px">
        <button class="btn" id="sup-lv-prev" ${idx <= 0 ? 'disabled' : ''} style="font-size:12px;padding:4px 9px">◀</button>
        <span style="font-size:14px;font-weight:800;min-width:92px;text-align:center">${MON[M - 1]} ${Y}</span>
        <button class="btn" id="sup-lv-next" ${idx >= months.length - 1 ? 'disabled' : ''} style="font-size:12px;padding:4px 9px">▶</button>
      </div>
      <span style="font-size:11.5px;color:var(--text-muted)">รหัส ${escapeHtml(empId)} · รวม ${total} วันลา</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px">${dow.map(x => `<div style="text-align:center;font-size:10px;font-weight:700;color:var(--text-muted)">${x}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">${cells}</div>`;
  const nav = (delta) => { const ni = idx + delta; if (ni < 0 || ni >= months.length) return; _supLeaveYM = months[ni]; _supRenderLeaveCal(box, entries, empId); };
  box.querySelector('#sup-lv-prev').onclick = () => nav(-1);
  box.querySelector('#sup-lv-next').onclick = () => nav(1);
}

// v1.9.123 — Peoples: หน้าเดียวมีเมนูย่อย 2-column (รายชื่อ Members / Teams / Access Requests) แบบ Profile
async function renderPeoplesPage(activeTab, teamId) {
  activeTab = activeTab || 'members';
  const item = (tab, ico, label, extra) => `
    <a href="#/${tab}" class="acc-menu-item${activeTab === tab ? ' active' : ''}" style="text-decoration:none">
      <span class="acc-menu-ico">${ico}</span> ${label}${extra || ''}
    </a>`;
  $('main').innerHTML = `
    <div class="page-head"><h2 class="page-title">👥 Peoples</h2></div>
    <div class="acc-layout">
      <div class="acc-menu">
        ${item('members', '👥', 'รายชื่อ Members')}
        ${item('teams', '👨‍👩‍👧', 'Teams')}
        ${item('access-requests', '📨', 'Access Requests', ' <span id="peoples-req-badge" style="display:none;margin-left:auto;background:var(--critical);color:#fff;font-size:10.5px;padding:1px 7px;border-radius:999px;font-weight:700"></span>')}
      </div>
      <div class="acc-detail"><div id="peoples-detail">${skelStack(5)}</div></div>
    </div>
  `;
  const mount = $('peoples-detail');
  if (activeTab === 'teams') await renderTeamsPage(teamId || null, mount);
  else if (activeTab === 'access-requests') await renderAccessRequestsPage(mount);
  else await renderMembersPage(mount);
  if (typeof refreshAccessRequestBadge === 'function') refreshAccessRequestBadge();
}

async function renderMembersPage(mount) {
  mount = mount || $('peoples-detail') || $('main');  // v1.9.123 — render ลง container อื่นได้ (Peoples tab)
  mount.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">👥 Members</h2>
      <span class="card-sub" id="m-count">—</span>
      <button class="btn" id="m-beacon-all-btn" style="margin-left:auto;font-size:13px;padding:7px 14px;background:rgba(245,158,11,.10);color:#92400e;border-color:rgba(245,158,11,.30)" title="ลองอ่าน check-in ของทุกคนด้วย Wazzup token ของคุณ">📍 Check-in ทุกคน</button>
    </div>

    <!-- Recent members bubbles (top, scrollable) -->
    <div style="margin-bottom:18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <h3 style="margin:0;font-size:13px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em">🆕 Member ใหม่ล่าสุด</h3>
        <span style="font-size:11.5px;color:var(--text-soft)">— เรียงจากล่าสุด · คลิก bubble เพื่อดูสถิติ</span>
      </div>
      <div id="m-bubbles" style="display:flex;gap:14px;overflow-x:auto;padding:6px 4px 12px;scroll-behavior:smooth">
        <div class="empty" style="flex:1;font-size:13px">กำลังโหลด…</div>
      </div>
    </div>

    <!-- Filters -->
    <div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap">
      <div style="position:relative">
        <input id="m-search" type="text" placeholder="🔍 ค้นหา member (ชื่อ / email / เบอร์)..." autocomplete="off"
               style="width:100%;padding:9px 14px;font-size:13.5px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text)" />
        <span id="m-search-clear" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);cursor:pointer;color:var(--text-muted);display:none;padding:4px 8px;border-radius:6px">×</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <label style="font-size:13px;color:var(--text-muted);font-weight:500">ทีม:</label>
        <select id="m-team-filter" style="padding:9px 12px;font-size:13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text);min-width:200px">
          <option value="">— ทุกคน —</option>
          <option value="__none__">🚫 ยังไม่มีทีม</option>
        </select>
      </div>
    </div>
    <div id="m-filter-info" style="font-size:12px;color:var(--text-muted);margin-bottom:8px"></div>
    <div id="m-list">
      ${skelStack(6)}
    </div>
  `;
  const beaconAllBtn = $('m-beacon-all-btn');
  if (beaconAllBtn) beaconAllBtn.addEventListener('click', showBeaconAllModal);
  await loadMembersList();
}

// v1.9.117 — admin: ลองอ่าน check-in ทุกคน (ใช้ Wazzup token ของ admin)
async function showBeaconAllModal() {
  const token = getWazzupToken();
  if (!token) {
    alert('ต้อง login ด้วย Wazzup ในเซสชันนี้ก่อน (token จะถูกใช้เรียก Beacon API)\n\nไปที่ /login → Wazzup SSO หรือ บัญชีของฉัน → Link Account → Add Wazzup');
    return;
  }
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide" style="max-height:88vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">
        <h3 style="margin:0;font-size:17px;font-weight:700">📍 Check-in ทุกคน (ทดสอบ)</h3>
        <button class="btn" id="ba-close" style="font-size:13px;padding:6px 12px">✕ ปิด</button>
      </div>
      <div id="ba-summary" style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px">กำลังเรียก Beacon API ของทุกคน…</div>
      <div id="ba-list"></div>
    </div>`;
  document.body.appendChild(bg);
  bg.querySelector('#ba-close').addEventListener('click', () => bg.remove());
  bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });

  const fmtEpoch = ms => { if (ms == null) return '—'; try { return new Date(Number(ms)).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ms); } };
  const fmtIso = iso => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); } };
  const statusLabel = {
    ok: '', forbidden: '<span style="color:#92400e">🔒 ไม่มีสิทธิ์ (403)</span>',
    notfound: '<span style="color:var(--text-muted)">ไม่พบใน Beacon (404)</span>',
    unauthorized: '<span style="color:var(--critical)">token หมดอายุ (401)</span>',
    error: '<span style="color:var(--critical)">error</span>',
  };

  try {
    const r = await fetchJson('/api/admin/beacon-all', { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
    const sumParts = Object.entries(r.summary || {}).map(([k, v]) => `${statusLabel[k] ? k : k}: ${v}`);
    bg.querySelector('#ba-summary').innerHTML =
      `ทั้งหมด ${r.count} คน · ` + Object.entries(r.summary || {}).map(([k, v]) => `<strong>${k}</strong> ${v}`).join(' · ') +
      `<br><span style="color:var(--text-muted)">ถ้าเห็น <strong>forbidden</strong> เยอะ = token อ่านได้แค่ตัวเอง (API ไม่อนุญาตอ่านคนอื่น)</span>`;
    const list = bg.querySelector('#ba-list');
    if (!r.results || r.results.length === 0) {
      list.innerHTML = '<div class="empty">ไม่มี member ที่ผูก Wazzup empCode</div>';
      return;
    }
    list.innerHTML = r.results.map(m => {
      const initial = (m.display_name || m.email || '?').trim().charAt(0).toUpperCase();
      const avatar = m.avatar_data
        ? `<img src="${m.avatar_data}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
        : `<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:14px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
      let info;
      if (m.status === 'ok') {
        const t = m.checkInToday, l = m.checkInLastTime;
        if (t) {
          info = `<span style="color:var(--green);font-weight:600">📍 ${escapeHtml(t.locationName || '—')}</span> · ${escapeHtml(t.type || '')} · ${escapeHtml(fmtEpoch(t.timestamp))}`;
        } else if (l) {
          info = `<span style="color:var(--text-muted)">ล่าสุด: 📍 ${escapeHtml(l.checkInLocation || '—')} · ${escapeHtml(fmtIso(l.checkInAtThailandTime || l.checkInAt))}</span>`;
        } else {
          info = '<span style="color:var(--text-muted)">ยังไม่มี check-in</span>';
        }
      } else {
        info = statusLabel[m.status] || escapeHtml(m.status);
      }
      return `
        <div style="display:flex;align-items:center;gap:11px;padding:9px 10px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px">
          ${avatar}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13.5px">${escapeHtml(m.display_name || m.email || '(ไม่มีชื่อ)')} <span style="font-size:11px;color:var(--text-soft);font-weight:400">· ${escapeHtml(m.emp_code)}</span></div>
            <div style="font-size:12px;margin-top:2px">${info}</div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    bg.querySelector('#ba-summary').innerHTML = `<span style="color:var(--critical)">❌ ${escapeHtml(e.message)}</span>`;
  }
}

function fmtMemberJoinTimeAdmin(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yest = new Date(today.getTime() - 86400000);
  const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const time = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  if (dDay.getTime() === today.getTime()) return `วันนี้ ${time}`;
  if (dDay.getTime() === yest.getTime()) return `เมื่อวาน ${time}`;
  const monthShort = d.toLocaleDateString('th-TH', { month: 'short' });
  return `${d.getDate()} ${monthShort} ${time}`;
}

function renderMemberBubbles(members) {
  const wrap = $('m-bubbles');
  if (!wrap) return;
  // เรียงจากล่าสุด — created_at DESC
  const recent = members.slice()
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, 30);
  if (recent.length === 0) {
    wrap.innerHTML = `<div class="empty" style="flex:1;font-size:13px;padding:18px">ยังไม่มี member</div>`;
    return;
  }
  wrap.innerHTML = recent.map(m => {
    const display = m.display_name || m.email || m.phone || '?';
    const initial = display.trim().charAt(0).toUpperCase();
    const safeName = escapeHtml(display);
    const avatar = m.avatar_data
      ? `<img src="${m.avatar_data}" alt="${safeName}" style="width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--bg-card);box-shadow:var(--shadow-sm);transition:transform .15s,box-shadow .15s" />`
      : `<div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:22px;display:inline-flex;align-items:center;justify-content:center;border:2px solid var(--bg-card);box-shadow:var(--shadow-sm);transition:transform .15s,box-shadow .15s">${escapeHtml(initial)}</div>`;
    const joinedTxt = fmtMemberJoinTimeAdmin(m.created_at);
    return `
      <div class="m-bubble" data-act="stats" data-id="${m.id}" data-name="${safeName}"
           style="flex:0 0 96px;text-align:center;cursor:pointer" title="คลิกดูสถิติของ ${safeName}">
        ${avatar}
        <div style="margin-top:8px;font-size:12.5px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:96px">${escapeHtml(display)}</div>
        ${m.is_temp
          ? `<div title="${escapeHtml(m.temp_department || 'พนักงานชั่วคราว')}" style="font-size:9.5px;color:#92400e;background:rgba(245,158,11,.15);border-radius:999px;padding:1px 7px;display:inline-block;margin-top:3px;font-weight:700">🕓 ชั่วคราว</div>`
          : `<div style="font-size:10.5px;color:var(--text-muted);margin-top:1px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:96px">${escapeHtml(joinedTxt)}</div>`}
      </div>
    `;
  }).join('');

  // Hover + click
  wrap.querySelectorAll('.m-bubble').forEach(b => {
    const img = b.querySelector('img, div[style*="border-radius:50%"]');
    b.addEventListener('mouseenter', () => {
      if (img) {
        img.style.transform = 'scale(1.06)';
        img.style.boxShadow = '0 6px 18px rgba(37,99,235,.25)';
      }
    });
    b.addEventListener('mouseleave', () => {
      if (img) {
        img.style.transform = '';
        img.style.boxShadow = 'var(--shadow-sm)';
      }
    });
    b.addEventListener('click', () => handleMemberAction(b));
  });
}

// State สำหรับ filter
let _membersCache = [];
let _teamsCache = [];

function applyMemberFilter() {
  const filterEl = $('m-team-filter');
  const searchEl = $('m-search');
  const clearBtn = $('m-search-clear');
  if (!filterEl) return;
  const filter = filterEl.value;
  const q = (searchEl ? searchEl.value : '').toLowerCase().trim();
  if (clearBtn) clearBtn.style.display = q ? '' : 'none';

  // Step 1: filter ตามทีม
  let filtered;
  if (filter === '') {
    filtered = _membersCache;
  } else if (filter === '__none__') {
    filtered = _membersCache.filter(m => !m.teams || m.teams.length === 0);
  } else {
    const teamId = parseInt(filter, 10);
    filtered = _membersCache.filter(m => (m.teams || []).some(t => t.id === teamId));
  }

  // Step 2: filter ตาม search query (ชื่อ / email / phone)
  if (q) {
    filtered = filtered.filter(m => {
      const hay = ((m.display_name || '') + ' ' + (m.email || '') + ' ' + (m.phone || '')).toLowerCase();
      return hay.includes(q);
    });
  }

  renderMembersTable(filtered);

  const total = _membersCache.length;
  // v1.9.263 — นับจำนวนพนักงาน ไม่รวม Alumni
  const alumniN = _membersCache.filter(m => m.is_alumni).length;
  const employees = total - alumniN;
  let count;
  if (filter || q) {
    count = `${filtered.length} / ${total} คน`;
  } else {
    count = `รวม ${employees} คน` + (alumniN ? ` · 🎓 ${alumniN} alumni` : '');
  }
  $('m-count').textContent = count;

  const info = $('m-filter-info');
  if (info) {
    const parts = [];
    if (filter === '__none__') parts.push('🚫 ยังไม่มีทีม');
    else if (filter) {
      const t = _teamsCache.find(tt => tt.id === parseInt(filter, 10));
      if (t) parts.push(`ทีม: ${t.name}`);
    }
    if (q) parts.push(`ค้นหา: "${q}"`);
    info.textContent = parts.length ? '— filter: ' + parts.join(', ') : '';
  }
}

function fmtMemberDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
// v1.9.151 — จำนวนวันถึงวันเกิดถัดไป (0 = เกิดวันนี้, null = ไม่มี/รูปแบบผิด)
function _daysUntilBirthday(birthdate) {
  if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(birthdate)) return null;
  const parts = birthdate.split('-');
  const bm = parseInt(parts[1], 10), bd = parseInt(parts[2], 10);
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), bm - 1, bd);
  if (next < today) next = new Date(now.getFullYear() + 1, bm - 1, bd);
  return Math.round((next - today) / 86400000);
}

// v1.9.273 — Birthday Calendar (ปฏิทินวันเกิดสมาชิกทีม)
let _bdayCalView = null;
function _bdayAvatar(m, px) {
  px = px || 30;
  return m.avatar
    ? `<img src="${m.avatar}" alt="" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover;border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.18)" />`
    : `<span style="width:${px}px;height:${px}px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:${Math.round(px * 0.42)}px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;border:1.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.18)">${escapeHtml((String(m.name).trim().charAt(0) || '?').toUpperCase())}</span>`;
}
function showBirthdayCalendar(members) {
  const now = new Date();
  _bdayCalView = { year: now.getFullYear(), month: now.getMonth() };
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="max-width:1080px;width:96vw;padding:0;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:15px 22px;border-bottom:1px solid var(--border)">
      <h3 style="margin:0;font-size:17px;font-weight:800">🎂 Birthday Calendar</h3>
      <button class="btn" id="bcal-close" style="font-size:13px;padding:6px 14px">✕ ปิด</button>
    </div>
    <div id="bcal-root" style="padding:18px 22px 24px"></div>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#bcal-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  const render = () => _renderBirthdayCal(bg.querySelector('#bcal-root'), members, render);
  render();
}
function _renderBirthdayCal(root, members, rerender) {
  const { year, month } = _bdayCalView;
  const MONTHS = (typeof _MONTHS_TH !== 'undefined' && _MONTHS_TH.length === 12) ? _MONTHS_TH : ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  const DOW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  const parsed = members.map(m => { const p = (m.birthdate || '').split('-'); return { ...m, bm: parseInt(p[1], 10), bd: parseInt(p[2], 10) }; })
    .filter(m => m.bm >= 1 && m.bm <= 12 && m.bd >= 1 && m.bd <= 31);
  const inMonth = parsed.filter(m => m.bm === month + 1);
  const byDay = {};
  inMonth.forEach(m => { (byDay[m.bd] = byDay[m.bd] || []).push(m); });
  const now = new Date();
  const isThisMonth = now.getFullYear() === year && now.getMonth() === month;
  const todayD = now.getDate();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += `<div style="min-height:80px;background:var(--bg-soft);opacity:.45"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const bs = byDay[d] || [];
    const isToday = isThisMonth && d === todayD;
    const ppl = bs.slice(0, 3).map(m => `<div style="display:flex;align-items:center;gap:4px;min-width:0" title="${escapeHtml(m.name)}">${_bdayAvatar(m, 19)}<span style="font-size:10px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.name)}</span></div>`).join('');
    const more = bs.length > 3 ? `<span style="font-size:9.5px;color:#be185d;font-weight:700">+${bs.length - 3} คน</span>` : '';
    cells += `<div style="min-height:88px;padding:5px 6px;background:${bs.length ? 'rgba(236,72,153,.06)' : 'var(--bg-card)'};${isToday ? 'box-shadow:inset 0 0 0 2px var(--primary)' : ''}">
      <div style="font-size:12px;font-weight:${isToday ? 800 : 600};color:${isToday ? 'var(--primary)' : 'var(--text)'}">${d}</div>
      <div style="display:flex;flex-direction:column;gap:2px;margin-top:3px;min-width:0">${ppl}${more}</div>
    </div>`;
  }
  // v1.9.276 — แสดงทุกคน เรียงจากใกล้สุด → ไกลสุด (เลื่อนดูได้)
  const upcoming = parsed.map(m => ({ ...m, du: _daysUntilBirthday(m.birthdate) })).filter(m => m.du != null).sort((a, b) => a.du - b.du);
  const upHtml = upcoming.map(m => `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
    ${_bdayAvatar(m, 34)}
    <div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.name)}</div><div style="font-size:11px;color:var(--text-muted)">${m.bd} ${MONTHS[m.bm - 1]} · ${m.du === 0 ? '<span style="color:#be185d;font-weight:700">วันนี้ 🎉</span>' : 'ใน ' + m.du + ' วัน'}</div></div>
    ${m.team ? `<span style="font-size:10.5px;background:rgba(37,99,235,.08);color:var(--primary);padding:3px 10px;border-radius:999px;white-space:nowrap;flex-shrink:0;font-weight:500">${escapeHtml(m.team)}</span>` : ''}
  </div>`).join('') || '<div style="font-size:12.5px;color:var(--text-muted);padding:10px 0;font-style:italic">— ไม่มีข้อมูลวันเกิด —</div>';

  root.innerHTML = `
    <div style="display:flex;gap:22px;flex-wrap:wrap">
      <div style="flex:2;min-width:340px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
          <div><div style="font-size:18px;font-weight:800">${MONTHS[month]} ${year + 543}</div><div style="font-size:12px;color:var(--text-muted)">🎂 มีวันเกิด ${inMonth.length} คนในเดือนนี้</div></div>
          <div style="display:flex;gap:6px;flex-shrink:0"><button class="btn" data-bcal-nav="-1" style="font-size:14px;padding:5px 12px">‹</button><button class="btn" data-bcal-nav="today" style="font-size:13px;padding:5px 13px">วันนี้</button><button class="btn" data-bcal-nav="1" style="font-size:14px;padding:5px 12px">›</button></div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:10px;overflow:hidden">
          ${DOW.map(d => `<div style="text-align:center;font-size:11px;font-weight:700;color:var(--text-muted);padding:8px 0;background:var(--bg-soft)">${d}</div>`).join('')}
          ${cells}
        </div>
      </div>
      <div style="flex:1;min-width:230px;display:flex;flex-direction:column;min-height:0">
        <div style="font-size:13px;font-weight:800;margin-bottom:8px;flex-shrink:0">🎈 วันเกิดที่กำลังมาถึง <span style="color:var(--text-muted);font-weight:500">(${upcoming.length})</span></div>
        <div style="overflow-y:auto;max-height:62vh;padding-right:4px">${upHtml}</div>
      </div>
    </div>`;
  root.querySelectorAll('[data-bcal-nav]').forEach(b => b.addEventListener('click', () => {
    const nav = b.dataset.bcalNav;
    if (nav === 'today') { const n = new Date(); _bdayCalView = { year: n.getFullYear(), month: n.getMonth() }; }
    else { let mo = _bdayCalView.month + parseInt(nav, 10), yr = _bdayCalView.year; if (mo < 0) { mo = 11; yr--; } if (mo > 11) { mo = 0; yr++; } _bdayCalView = { year: yr, month: mo }; }
    rerender();
  }));
}

async function loadMembersList() {
  let data, teamsData;
  try {
    [data, teamsData] = await Promise.all([
      fetchJson('/api/admin/members'),
      fetchJson('/api/admin/teams'),
    ]);
  } catch (e) {
    $('m-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _membersCache = data.members || [];
  _teamsCache = teamsData.teams || [];

  // populate team filter dropdown
  const filterEl = $('m-team-filter');
  if (filterEl) {
    const currentVal = filterEl.value;
    // เก็บ default options + เพิ่ม teams
    filterEl.innerHTML = `
      <option value="">— ทุกคน (default) —</option>
      <option value="__none__">🚫 ยังไม่มีทีม</option>
      ${_teamsCache.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${t.member_count})</option>`).join('')}
    `;
    if (currentVal) filterEl.value = currentVal;   // restore selection
    // v1.9.153 — deep-link filter (เช่นจาก dashboard: คนยังไม่มีทีม)
    try {
      const pf = sessionStorage.getItem('m_pending_filter');
      if (pf !== null) { sessionStorage.removeItem('m_pending_filter'); filterEl.value = pf; }
    } catch {}
    // wire change handler (idempotent — ใส่ใหม่ทุก load)
    filterEl.onchange = applyMemberFilter;
  }

  // wire search input + clear button
  const searchEl = $('m-search');
  if (searchEl) searchEl.oninput = applyMemberFilter;
  const clearBtn = $('m-search-clear');
  if (clearBtn) clearBtn.onclick = () => {
    if (searchEl) { searchEl.value = ''; searchEl.focus(); }
    applyMemberFilter();
  };

  if (_membersCache.length === 0) {
    $('m-list').innerHTML = `<div class="empty">ยังไม่มี member ในระบบ — สมัครได้ที่ <a href="/login" target="_blank" style="color:var(--primary)">/login</a></div>`;
    $('m-count').textContent = '0 คน';
    renderMemberBubbles([]);
    return;
  }

  renderMemberBubbles(_membersCache);   // bubble row บนสุด (ไม่ filter)
  applyMemberFilter();                   // render table ด้านล่าง (ใช้ filter)
}

// v1.9.313 — Members list: Landing-Folio style row layout (avatar + name/handle · Active pill · Role · Email · Team tags · chevron)
// แต่ละแถวยังคงคลิกได้เพื่อเปิด slide-out panel (openMemberPanel) เหมือนเดิม
const _TEAM_TAG_PALETTE = [
  { bg: 'rgba(168,85,247,.10)', fg: '#7e22ce', bd: 'rgba(168,85,247,.25)' },  // purple
  { bg: 'rgba(37,99,235,.10)',  fg: '#1d4ed8', bd: 'rgba(37,99,235,.25)'  },  // blue
  { bg: 'rgba(245,158,11,.12)', fg: '#b45309', bd: 'rgba(245,158,11,.25)' },  // amber
  { bg: 'rgba(16,185,129,.10)', fg: '#047857', bd: 'rgba(16,185,129,.25)' },  // emerald
  { bg: 'rgba(236,72,153,.10)', fg: '#be185d', bd: 'rgba(236,72,153,.25)' },  // pink
  { bg: 'rgba(14,165,233,.10)', fg: '#0369a1', bd: 'rgba(14,165,233,.25)' },  // sky
];
function _teamTagStyle(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return _TEAM_TAG_PALETTE[h % _TEAM_TAG_PALETTE.length];
}

function renderMembersTable(members) {
  if (members.length === 0) {
    $('m-list').innerHTML = `<div class="empty">ไม่เจอ member ที่ตรงกับ filter</div>`;
    return;
  }

  $('m-list').innerHTML = `
    <div style="overflow-x:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-sm)">
      <table class="members-table">
        <thead>
          <tr>
            <th style="width:30%">Name</th>
            <th style="width:11%">Status</th>
            <th style="width:11%">Role</th>
            <th style="width:22%">Email address</th>
            <th style="width:22%">Teams</th>
            <th style="width:4%"></th>
          </tr>
        </thead>
        <tbody id="m-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = $('m-tbody');
  tbody.innerHTML = members.map(m => {
    const display = m.display_name || m.email || m.phone || '—';
    const initial = (display || '?').trim().charAt(0).toUpperCase();
    const handle = m.email
      ? '@' + (m.email.split('@')[0] || m.email)
      : (m.phone ? '📞 ' + m.phone : '');

    // === Avatar (round) ===
    const avatar = m.avatar_data
      ? `<img src="${m.avatar_data}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
      : `<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:15px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;

    const nameCell = `
      <div style="display:flex;gap:12px;align-items:center">
        ${avatar}
        <div style="min-width:0;overflow:hidden">
          <div style="font-weight:600;font-size:14px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.display_name || '(ไม่ได้ตั้งชื่อ)')}</div>
          <div style="font-size:12.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(handle)}</div>
        </div>
      </div>
    `;

    // === Status (Active / Disabled pill with dot) ===
    const statusCell = m.enabled
      ? `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:rgba(16,185,129,.10);color:var(--green);border:1px solid rgba(16,185,129,.20)">
           <span style="width:6px;height:6px;border-radius:50%;background:var(--green);display:inline-block"></span>Active
         </span>`
      : `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:rgba(220,38,38,.10);color:var(--critical);border:1px solid rgba(220,38,38,.20)">
           <span style="width:6px;height:6px;border-radius:50%;background:var(--critical);display:inline-block"></span>Disabled
         </span>`;

    // === Role (Admin / Member) ===
    const roleCell = m.is_admin
      ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--text);font-weight:600">👑 Admin</span>`
      : `<span style="font-size:13px;color:var(--text-muted)">Member</span>`;

    // === Email column ===
    const emailCell = m.email
      ? `<div style="font-size:13px;color:var(--text);font-family:ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(m.email)}">${escapeHtml(m.email)}</div>${m.phone ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">📞 ${escapeHtml(m.phone)}</div>` : ''}`
      : (m.phone ? `<div style="font-size:13px;color:var(--text);font-family:ui-monospace,Menlo,monospace">📞 ${escapeHtml(m.phone)}</div>` : `<span style="color:var(--text-muted);font-size:12px;font-style:italic">—</span>`);

    // === Teams (colored chips, max 3 + "+N") ===
    const teams = m.teams || [];
    let teamsCell;
    if (teams.length === 0) {
      teamsCell = `<span style="color:var(--text-muted);font-size:12px;font-style:italic">— ยังไม่มีทีม —</span>`;
    } else {
      const visible = teams.slice(0, 3);
      const more = teams.length - visible.length;
      const chips = visible.map(t => {
        const s = _teamTagStyle(t.name || '');
        return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:500;background:${s.bg};color:${s.fg};border:1px solid ${s.bd}">${escapeHtml(t.name)}</span>`;
      }).join('');
      const moreChip = more > 0
        ? `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:500;background:var(--bg-soft);color:var(--text-muted);border:1px solid var(--border)" title="${escapeHtml(teams.slice(3).map(t => t.name).join(', '))}">+${more}</span>`
        : '';
      teamsCell = `<div style="display:flex;flex-wrap:wrap;gap:4px;line-height:1.4">${chips}${moreChip}</div>`;
    }

    // === Chevron (visual cue ว่าคลิกได้ → slide-out) ===
    const chevronCell = `<span style="color:var(--text-muted);font-size:18px;display:inline-block">›</span>`;

    return `
      <tr data-id="${m.id}" class="m-row-click" style="cursor:pointer">
        <td>${nameCell}</td>
        <td>${statusCell}</td>
        <td>${roleCell}</td>
        <td>${emailCell}</td>
        <td>${teamsCell}</td>
        <td style="text-align:right">${chevronCell}</td>
      </tr>
    `;
  }).join('');

  const _mById = new Map(members.map(m => [String(m.id), m]));
  tbody.querySelectorAll('tr[data-id]').forEach(tr => {
    tr.addEventListener('click', () => { const m = _mById.get(tr.dataset.id); if (m) openMemberPanel(m); });
  });
}

// v1.9.140 — เมนู overflow ของ member (⋮ เพิ่มเติม) — render ลง body กัน table clip
// v1.9.149 — เมนู ⋮ เพิ่มเติม → slide-out panel จากด้านขวา (ใช้สไตล์ .sup-panel)
let _memberMenu = null;
function _removeMemberMenu() {
  if (!_memberMenu) return;
  document.removeEventListener('keydown', _memberMenu.onKey);
  try { _memberMenu.wrap.remove(); } catch {}
  _memberMenu = null;
}
function closeMemberMenu() {
  if (!_memberMenu) return;
  const wrap = _memberMenu.wrap, onKey = _memberMenu.onKey;
  wrap.classList.remove('is-open');
  document.removeEventListener('keydown', onKey);
  _memberMenu = null;
  setTimeout(() => { try { wrap.remove(); } catch {} }, 280);   // รอ transition จบ
}
// v1.9.150 — คลิกแถว member → slide-out panel จัดเป็น tab (ข้อมูล / จัดการ)
function openMemberPanel(m) {
  _removeMemberMenu();
  const name = m.display_name || m.email || m.phone || '—';
  const safeName = escapeHtml(m.display_name || m.email || m.phone || '');
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  const av = m.avatar_data
    ? `<img src="${m.avatar_data}" alt="" style="width:64px;height:64px;border-radius:14px;object-fit:cover;flex-shrink:0" />`
    : `<div style="width:64px;height:64px;border-radius:14px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:26px;display:flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
  const pill = (bg, fg, txt) => `<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:${bg};color:${fg}">${txt}</span>`;
  const roleBadge = m.is_admin ? pill('linear-gradient(135deg,rgba(37,99,235,.15),rgba(124,58,237,.15))', 'var(--primary-dark)', '👑 Admin') : pill('var(--bg-soft)', 'var(--text-muted)', 'Member');
  const pwBadge = m.has_password ? pill('rgba(16,185,129,.10)', 'var(--green)', '🔐 มี pw') : pill('rgba(245,158,11,.10)', '#92400e', '⚠ ไม่มี pw');
  const enabledBadge = m.enabled ? pill('rgba(16,185,129,.10)', 'var(--green)', '✓ ใช้งาน') : pill('rgba(220,38,38,.10)', 'var(--critical)', '⛔ ระงับ');
  const methodMap = {
    phone:    { icon: '📱', bg: 'rgba(37,99,235,.10)',  fg: 'var(--primary)' },
    email_pw: { icon: '🔑', bg: 'rgba(16,185,129,.10)', fg: 'var(--green)' },
    wazzup:   { icon: '🏢', bg: 'rgba(245,158,11,.12)', fg: '#92400e' },
  };
  const loginChips = (m.login_methods || []).map(it => { const mm = methodMap[it.kind]; if (!mm) return ''; return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;background:${mm.bg};color:${mm.fg}">${mm.icon} ${escapeHtml(it.label || '')}</span>`; }).join('') || '<span style="color:var(--text-muted)">—</span>';
  const teamChips = (m.teams && m.teams.length) ? m.teams.map(t => `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:500;background:rgba(37,99,235,.10);color:var(--primary);border:1px solid rgba(37,99,235,.20)">${escapeHtml(t.name)}</span>`).join('') : '<span style="color:var(--text-muted);font-style:italic">— ยังไม่มีทีม —</span>';
  const ext = m.extension_version ? `🧩 v${escapeHtml(m.extension_version)}${m.extension_last_used_at ? ' · ใช้ล่าสุด ' + escapeHtml(fmtRelativeTh(m.extension_last_used_at)) : ''}` : 'ยังไม่เคยใช้';
  const lastLogin = m.last_login_at ? fmtMemberDate(m.last_login_at) : 'ยังไม่เคยเข้าระบบ';

  const infoPane = `
    <div style="display:grid;grid-template-columns:118px 1fr;gap:11px 14px;font-size:13.5px">
      <div style="color:var(--text-muted)">เบอร์มือถือ</div><div>${m.phone ? '📞 ' + escapeHtml(m.phone) : '—'}</div>
      <div style="color:var(--text-muted)">อีเมล</div><div style="word-break:break-all">${m.email ? `${escapeHtml(m.email)} <button type="button" class="mp-copy" data-copy="${escapeHtml(m.email)}" title="คัดลอกอีเมล" style="border:none;background:none;cursor:pointer;font-size:12.5px;padding:0 3px;color:var(--text-soft);vertical-align:baseline">📋</button>` : '—'}</div>
      <div style="color:var(--text-muted)">เข้าระบบล่าสุด</div><div>${escapeHtml(lastLogin)}</div>
      <div style="color:var(--text-muted)">Extension</div><div>${ext}</div>
      <div style="color:var(--text-muted)">ทีม</div><div style="display:flex;flex-wrap:wrap;gap:4px">${teamChips}</div>
      <div style="color:var(--text-muted)">วิธี login</div><div style="display:flex;flex-wrap:wrap;gap:4px">${loginChips}</div>
    </div>
    <button id="mp-stats-btn" class="btn" style="margin-top:18px;font-size:13px;padding:9px 14px">📊 ดูสถิติการใช้ Platform</button>`;

  const aStyle = (danger) => `display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:1px solid var(--border);background:var(--bg-card);text-align:left;font-size:13.5px;cursor:pointer;border-radius:9px;color:${danger ? 'var(--critical)' : 'var(--text)'};font-family:inherit`;
  const aBtn = (act, label, extra, danger) => `<button class="m-act-btn" data-act="${act}" data-id="${m.id}" data-name="${safeName}" ${extra || ''} style="${aStyle(danger)}">${label}</button>`;
  const secHead = (t) => `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:4px 0 8px">${t}</div>`;
  const wazTitle = m.has_wazzup_photo ? 'ดึงรูป profile จาก Wazzup' : (m.wazzup_emp_code ? ('ดึงรูปจาก empCode: ' + m.wazzup_emp_code) : 'ป้อน empCode → ดึงรูปจาก Wazzup');
  const managePane = `
    ${secHead('การเข้าถึง &amp; ทีม')}
    <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:16px">
      ${aBtn('sites', '🌐 Site Access')}
      ${aBtn('supervise', '🔭 Supervise (เลือกทีมที่ดูแล)')}
      ${aBtn('edit-teams', '✏️ แก้ไขทีมที่สังกัด')}
      ${aBtn('hardware', '🖥️ Hardware ที่ดูแล')}
    </div>
    ${secHead('บัญชี')}
    <div style="display:flex;flex-direction:column;gap:7px;margin-bottom:16px">
      ${aBtn('reset', '🔑 Reset PW')}
      ${currentIsSuper ? aBtn('role', (m.is_admin ? '↓ ถอดสิทธิ์ Admin' : '↑ แต่งตั้งเป็น Admin'), `data-current="${m.is_admin ? 1 : 0}"`, m.is_admin) : ''}
      ${aBtn('wazzup-avatar', '🏢 ดึงรูปจาก Wazzup', `data-emp="${escapeHtml(m.wazzup_emp_code || '')}" title="${wazTitle}"`)}
      ${aBtn('merge', '🧬 Merge บัญชี')}
      ${aBtn('toggle', (m.enabled ? '⛔ Disable (ระงับ)' : '✓ Enable (เปิดใช้)'), `data-enabled="${m.enabled ? 1 : 0}"`, m.enabled)}
    </div>
    ${secHead('อันตราย')}
    <div>${aBtn('delete', '🗑 ลบสมาชิก', '', true)}</div>`;

  const wrap = document.createElement('div');
  wrap.className = 'sup-panel-wrap';
  wrap.innerHTML = `
    <div class="sup-panel-backdrop"></div>
    <div class="sup-panel" style="width:420px">
      <div class="sup-panel-head"><button class="sup-panel-close" title="ปิด">✕</button></div>
      <div style="padding:0 24px 12px;display:flex;align-items:center;gap:14px">
        ${av}
        <div style="min-width:0">
          <div style="font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.email || m.phone || '')}</div>
          <div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap">${roleBadge}${pwBadge}${enabledBadge}</div>
        </div>
      </div>
      <div style="display:flex;gap:20px;border-bottom:1px solid var(--border);padding:4px 24px 0">
        <button class="mp-tab" data-mp-tab="info" style="padding:8px 2px;border:none;background:none;border-bottom:2px solid var(--primary);cursor:pointer;font-family:inherit;font-size:14px;font-weight:600;color:var(--primary)">ข้อมูล</button>
        <button class="mp-tab" data-mp-tab="manage" style="padding:8px 2px;border:none;background:none;border-bottom:2px solid transparent;cursor:pointer;font-family:inherit;font-size:14px;font-weight:600;color:var(--text-muted)">จัดการ</button>
      </div>
      <div class="sup-panel-body" style="padding:18px 24px 28px">
        <div data-mp-pane="info">${infoPane}</div>
        <div data-mp-pane="manage" style="display:none">${managePane}</div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelectorAll('.mp-tab').forEach(t => t.addEventListener('click', () => {
    wrap.querySelectorAll('.mp-tab').forEach(x => { const on = x === t; x.style.color = on ? 'var(--primary)' : 'var(--text-muted)'; x.style.borderBottomColor = on ? 'var(--primary)' : 'transparent'; });
    wrap.querySelectorAll('[data-mp-pane]').forEach(p => p.style.display = p.dataset.mpPane === t.dataset.mpTab ? '' : 'none');
  }));
  wrap.querySelectorAll('.m-act-btn').forEach(b => {
    b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft)'; });
    b.addEventListener('mouseleave', () => { b.style.background = 'var(--bg-card)'; });
    b.addEventListener('click', (e) => { e.stopPropagation(); _removeMemberMenu(); handleMemberAction(b); });
  });
  // v1.9.152 — ปุ่ม copy อีเมล
  wrap.querySelectorAll('.mp-copy[data-copy]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      try { navigator.clipboard.writeText(b.dataset.copy); } catch {}
      const orig = b.textContent; b.textContent = '✓'; b.style.color = 'var(--green)';
      setTimeout(() => { b.textContent = orig; b.style.color = 'var(--text-soft)'; }, 900);
    });
  });
  const stB = wrap.querySelector('#mp-stats-btn');
  if (stB) stB.addEventListener('click', () => { _removeMemberMenu(); showMemberStatsModal(m.id, name); });
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  wrap.querySelector('.sup-panel-backdrop').addEventListener('click', closeMemberMenu);
  wrap.querySelector('.sup-panel-close').addEventListener('click', closeMemberMenu);
  const onKey = (e) => { if (e.key === 'Escape') closeMemberMenu(); };
  document.addEventListener('keydown', onKey);
  _memberMenu = { wrap, onKey };
}

// === Modal: member usage stats (platform clicks) ===
async function showMemberStatsModal(memberId, memberName) {
  // เปิด modal โดยใช้ custom modal (ไม่ใช้ showModal เพราะอยากควบคุม content เอง — ไม่มี submit)
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h3 style="margin:0 0 4px;font-size:17px;font-weight:700;letter-spacing:-0.01em">📊 สถิติการใช้ Platform</h3>
          <div style="font-size:13px;color:var(--text-muted)">${escapeHtml(memberName)}</div>
        </div>
        <button class="btn" id="m-stats-close" style="font-size:13px;padding:6px 14px">✕ ปิด</button>
      </div>

      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        <button class="m-stats-day" data-days="7"   style="padding:6px 14px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer">7 วัน</button>
        <button class="m-stats-day" data-days="30"  style="padding:6px 14px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer">30 วัน</button>
        <button class="m-stats-day" data-days="90"  style="padding:6px 14px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer">90 วัน</button>
        <button class="m-stats-day" data-days="180" style="padding:6px 14px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer">180 วัน</button>
      </div>

      <div id="m-stats-summary" style="margin-bottom:14px"></div>
      <div id="m-stats-list">
        <div class="empty">กำลังโหลด…</div>
      </div>
    </div>
  `;
  document.body.appendChild(bg);

  const close = () => bg.remove();
  bg.querySelector('#m-stats-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  const dayButtons = bg.querySelectorAll('.m-stats-day');
  const setActiveDay = (days) => {
    dayButtons.forEach(b => {
      const isActive = parseInt(b.dataset.days, 10) === days;
      b.style.background = isActive ? 'var(--primary)' : 'var(--bg-card)';
      b.style.color = isActive ? '#fff' : 'var(--text)';
      b.style.borderColor = isActive ? 'var(--primary)' : 'var(--border)';
      b.style.fontWeight = isActive ? '600' : '500';
    });
  };

  const loadStats = async (days) => {
    setActiveDay(days);
    bg.querySelector('#m-stats-list').innerHTML = '<div class="empty">กำลังโหลด…</div>';
    bg.querySelector('#m-stats-summary').innerHTML = '';
    let data;
    try {
      data = await fetchJson(`/api/admin/members/${memberId}/stats?days=${days}`);
    } catch (e) {
      bg.querySelector('#m-stats-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
      return;
    }
    renderMemberStats(bg, data);
  };

  // wire day buttons
  dayButtons.forEach(b => {
    b.addEventListener('click', () => loadStats(parseInt(b.dataset.days, 10)));
  });

  // initial load
  loadStats(30);
}

function renderMemberStats(container, data) {
  const summaryEl = container.querySelector('#m-stats-summary');
  const listEl = container.querySelector('#m-stats-list');

  // Summary chip
  summaryEl.innerHTML = `
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">รวมใน ${data.days} วัน</div>
        <div style="font-size:24px;font-weight:700;color:var(--primary);line-height:1.1;margin-top:2px">${fmtMemberInt(data.total_clicks)}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">ครั้งที่ใช้ prefill</div>
      </div>
      <div style="flex:1;min-width:180px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em">Platform ที่ใช้</div>
        <div style="font-size:24px;font-weight:700;line-height:1.1;margin-top:2px">${data.platforms.length}</div>
        <div style="font-size:11.5px;color:var(--text-muted)">เว็บที่เคย autofill</div>
      </div>
    </div>
  `;

  if (!data.platforms || data.platforms.length === 0) {
    listEl.innerHTML = `
      <div class="empty" style="padding:30px 20px">
        ยังไม่มีการใช้งาน prefill ใน ${data.days} วันล่าสุด<br/>
        <span style="font-size:12px">เมื่อ member นี้ใช้ extension prefill credentials จะนับสถิติที่นี่</span>
      </div>
    `;
    return;
  }

  const maxClicks = Math.max(...data.platforms.map(p => p.click_count || 0), 1);
  listEl.innerHTML = `
    <div style="font-size:11.5px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">
      Top platforms (${data.platforms.length})
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${data.platforms.map((p, i) => {
        const initial = (p.site_name || '?').trim().charAt(0).toUpperCase();
        const widthPct = Math.max(8, Math.round((p.click_count / maxClicks) * 100));
        const lastTxt = p.last_used_at ? `ล่าสุด ${fmtRelativeTh(p.last_used_at)}` : '';
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px">
            <div style="font-size:14px;font-weight:700;color:var(--text-muted);min-width:22px;text-align:center">${i + 1}</div>
            <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:13px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.site_name)}</div>
              <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.url_pattern || '')}${lastTxt ? ' · ' + escapeHtml(lastTxt) : ''}</div>
              <div style="margin-top:5px;height:4px;background:var(--bg-soft);border-radius:999px;overflow:hidden">
                <div style="width:${widthPct}%;height:100%;background:linear-gradient(90deg,#2563eb,#7c3aed)"></div>
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:16px;font-weight:700;color:var(--primary);line-height:1">${fmtMemberInt(p.click_count)}</div>
              <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">clicks</div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// helper — int formatter (เฉพาะ scope ของ stats; fmtRelativeTh มีอยู่แล้วในไฟล์)
const _MEM_FMT = new Intl.NumberFormat('th-TH');
function fmtMemberInt(n) { return n == null ? '—' : _MEM_FMT.format(Math.round(n)); }

// === Modal: edit member's teams (multi-select) ===
// === Modal: member's site access (view + add/remove direct grants) ===
// v1.9.52 — interactive: add/remove hardware ของ member ในหน้า Members
async function showMemberHardwareModal(memberId, memberName) {
  // Show modal shell ก่อนโหลด — UX ดีขึ้น (เห็น modal ทันที + loading state)
  showModal({
    title: `🖥️ Hardware ของ ${memberName}`,
    size: 'wide',
    body: `<div id="mh-body" style="min-height:200px"><div class="empty">กำลังโหลด...</div></div>`,
    onSubmit: async () => { /* no submit — actions inline */ },
  });
  // ซ่อนปุ่ม "บันทึก" + เปลี่ยน "ยกเลิก" → "ปิด" (ทุก action เป็น inline)
  setTimeout(() => {
    const okBtn = document.querySelector('.modal-bg .modal #m-ok');
    if (okBtn) okBtn.style.display = 'none';
    const cancelBtn = document.querySelector('.modal-bg .modal #m-cancel');
    if (cancelBtn) cancelBtn.textContent = 'ปิด';
  }, 10);

  const refresh = async () => {
    let memberHw = [], allHw = [];
    try {
      const [a, b] = await Promise.all([
        fetchJson(`/api/admin/members/${memberId}/hardware`),
        fetchJson('/api/admin/hardware'),
      ]);
      memberHw = a.hardware || [];
      allHw = b.hardware || [];
    } catch (e) {
      const body = $('mh-body');
      if (body) body.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
      return;
    }
    // available = ของที่ยังไม่ผูกใคร — เพิ่มได้
    const unassigned = allHw.filter(h => !h.current_member_id);
    const body = $('mh-body');
    if (!body) return;
    body.innerHTML = renderMemberHwBody(memberHw, unassigned);
    // wire action buttons
    body.querySelectorAll('button[data-mh-act]').forEach(btn => {
      btn.addEventListener('click', () => handleMemberHwAction(btn, memberId, memberName, refresh));
    });
  };
  await refresh();
}

const _MH_TYPE_INFO = {
  pc:      { label: 'Personal Computer', icon: '💻' },
  device:  { label: 'Device',            icon: '📱' },
  network: { label: 'Network',           icon: '📡' },
};

function _renderMhCard(h, action) {
  const tag = _MH_TYPE_INFO[h.hw_type] || { icon: '📦' };
  // v1.9.73 — asset_number ย้ายไปบรรทัดแรก (chip) ไม่อยู่ใน meta
  const meta = [];
  if (h.os) meta.push(`💿 ${escapeHtml(h.os)}`);
  if (h.cpu) meta.push(`🔧 ${escapeHtml(h.cpu)}`);
  if (h.device_subtype) meta.push(`📦 ${escapeHtml(h.device_subtype)}`);
  if (h.capacity) meta.push(`📏 ${escapeHtml(h.capacity)}`);
  const thumb = h.photo_data
    ? `<img src="${h.photo_data}" alt="" style="width:48px;height:36px;object-fit:cover;border-radius:5px;border:1px solid var(--border);flex-shrink:0;display:block" />`
    : `<div style="width:48px;height:36px;border-radius:5px;border:1px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px">${tag.icon}</div>`;
  const btnHtml = action === 'remove'
    ? `<button class="btn danger" data-mh-act="remove" data-mh-id="${h.id}" data-mh-name="${escapeHtml(h.name)}" style="font-size:11.5px;padding:5px 10px;flex-shrink:0">🗑 ลบ</button>`
    : `<button class="btn primary" data-mh-act="add" data-mh-id="${h.id}" data-mh-name="${escapeHtml(h.name)}" style="font-size:11.5px;padding:5px 10px;flex-shrink:0">➕ เพิ่ม</button>`;
  return `
    <div class="card" style="display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:5px">
      ${thumb}
      <div style="flex:1;min-width:0">
        ${renderHwAssetLine(h.asset_number, { compact: true })}
        <div style="font-weight:700;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(h.name)}</div>
        ${meta.length ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${meta.join(' · ')}</div>` : ''}
      </div>
      ${btnHtml}
    </div>
  `;
}

function renderMemberHwBody(memberHw, unassigned) {
  const groupByType = (items) => {
    const g = { pc: [], device: [], network: [] };
    items.forEach(h => { if (g[h.hw_type]) g[h.hw_type].push(h); });
    return g;
  };
  const renderSection = (header, items, action, emptyText) => {
    const head = `<div style="font-size:12px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">${header}</div>`;
    if (items.length === 0) {
      return `<div style="margin-bottom:14px">${head}<div class="empty" style="padding:12px;font-size:12.5px">${emptyText}</div></div>`;
    }
    const g = groupByType(items);
    const groups = ['pc', 'device', 'network'].filter(t => g[t].length > 0).map(t => `
      <div style="margin-bottom:8px">
        <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:3px">${_MH_TYPE_INFO[t].icon} ${escapeHtml(_MH_TYPE_INFO[t].label)} (${g[t].length})</div>
        ${g[t].map(h => _renderMhCard(h, action)).join('')}
      </div>
    `).join('');
    return `<div style="margin-bottom:14px">${head}${groups}</div>`;
  };
  return (
    renderSection(`✅ ผูกอยู่กับคนนี้ (${memberHw.length})`, memberHw, 'remove',
      'ยังไม่มี hardware ที่ผูกกับคนนี้ — เลือกเพิ่มจากรายการด้านล่าง')
    + renderSection(`🔓 ยังไม่ผูก — เพิ่มได้ (${unassigned.length})`, unassigned, 'add',
      'ไม่มี hardware ที่ยังว่าง — สร้างใหม่หรือปลดล็อกจากเจ้าของอื่นที่หน้า Hardware')
  );
}

async function handleMemberHwAction(btn, memberId, memberName, refresh) {
  const act = btn.dataset.mhAct;
  const hwId = parseInt(btn.dataset.mhId, 10);
  const hwName = btn.dataset.mhName || '';
  // disable ปุ่มชั่วคราวกัน double-click
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '...';
  try {
    if (act === 'remove') {
      if (!confirm(`เอา "${hwName}" ออกจาก ${memberName}?`)) {
        btn.disabled = false;
        btn.textContent = oldText;
        return;
      }
      await fetchJson(`/api/admin/hardware/${hwId}`, {
        method: 'PATCH',
        body: JSON.stringify({ current_member_id: null }),
      });
    } else if (act === 'add') {
      await fetchJson(`/api/admin/hardware/${hwId}`, {
        method: 'PATCH',
        body: JSON.stringify({ current_member_id: memberId }),
      });
    }
    await refresh();
  } catch (e) {
    alert((act === 'remove' ? 'ลบไม่สำเร็จ: ' : 'เพิ่มไม่สำเร็จ: ') + e.message);
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function showMemberSitesModal(memberId, memberName) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px;flex-wrap:wrap">
        <div>
          <h3 style="margin:0 0 4px;font-size:17px;font-weight:700">🌐 สิทธิ์เข้าถึง Platform</h3>
          <div style="font-size:13px;color:var(--text-muted)">${escapeHtml(memberName)}</div>
        </div>
        <button class="btn" id="ms-close" style="font-size:13px;padding:6px 14px">✕ ปิด</button>
      </div>

      <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px;line-height:1.6">
        🟢 = เข้าถึงผ่าน <strong>ทีม</strong> (ลบไม่ได้จากนี่ — ต้องไปหน้า Teams)<br/>
        🔵 = <strong>Direct grant</strong> โดยตรง (กดเพิ่ม/ลบได้)<br/>
        ⚪ = ยังไม่มีสิทธิ์ — กด "เพิ่มสิทธิ์" จะให้ direct grant ทุก credential ของ site
      </div>

      <div style="position:relative;margin-bottom:12px">
        <input id="ms-search" type="text" placeholder="🔍 ค้นหา site..." autocomplete="off"
               style="width:100%;padding:9px 12px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)" />
      </div>

      <div id="ms-list" style="display:flex;flex-direction:column;gap:6px;max-height:480px;overflow-y:auto;padding:2px">
        <div class="empty" style="padding:30px">กำลังโหลด…</div>
      </div>
    </div>
  `;
  document.body.appendChild(bg);

  const close = () => bg.remove();
  bg.querySelector('#ms-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  let sites = [];
  const reload = async () => {
    try {
      const data = await fetchJson(`/api/admin/members/${memberId}/site-access`);
      sites = data.sites || [];
      renderList();
    } catch (e) {
      bg.querySelector('#ms-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    }
  };

  const renderList = () => {
    const q = bg.querySelector('#ms-search').value.toLowerCase().trim();
    const filtered = q
      ? sites.filter(s => (s.name + ' ' + s.url_pattern).toLowerCase().includes(q))
      : sites;
    const listEl = bg.querySelector('#ms-list');
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty" style="padding:24px">${q ? 'ไม่เจอ site ที่ตรงกับคำค้น' : 'ยังไม่มี site ในระบบ'}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(s => renderMsRow(s)).join('');
    listEl.querySelectorAll('button[data-ms-action]').forEach(btn => {
      btn.addEventListener('click', () => handleMsToggle(btn, memberId, reload));
    });
  };

  const search = bg.querySelector('#ms-search');
  search.addEventListener('input', renderList);

  await reload();
}

function renderMsRow(s) {
  const initial = (s.name || '?').trim().charAt(0).toUpperCase();
  const avatar = s.logo_data
    ? `<div style="width:36px;height:36px;border-radius:9px;background:#fff;border:1px solid var(--border);overflow:hidden;flex-shrink:0;padding:4px"><img src="${s.logo_data}" alt="${escapeHtml(s.name)}" style="width:100%;height:100%;object-fit:contain" /></div>`
    : `<div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;font-weight:700;font-size:14px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;

  const teamBadges = (s.via_teams || []).map(t =>
    `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;background:rgba(16,185,129,.10);color:var(--green)">🟢 ${escapeHtml(t.name)} (${t.access_type})</span>`
  ).join(' ');
  const directBadge = s.direct_credentials > 0
    ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;background:rgba(37,99,235,.10);color:var(--primary)">🔵 Direct (${s.direct_credentials}/${s.total_creds || 0})</span>`
    : '';
  const noAccessBadge = !s.has_access
    ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:500;background:var(--bg-soft);color:var(--text-muted)">⚪ ไม่มีสิทธิ์</span>`
    : '';
  const badges = [teamBadges, directBadge, noAccessBadge].filter(Boolean).join(' ');

  // Action button — เพิ่ม/ลบ direct grant
  let actionBtn;
  if (s.direct_credentials > 0) {
    actionBtn = `<button class="btn danger" data-ms-action="revoke" data-site-id="${s.id}" data-site-name="${escapeHtml(s.name)}" style="font-size:11.5px;padding:5px 11px;white-space:nowrap">✕ ถอน Direct</button>`;
  } else if (s.via_teams && s.via_teams.length > 0) {
    actionBtn = `<button class="btn primary" data-ms-action="grant" data-site-id="${s.id}" data-site-name="${escapeHtml(s.name)}" style="font-size:11.5px;padding:5px 11px;white-space:nowrap" title="เพิ่มสิทธิ์โดยตรง (เผื่อ team เปลี่ยน)">+ Direct grant</button>`;
  } else {
    actionBtn = `<button class="btn primary" data-ms-action="grant" data-site-id="${s.id}" data-site-name="${escapeHtml(s.name)}" style="font-size:11.5px;padding:5px 11px;white-space:nowrap">+ ให้สิทธิ์</button>`;
  }

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px">
      ${avatar}
      <div style="flex:1;min-width:0;overflow:hidden">
        <div style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(s.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Menlo,monospace">${escapeHtml(s.url_pattern)}</div>
        ${badges ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px">${badges}</div>` : ''}
      </div>
      ${actionBtn}
    </div>
  `;
}

async function handleMsToggle(btn, memberId, reload) {
  const action = btn.dataset.msAction;
  const siteId = parseInt(btn.dataset.siteId, 10);
  const siteName = btn.dataset.siteName;
  const verb = action === 'grant' ? 'ให้สิทธิ์' : 'ถอนสิทธิ์ direct';
  if (!confirm(`ยืนยัน${verb} "${siteName}"?`)) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '⏳';
  try {
    await fetchJson(`/api/admin/members/${memberId}/site-direct-access/${siteId}`, {
      method: 'PUT',
      body: JSON.stringify({ grant: action === 'grant' }),
    });
    showSavedToast(action === 'grant' ? '✓ ให้สิทธิ์แล้ว' : '✓ ถอนสิทธิ์แล้ว');
    await reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    showSavedToast('❌ ' + e.message, 'error');
  }
}

function showEditMemberTeamsModal(memberId, memberName) {
  const member = _membersCache.find(m => m.id === memberId);
  if (!member) return;
  const currentTeamIds = new Set((member.teams || []).map(t => t.id));

  showModal({
    title: `แก้ไขทีมของ ${memberName}`,
    body: `
      <div class="hint" style="margin-bottom:12px;color:var(--text-muted);font-size:12px">
        เลือกทีมที่ member นี้สังกัด (จะถูก grant สิทธิ์เข้าถึง platform ตาม team)
      </div>
      ${_teamsCache.length === 0
        ? '<div class="empty">ยังไม่มี team ในระบบ — สร้าง team ก่อนที่ <a href="#/teams" style="color:var(--primary)">หน้า Teams</a></div>'
        : `<div style="display:flex;flex-direction:column;gap:5px;max-height:440px;overflow-y:auto;padding:2px">
            ${(() => {
              // v1.9.60 — render เป็นต้นไม้ตามโครงสร้าง parent_team_id
              const tree = buildTeamTree(_teamsCache);
              const flat = flattenTeamTreeDFS(tree);
              return flat.map(({ team: t, depth, hasChildren }) => {
                const isChecked = currentTeamIds.has(t.id);
                const indentPx = 10 + depth * 18;
                const branchIcon = hasChildren ? '📂' : (depth > 0 ? '└─' : '');
                return `
                  <label style="display:flex;align-items:center;gap:10px;padding:9px 12px 9px ${indentPx}px;border:1px solid var(--border);border-left:${depth > 0 ? '3px solid rgba(37,99,235,.25)' : '1px solid var(--border)'};border-radius:8px;cursor:pointer;background:${isChecked ? 'var(--primary-soft)' : 'var(--bg-card)'};transition:all .12s">
                    <input type="checkbox" name="m-team" value="${t.id}" ${isChecked ? 'checked' : ''} style="margin:0">
                    <div style="flex:1;min-width:0">
                      <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px">
                        ${branchIcon ? `<span style="color:var(--text-soft);font-size:11.5px">${branchIcon}</span>` : ''}
                        <span>${escapeHtml(t.name)}</span>
                      </div>
                      <div style="font-size:11.5px;color:var(--text-muted)">
                        ${t.member_count} member · ${t.site_count} site${t.description ? ' · ' + escapeHtml(t.description) : ''}
                      </div>
                    </div>
                  </label>
                `;
              }).join('');
            })()}
          </div>`
      }
    `,
    onSubmit: async () => {
      const checked = Array.from(document.querySelectorAll('input[name="m-team"]:checked'))
        .map(cb => parseInt(cb.value, 10));
      await fetchJson(`/api/admin/members/${memberId}/teams`, {
        method: 'PUT',
        body: JSON.stringify({ team_ids: checked }),
      });
      await loadMembersList();
    },
  });

  // visual feedback ตอนติ๊ก
  setTimeout(() => {
    document.querySelectorAll('input[name="m-team"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const lbl = cb.closest('label');
        if (lbl) lbl.style.background = cb.checked ? 'var(--primary-soft)' : 'var(--bg-card)';
      });
    });
  }, 0);
}

// v1.9.125 — Supervise: เลือกทีมที่ member นี้ดูข้อมูลได้ (multi-select ทุกทีม)
async function showSuperviseModal(memberId, memberName) {
  let supervisedIds = new Set();
  try {
    const r = await fetchJson(`/api/admin/members/${memberId}/supervised-teams`);
    supervisedIds = new Set(r.team_ids || []);
  } catch (e) {
    showSavedToast('โหลด supervise ไม่สำเร็จ: ' + e.message, 'error');
    return;
  }
  showModal({
    title: `🔭 Supervise — ${memberName}`,
    size: 'wide',
    body: `
      <div class="hint" style="margin-bottom:12px;color:var(--text-muted);font-size:12.5px;line-height:1.6">
        เลือกทีมที่ <strong>${escapeHtml(memberName)}</strong> สามารถ<strong>ดูข้อมูลได้ (supervise)</strong> — เลือกได้หลายทีม โดยไม่ต้องเป็นสมาชิกทีมนั้น
      </div>
      ${_teamsCache.length === 0
        ? '<div class="empty">ยังไม่มี team ในระบบ</div>'
        : `<div style="display:flex;flex-direction:column;gap:5px;max-height:440px;overflow-y:auto;padding:2px">
            ${(() => {
              const tree = buildTeamTree(_teamsCache);
              const flat = flattenTeamTreeDFS(tree);
              return flat.map(({ team: t, depth, hasChildren }) => {
                const isChecked = supervisedIds.has(t.id);
                const indentPx = 10 + depth * 18;
                const branchIcon = hasChildren ? '📂' : (depth > 0 ? '└─' : '');
                return `
                  <label style="display:flex;align-items:center;gap:10px;padding:9px 12px 9px ${indentPx}px;border:1px solid var(--border);border-left:${depth > 0 ? '3px solid rgba(124,58,237,.25)' : '1px solid var(--border)'};border-radius:8px;cursor:pointer;background:${isChecked ? 'rgba(124,58,237,.10)' : 'var(--bg-card)'};transition:all .12s">
                    <input type="checkbox" name="m-sup-team" value="${t.id}" ${isChecked ? 'checked' : ''} style="margin:0">
                    <div style="flex:1;min-width:0">
                      <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px">
                        ${branchIcon ? `<span style="color:var(--text-soft);font-size:11.5px">${branchIcon}</span>` : ''}
                        <span>${escapeHtml(t.name)}</span>
                      </div>
                      <div style="font-size:11.5px;color:var(--text-muted)">
                        ${t.member_count} member · ${t.site_count} site${t.description ? ' · ' + escapeHtml(t.description) : ''}
                      </div>
                    </div>
                  </label>
                `;
              }).join('');
            })()}
          </div>`
      }
    `,
    onSubmit: async () => {
      const checked = Array.from(document.querySelectorAll('input[name="m-sup-team"]:checked')).map(cb => parseInt(cb.value, 10));
      await fetchJson(`/api/admin/members/${memberId}/supervised-teams`, {
        method: 'PUT', body: JSON.stringify({ team_ids: checked }),
      });
      showSavedToast(`✓ ตั้งทีมที่ supervise แล้ว (${checked.length} ทีม)`);
    },
  });
  setTimeout(() => {
    document.querySelectorAll('input[name="m-sup-team"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const lbl = cb.closest('label');
        if (lbl) lbl.style.background = cb.checked ? 'rgba(124,58,237,.10)' : 'var(--bg-card)';
      });
    });
  }, 0);
}

async function handleMemberAction(btn) {
  const id = btn.dataset.id;
  const act = btn.dataset.act;

  if (act === 'supervise') {
    showSuperviseModal(parseInt(id, 10), btn.dataset.name);
    return;
  }

  if (act === 'edit-teams') {
    const name = btn.dataset.name;
    showEditMemberTeamsModal(parseInt(id, 10), name);
    return;
  }

  if (act === 'stats') {
    const name = btn.dataset.name;
    showMemberStatsModal(parseInt(id, 10), name);
    return;
  }

  if (act === 'sites') {
    const name = btn.dataset.name;
    showMemberSitesModal(parseInt(id, 10), name);
    return;
  }

  if (act === 'hardware') {
    const name = btn.dataset.name;
    showMemberHardwareModal(parseInt(id, 10), name);
    return;
  }

  // v1.9.84 — merge 2 accounts → คน ๆ เดียวกัน
  if (act === 'merge') {
    const name = btn.dataset.name;
    showMergeMemberModal(parseInt(id, 10), name);
    return;
  }

  // v1.9.92/93 — admin ดึงรูปจาก Wazzup ของ member นี้ (เปิด modal ให้ป้อน empCode)
  if (act === 'wazzup-avatar') {
    const name = btn.dataset.name;
    const empPrefill = btn.dataset.emp || '';
    showAdminWazzupEmpCodeModal(parseInt(id, 10), name, empPrefill);
    return;
  }

  if (act === 'role') {
    const isCurrentlyAdmin = btn.dataset.current === '1';
    const name = btn.dataset.name;
    const action = isCurrentlyAdmin ? 'ถอดสิทธิ์ admin จาก' : 'แต่งตั้ง admin ให้';
    if (!confirm(`ยืนยัน${action} "${name}"?`)) return;
    try {
      await fetchJson(`/api/admin/members/${id}/admin`, {
        method: 'PATCH',
        body: JSON.stringify({ is_admin: !isCurrentlyAdmin }),
      });
      await loadMembersList();
    } catch (e) {
      alert('ทำรายการไม่สำเร็จ: ' + e.message);
    }
    return;
  }

  if (act === 'reset') {
    const name = btn.dataset.name;
    showResetPasswordModal(id, name);
    return;
  }

  if (act === 'toggle') {
    const wasEnabled = btn.dataset.enabled === '1';
    const action = wasEnabled ? 'ระงับ' : 'เปิดใช้งาน';
    if (!confirm(`ยืนยัน${action}บัญชีนี้?`)) return;
    try {
      await fetchJson(`/api/admin/members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !wasEnabled }),
      });
      await loadMembersList();
    } catch (e) {
      alert('ทำรายการไม่สำเร็จ: ' + e.message);
    }
    return;
  }

  if (act === 'delete') {
    const name = btn.dataset.name;
    if (!confirm(`ลบบัญชี "${name}" ถาวร?\n\nข้อมูลทั้งหมดจะหายไปและกู้คืนไม่ได้`)) return;
    try {
      await fetchJson(`/api/admin/members/${id}`, { method: 'DELETE' });
      await loadMembersList();
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message);
    }
    return;
  }
}

// v1.9.84 — Merge 2 member accounts (คน ๆ เดียวกัน) — primary (this) = ปลายทาง, source (เลือก) = ถูกลบ
// v1.9.94 — 2-step merge: pick source → preview field-by-field → admin เลือก primary/source → submit
function showMergeMemberModal(primaryId, primaryName) {
  const candidates = (_membersCache || []).filter(m => m.id !== primaryId);
  let selectedId = null;
  let preview = null;
  let fieldChoices = {};  // {field: 'primary'|'source'}
  let searchQ = '';
  let step = 1;  // 1 = pick source, 2 = field choices

  // Custom modal (ไม่ใช้ showModal เพราะ multi-step + content swap)
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-xwide" style="max-height:88vh;overflow-y:auto">
      <h3 id="mm-title" style="margin:0 0 12px;font-size:17px;font-weight:700">🧬 รวมบัญชี — primary: ${escapeHtml(primaryName)}</h3>
      <div id="mm-body"></div>
      <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn" id="mm-cancel">ยกเลิก</button>
        <button class="btn" id="mm-back" style="display:none">← ย้อนกลับ</button>
        <button class="btn primary" id="mm-next">ดูข้อมูลทั้ง 2 →</button>
      </div>
      <div class="hint" id="mm-err" style="color:var(--critical);margin-top:6px;display:none"></div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const showErr = (msg) => { const e = bg.querySelector('#mm-err'); e.textContent = msg; e.style.display = ''; };
  const clearErr = () => { bg.querySelector('#mm-err').style.display = 'none'; };
  bg.querySelector('#mm-cancel').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  const renderStep1 = () => {
    bg.querySelector('#mm-title').textContent = `🧬 รวมบัญชี — primary: ${primaryName}`;
    bg.querySelector('#mm-back').style.display = 'none';
    bg.querySelector('#mm-next').textContent = 'ดูข้อมูลทั้ง 2 →';
    bg.querySelector('#mm-body').innerHTML = `
      <div class="info-box" style="margin-bottom:12px;padding:10px 12px;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.25);border-radius:8px;color:var(--accent);font-size:12.5px;line-height:1.6">
        เลือกบัญชีอีกอันที่จะรวมเข้ามาที่ "${escapeHtml(primaryName)}" — ขั้นถัดไปจะแสดงข้อมูลทั้ง 2 ฝั่งให้เลือกว่าจะเก็บฝั่งไหนแต่ละ field
      </div>
      <div class="field">
        <input id="mm-search" type="text" placeholder="🔍 ค้นหาชื่อ / email / phone..." autocomplete="off"
          style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box" />
        <div id="mm-list" style="margin-top:8px;max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);padding:6px;display:flex;flex-direction:column;gap:2px"></div>
      </div>
    `;
    const refreshList = () => {
      const listEl = bg.querySelector('#mm-list');
      if (!listEl) return;
      const ql = searchQ.trim().toLowerCase();
      const filtered = candidates.filter(m => !ql
        || (m.display_name || '').toLowerCase().includes(ql)
        || (m.email || '').toLowerCase().includes(ql)
        || (m.phone || '').toLowerCase().includes(ql));
      if (filtered.length === 0) {
        listEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text-muted);font-size:12.5px">ไม่พบ account ที่ตรงคำค้น</div>`;
        return;
      }
      listEl.innerHTML = filtered.map(m => {
        const isSel = m.id === selectedId;
        return `
          <button type="button" data-mid="${m.id}" style="cursor:pointer;padding:7px 9px;border-radius:6px;display:flex;align-items:center;gap:10px;background:${isSel ? 'rgba(124,58,237,.10)' : 'transparent'};border:1px solid ${isSel ? 'var(--accent)' : 'transparent'};font-family:inherit;text-align:left;width:100%;box-sizing:border-box">
            ${renderHwMemberRow(m, false)}
            ${isSel ? '<span style="color:var(--accent);font-weight:700;font-size:18px;flex-shrink:0">✓</span>' : ''}
          </button>`;
      }).join('');
      listEl.querySelectorAll('button[data-mid]').forEach(btn => {
        btn.addEventListener('click', () => { selectedId = parseInt(btn.dataset.mid, 10); refreshList(); });
      });
    };
    const inp = bg.querySelector('#mm-search');
    inp.addEventListener('input', (e) => { searchQ = e.target.value; refreshList(); });
    refreshList();
    inp.focus();
  };

  const renderStep2 = () => {
    bg.querySelector('#mm-title').textContent = `🧬 รวมบัญชี — เลือกข้อมูลที่จะเก็บ`;
    bg.querySelector('#mm-back').style.display = '';
    bg.querySelector('#mm-next').textContent = '🧬 ยืนยันรวม';
    const primSum = preview.primary;
    const srcSum = preview.source;
    const headerCell = (sum, isP) => {
      const avatar = sum.avatar_data
        ? `<img src="${sum.avatar_data}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--border)" />`
        : `<div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:18px;display:inline-flex;align-items:center;justify-content:center">${escapeHtml((sum.display_name||'?').charAt(0).toUpperCase())}</div>`;
      const tagBg = isP ? 'rgba(37,99,235,.10)' : 'rgba(245,158,11,.10)';
      const tagFg = isP ? 'var(--primary)' : '#92400e';
      const tagLabel = isP ? 'จะเก็บไว้ (Primary)' : 'จะถูกลบ (Source)';
      return `
        <div style="display:flex;gap:10px;align-items:center;padding:10px;background:var(--bg-soft);border-radius:8px;border:1px solid var(--border)">
          ${avatar}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px">${escapeHtml(sum.display_name || '(ไม่ได้ตั้งชื่อ)')}</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">#${sum.id} · ${escapeHtml(sum.email || sum.phone || '—')}</div>
            <span style="display:inline-block;margin-top:4px;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;background:${tagBg};color:${tagFg}">${tagLabel}</span>
          </div>
        </div>`;
    };
    const renderFieldRow = (spec) => {
      const f = spec.field;
      const pv = spec.primary_value;
      const sv = spec.source_value;
      const conflict = spec.in_conflict;
      const current = fieldChoices[f] || spec.default_choice;
      const renderValue = (val, isP) => {
        if (!val) return '<span style="color:var(--text-muted);font-style:italic;font-size:12px">— ไม่มี —</span>';
        if (spec.type === 'image') {
          return `<img src="${val}" alt="" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:1px solid var(--border)" />`;
        }
        return `<span style="font-size:12.5px;word-break:break-all">${escapeHtml(String(val))}</span>`;
      };
      const rowBg = conflict ? 'rgba(245,158,11,.06)' : 'transparent';
      const conflictBadge = conflict ? `<span style="display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;background:rgba(245,158,11,.15);color:#92400e;margin-left:6px">⚠ conflict</span>` : '';
      const radioCell = (which, val) => {
        const has = !!val;
        const disabled = !has;
        const checked = current === which && has;
        return `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:6px;cursor:${disabled?'not-allowed':'pointer'};background:${checked?'rgba(37,99,235,.08)':'transparent'};border:1px solid ${checked?'var(--primary)':'var(--border)'};opacity:${disabled?0.5:1}">
            <input type="radio" name="mm-fc-${f}" value="${which}" ${checked?'checked':''} ${disabled?'disabled':''} data-field="${f}" style="margin-top:2px;flex-shrink:0" />
            <div style="flex:1;min-width:0">${renderValue(val, which==='primary')}</div>
          </label>`;
      };
      return `
        <div style="padding:10px;border-radius:8px;background:${rowBg};border:1px solid var(--border);margin-bottom:6px">
          <div style="font-weight:600;font-size:12.5px;margin-bottom:6px">${escapeHtml(spec.label)} ${conflictBadge}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            ${radioCell('primary', pv)}
            ${radioCell('source', sv)}
          </div>
        </div>`;
    };
    bg.querySelector('#mm-body').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        ${headerCell(primSum, true)}
        ${headerCell(srcSum, false)}
      </div>
      <div class="info-box" style="margin-bottom:10px;padding:8px 12px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.20);border-radius:8px;color:#92400e;font-size:12px;line-height:1.5">
        เลือกว่าแต่ละ field จะเก็บฝั่งไหน — fields ที่ <strong>conflict</strong> (ทั้ง 2 ฝั่งมีค่าและต่างกัน) จะมี ⚠ flag<br>
        Teams / Sites / Hardware / History / Logs จะ <strong>รวมจากทั้ง 2 ฝั่งอัตโนมัติ</strong> (ไม่ต้องเลือก) — รวมถึง login methods เดิมจะถูก preserved เป็น alias
      </div>
      <div>${preview.fields.map(renderFieldRow).join('')}</div>
    `;
    bg.querySelectorAll('input[type="radio"][data-field]').forEach(r => {
      r.addEventListener('change', () => {
        fieldChoices[r.dataset.field] = r.value;
        // re-render row backgrounds (toggle border highlight)
        const card = r.closest('label');
        if (card) {
          card.parentElement.querySelectorAll('label').forEach(l => {
            const isChk = l.querySelector('input').checked;
            l.style.background = isChk ? 'rgba(37,99,235,.08)' : 'transparent';
            l.style.borderColor = isChk ? 'var(--primary)' : 'var(--border)';
          });
        }
      });
    });
  };

  bg.querySelector('#mm-next').addEventListener('click', async () => {
    clearErr();
    if (step === 1) {
      if (!selectedId) { showErr('เลือก account ที่จะรวมก่อน'); return; }
      const nextBtn = bg.querySelector('#mm-next');
      nextBtn.disabled = true;
      nextBtn.textContent = '⏳ โหลด...';
      try {
        preview = await fetchJson(`/api/admin/members/${primaryId}/merge-preview?source_id=${selectedId}`);
        fieldChoices = {};
        preview.fields.forEach(f => { fieldChoices[f.field] = f.default_choice; });
        step = 2;
        renderStep2();
      } catch (e) {
        showErr(e.message);
      } finally {
        nextBtn.disabled = false;
      }
    } else {
      // submit merge
      const srcMember = candidates.find(x => x.id === selectedId);
      const srcLabel = srcMember ? (srcMember.display_name || srcMember.email || srcMember.phone || `member#${selectedId}`) : `member#${selectedId}`;
      if (!confirm(`ยืนยันรวม?\n\n"${srcLabel}" จะถูกลบถาวร\nข้อมูลถูกย้าย/รวมเข้า "${primaryName}" ตาม field ที่เลือก`)) return;
      const nextBtn = bg.querySelector('#mm-next');
      nextBtn.disabled = true;
      nextBtn.textContent = '⏳ กำลังรวม...';
      try {
        await fetchJson(`/api/admin/members/${primaryId}/merge`, {
          method: 'POST',
          body: JSON.stringify({ source_id: selectedId, field_choices: fieldChoices }),
        });
        close();
        await loadMembersList();
        showSavedToast(`✓ รวมบัญชีสำเร็จ`);
      } catch (e) {
        showErr(e.message);
        nextBtn.disabled = false;
        nextBtn.textContent = '🧬 ยืนยันรวม';
      }
    }
  });

  bg.querySelector('#mm-back').addEventListener('click', () => {
    step = 1;
    preview = null;
    fieldChoices = {};
    clearErr();
    renderStep1();
  });

  renderStep1();
}

// v1.9.93 — admin: modal ป้อน empCode + ดึงรูป → preview → save
function showAdminWazzupEmpCodeModal(memberId, memberName, empPrefill) {
  showModal({
    title: `🏢 รูปจาก Wazzup — ${memberName}`,
    body: `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:13px;color:var(--text-muted);line-height:1.55">
          ป้อน <b>Wazzup Employee Code</b> ของ ${escapeHtml(memberName)} —
          ระบบจะดึงรูปจาก <code style="background:var(--bg-soft);padding:1px 6px;border-radius:4px;font-size:11.5px">/upload/profile/&lt;empCode&gt;_profile.png</code>
        </div>
        <label style="display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600">
          Employee Code
          <input type="text" id="m-waz-emp" value="${escapeHtml(empPrefill)}" placeholder="เช่น 100886" autocomplete="off" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-family:ui-monospace,Menlo,monospace;font-size:14px" />
        </label>
        <div id="m-waz-preview" style="display:none;text-align:center;margin-top:6px;padding-top:12px;border-top:1px dashed var(--border)">
          <img id="m-waz-img" alt="preview" style="width:180px;height:180px;border-radius:50%;object-fit:cover;border:2px solid var(--border);background:var(--bg-soft)" />
          <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">กด "บันทึก" เพื่อใช้รูปนี้</div>
        </div>
        <button type="button" id="m-waz-fetch" class="btn primary" style="margin-top:4px;font-size:13px;padding:8px 14px">🔍 ดึงรูป + Preview</button>
      </div>
    `,
    onSubmit: async () => {
      const img = document.getElementById('m-waz-img');
      const dataUrl = img && img.src && img.src.startsWith('data:') ? img.src : '';
      if (!dataUrl) throw new Error('กด "ดึงรูป + Preview" ก่อน แล้วจึงบันทึก');
      // v1.9.142 — ย่อรูปก่อนเซฟ กัน base64 ใหญ่เกิน (เหมือน flow อัพโหลด)
      const small = await _squareDownscaleDataUrl(dataUrl, 256).catch(() => dataUrl);
      await fetchJson(`/api/admin/members/${memberId}/avatar`, {
        method: 'PATCH',
        body: JSON.stringify({ avatar_data: small }),
      });
      showSavedToast('✓ เปลี่ยนรูปแล้ว');
      await loadMembersList();
    },
  });
  setTimeout(() => {
    const inp = document.getElementById('m-waz-emp');
    const fetchBtn = document.getElementById('m-waz-fetch');
    const previewBox = document.getElementById('m-waz-preview');
    const previewImg = document.getElementById('m-waz-img');
    if (inp) inp.focus();
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async () => {
        const empCode = (inp.value || '').trim();
        if (!empCode) { alert('ป้อน Employee Code ก่อน'); inp.focus(); return; }
        const orig = fetchBtn.textContent;
        fetchBtn.disabled = true;
        fetchBtn.textContent = '⏳ กำลังดึง...';
        try {
          const wazToken = getWazzupToken();
          const headers = { 'Content-Type': 'application/json' };
          if (wazToken) headers['Authorization'] = `Bearer ${wazToken}`;
          const r = await fetchJson(`/api/admin/members/${memberId}/avatar-from-wazzup`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ emp_code: empCode }),
          });
          previewImg.src = r.data_url;
          previewBox.style.display = '';
        } catch (e) {
          previewBox.style.display = 'none';
          previewImg.removeAttribute('src');
          alert('ดึงรูปไม่สำเร็จ: ' + e.message);
        } finally {
          fetchBtn.disabled = false;
          fetchBtn.textContent = orig;
        }
      });
    }
  }, 30);
}

function showResetPasswordModal(memberId, memberName) {
  showModal({
    title: `Reset Password — ${memberName}`,
    body: `
      <div class="hint" style="margin-bottom:14px;color:var(--text-muted)">
        ตั้งรหัสผ่านใหม่ (อย่างน้อย 4 ตัว) — member จะใช้รหัสนี้ login ครั้งหน้า
      </div>
      <div class="field">
        <label>รหัสผ่านใหม่</label>
        <input id="rst-pw" type="password" autocomplete="new-password" />
      </div>
      <div class="field">
        <label>ยืนยันรหัสผ่าน</label>
        <input id="rst-confirm" type="password" autocomplete="new-password" />
      </div>
    `,
    onSubmit: async () => {
      const password = document.getElementById('rst-pw').value;
      const confirm = document.getElementById('rst-confirm').value;
      if (password.length < 4) throw new Error('รหัสผ่านอย่างน้อย 4 ตัว');
      if (password !== confirm) throw new Error('รหัสผ่านยืนยันไม่ตรงกัน');
      await fetchJson(`/api/admin/members/${memberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      });
      await loadMembersList();
    },
  });
}

