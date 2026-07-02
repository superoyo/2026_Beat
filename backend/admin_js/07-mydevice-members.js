// =========================================================================
// My Device — member-side page (อุปกรณ์ที่ผูกกับตัวเอง + อัพโหลดรูปได้)
// =========================================================================
let _myDeviceCache = [];

async function renderMyDevicePage() {
  $('main').innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🖥️ My Device</h2>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      อุปกรณ์ทั้งหมดที่ผูกกับคุณ — แก้ไขข้อมูลไม่ได้ แต่<strong>อัพโหลดรูปอุปกรณ์</strong>เองได้
    </div>
    <div id="md-list">${skelStack(2)}</div>
  `;
  await loadMyDevice();
}

async function loadMyDevice() {
  let data;
  try {
    data = await fetchJson('/api/my-hardware');
  } catch (e) {
    if ($('md-list')) $('md-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _myDeviceCache = data.hardware || [];
  renderMyDeviceList();
}

function renderMyDeviceList() {
  const listEl = $('md-list');
  if (!listEl) return;
  if (_myDeviceCache.length === 0) {
    listEl.innerHTML = `
      <div class="empty" style="padding:32px;text-align:center;line-height:1.6">
        <div style="font-size:48px;margin-bottom:8px">📭</div>
        <div style="font-weight:600;color:var(--text);margin-bottom:4px">ยังไม่มีอุปกรณ์ที่ผูกกับคุณ</div>
        <div style="font-size:13px;color:var(--text-muted)">ติดต่อ admin เพื่อขอผูกอุปกรณ์</div>
      </div>
    `;
    return;
  }
  // Group by hw_type
  const groups = { pc: [], device: [], network: [] };
  _myDeviceCache.forEach(h => {
    if (groups[h.hw_type]) groups[h.hw_type].push(h);
  });
  const sections = HW_TYPES.filter(t => groups[t.id].length > 0).map(t => `
    <div style="margin-bottom:24px">
      <div style="font-size:12px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">${t.icon}</span>
        <span>${escapeHtml(t.label)}</span>
        <span style="background:var(--bg-soft);color:var(--text-muted);font-size:11px;padding:1px 8px;border-radius:999px;font-weight:600">${groups[t.id].length}</span>
      </div>
      ${groups[t.id].map(h => renderMyDeviceCard(h)).join('')}
    </div>
  `).join('');
  listEl.innerHTML = sections;
  listEl.querySelectorAll('button[data-md-act]').forEach(btn => {
    btn.addEventListener('click', () => handleMyDeviceAction(btn));
  });
  // v1.9.252 — toggle "คอมพิวเตอร์ของตนเอง"
  listEl.querySelectorAll('input[data-md-act="toggle-personal"]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const id = parseInt(cb.dataset.mdId, 10);
      cb.disabled = true;
      try {
        await fetchJson('/api/my-hardware/' + id + '/personal', { method: 'PATCH', body: JSON.stringify({ is_personal_owned: cb.checked }) });
        const h = _myDeviceCache.find(x => x.id === id);
        if (h) h.is_personal_owned = cb.checked ? 1 : 0;
        renderMyDeviceList();
      } catch (e) {
        cb.checked = !cb.checked;
        alert('บันทึกไม่สำเร็จ: ' + (e.message || e));
      } finally { cb.disabled = false; }
    });
  });
}

function renderMyDeviceCard(h) {
  const tab = HW_TYPES.find(t => t.id === h.hw_type) || HW_TYPES[0];
  // Photo block — ขนาดใหญ่ (160x120) — คลิกเพื่อดูเต็ม
  const photoBlock = h.photo_data
    ? `<button type="button" data-md-act="preview" data-md-id="${h.id}" title="คลิกเพื่อดูภาพเต็ม"
         style="width:160px;height:120px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);overflow:hidden;padding:0;cursor:pointer;flex-shrink:0">
         <img src="${h.photo_data}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />
       </button>`
    : `<div style="width:160px;height:120px;border-radius:8px;border:1.5px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;flex-direction:column;gap:4px;color:var(--text-muted);font-size:11.5px">
         <span style="font-size:32px;opacity:.6">${tab.icon}</span>
         <span>ยังไม่มีรูป</span>
       </div>`;

  // Specs
  const specs = [];
  if (h.hw_type === 'pc') {
    if (h.model) specs.push(`📦 ${escapeHtml(h.model)}`);
    if (h.os) specs.push(`💿 ${escapeHtml(h.os)}${h.os_version ? ' ' + escapeHtml(h.os_version) : ''}`);
    if (h.cpu) specs.push(`🔧 ${escapeHtml(h.cpu)}`);
    if (h.ram) specs.push(`🧠 ${escapeHtml(h.ram)}`);
    if (h.storage) specs.push(`💾 ${escapeHtml(h.storage)}`);
    if (h.display) specs.push(`🖥️ ${escapeHtml(h.display)}`);
  } else if (h.hw_type === 'device') {
    if (h.device_subtype) specs.push(`📦 ${escapeHtml(h.device_subtype)}`);
    if (h.capacity) specs.push(`📏 ${escapeHtml(h.capacity)}`);
  }
  if (h.serial_number) specs.push(`#️⃣ ${escapeHtml(h.serial_number)}`);
  // v1.9.73 — asset_number ไม่อยู่ใน specs (ไปอยู่บรรทัดแรกแล้ว)
  if (h.department || h.location) {
    const dl = [h.department, h.location].filter(Boolean).map(escapeHtml).join(' / ');
    specs.push(`📍 ${dl}`);
  }
  // เดือน/ปีที่ซื้อ — แสดงเป็น calendar tile เด่น ๆ ในแถวชื่อแทน (ไม่อยู่ใน specs grid)
  const purchaseTile = renderMyDevicePurchaseTile(h.purchased_at);
  const specHtml = specs.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px 14px;font-size:12.5px;color:var(--text-muted);line-height:1.7">${specs.map(s => `<div>${s}</div>`).join('')}</div>`
    : '<div style="font-size:12px;color:var(--text-muted);font-style:italic">— ไม่มีรายละเอียด —</div>';

  // Status badge (PC only)
  const statusBadge = (h.hw_type === 'pc') ? hwStatusBadge(h.status) : '';

  return `
    <div class="card" style="display:flex;gap:14px;flex-wrap:wrap;padding:14px;margin-bottom:10px;align-items:flex-start">
      ${photoBlock}
      <div style="flex:1;min-width:240px;display:flex;flex-direction:column;gap:8px">
        ${renderHwAssetLine(h.asset_number)}
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="font-size:15px;font-weight:700;color:var(--text)">${escapeHtml(h.name)}</span>
          ${statusBadge}
          ${h.is_personal_owned ? '<span style="display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(124,58,237,.12);color:#7c3aed">🙋 ใช้คอมพิวเตอร์ของตนเอง</span>' : ''}
          ${purchaseTile}
        </div>
        ${specHtml}
        ${h.notes ? `<div style="font-size:12px;color:var(--text-muted);font-style:italic;padding:6px 10px;background:var(--bg-soft);border-radius:6px">📝 ${escapeHtml(h.notes)}</div>` : ''}
        ${h.hw_type === 'pc' ? `
          <label style="display:inline-flex;align-items:center;gap:9px;font-size:13px;font-weight:600;color:var(--text);cursor:pointer;width:fit-content;background:${h.is_personal_owned ? 'rgba(124,58,237,.10)' : 'var(--bg-soft)'};padding:8px 13px;border-radius:9px;border:1px solid ${h.is_personal_owned ? 'rgba(124,58,237,.4)' : 'var(--border)'};transition:.12s">
            <input type="checkbox" data-md-act="toggle-personal" data-md-id="${h.id}" ${h.is_personal_owned ? 'checked' : ''} style="width:17px;height:17px;cursor:pointer;accent-color:#7c3aed" />
            <span>🙋 คอมพิวเตอร์ของตนเอง <span style="font-weight:500;color:var(--text-muted);font-size:11.5px">(เครื่องส่วนตัว / BYOD)</span></span>
          </label>
        ` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:2px">
          <button class="btn" data-md-act="upload" data-md-id="${h.id}" style="font-size:12.5px;padding:6px 12px">📷 อัพโหลดรูป</button>
          <button class="btn" data-md-act="camera" data-md-id="${h.id}" style="font-size:12.5px;padding:6px 12px">📸 ถ่ายจากกล้อง</button>
          ${h.photo_data ? `<button class="btn danger" data-md-act="remove-photo" data-md-id="${h.id}" data-md-name="${escapeHtml(h.name)}" style="font-size:12.5px;padding:6px 12px">🗑 ลบรูป</button>` : ''}
        </div>
      </div>
    </div>
  `;
}

// Calendar-style tile แสดงเดือน/ปีที่ซื้อ — รองรับทั้ง YYYY-MM (PC) และ YYYY-MM-DD (Device/Network)
function renderMyDevicePurchaseTile(purchasedAt) {
  if (!purchasedAt) return '';
  const ym = String(purchasedAt).slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return '';
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return '';
  const SHORT = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  const monthLabel = SHORT[month - 1];
  const be = year + 543;
  // คำนวณอายุการใช้งาน (ปี/เดือน) เพื่อ tooltip
  const now = new Date();
  const purchase = new Date(year, month - 1, 1);
  let months = (now.getFullYear() - year) * 12 + (now.getMonth() - (month - 1));
  if (months < 0) months = 0;
  const yrs = Math.floor(months / 12);
  const mos = months % 12;
  const ageStr = yrs > 0 ? `${yrs} ปี${mos > 0 ? ' ' + mos + ' เดือน' : ''}` : (mos > 0 ? `${mos} เดือน` : 'ไม่ถึง 1 เดือน');
  const tooltip = `ซื้อเมื่อ ${monthLabel} ${be} · ใช้งานมาแล้ว ${ageStr}`;
  return `
    <div title="${escapeHtml(tooltip)}" style="margin-left:auto;display:inline-flex;flex-direction:column;align-items:stretch;border-radius:9px;overflow:hidden;border:1px solid rgba(220,38,38,.18);box-shadow:0 2px 6px rgba(220,38,38,.12);min-width:64px;flex-shrink:0">
      <div style="background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;padding:2px 12px;font-size:10.5px;font-weight:700;letter-spacing:.5px;text-align:center;line-height:1.5">${escapeHtml(monthLabel)}</div>
      <div style="background:#fff;color:#0f172a;padding:4px 12px;font-size:15px;font-weight:800;line-height:1.1;text-align:center;font-variant-numeric:tabular-nums">${be}</div>
    </div>
  `;
}

// v1.9.55 — แยก age calculation เป็น helper เพื่อใช้ซ้ำในหลายที่
function calcHwAgeStr(purchasedAt) {
  if (!purchasedAt) return '';
  const ym = String(purchasedAt).slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return '';
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return '';
  const now = new Date();
  let months = (now.getFullYear() - year) * 12 + (now.getMonth() - (month - 1));
  if (months < 0) months = 0;
  const yrs = Math.floor(months / 12);
  const mos = months % 12;
  return yrs > 0 ? `${yrs} ปี${mos > 0 ? ' ' + mos + ' เดือน' : ''}` : (mos > 0 ? `${mos} เดือน` : 'ไม่ถึง 1 เดือน');
}

// v1.9.55 — PC spec card สำหรับหน้า Team detail (member row) — สรุป spec + อายุ + tile
function renderTeamMemberPcCard(pc) {
  const tile = renderMyDevicePurchaseTile(pc.purchased_at);
  const ageStr = calcHwAgeStr(pc.purchased_at);
  const specs = [];
  if (pc.cpu) specs.push(`🔧 ${escapeHtml(pc.cpu)}`);
  if (pc.ram) specs.push(`🧠 ${escapeHtml(pc.ram)}`);
  if (pc.storage) specs.push(`💾 ${escapeHtml(pc.storage)}`);
  if (pc.display) specs.push(`🖥 ${escapeHtml(pc.display)}`);
  if (pc.os) specs.push(`💿 ${escapeHtml(pc.os)}${pc.os_version ? ' ' + escapeHtml(pc.os_version) : ''}`);

  const statusBadge = hwStatusBadge(pc.status, { size: 'sm' });

  const headLine = pc.model
    ? `${escapeHtml(pc.name)} <span style="color:var(--text-muted);font-weight:500;font-size:12px">— ${escapeHtml(pc.model)}</span>`
    : escapeHtml(pc.name);

  // v1.9.62 — คลิก = เปิด detail modal (ทุก card คลิกได้เสมอ)
  return `
    <button type="button" data-tm-pc-id="${pc.id}" title="คลิกดูรายละเอียดอุปกรณ์ + แก้ไข"
       style="display:flex;gap:10px;align-items:flex-start;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-top:6px;width:100%;text-align:left;font-family:inherit;cursor:pointer;transition:background .12s,border-color .12s"
       onmouseenter="this.style.background='var(--bg-card)';this.style.borderColor='var(--primary)'"
       onmouseleave="this.style.background='var(--bg-soft)';this.style.borderColor='var(--border)'">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px">
        ${renderHwAssetLine(pc.asset_number, { compact: true })}
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:13px;color:var(--text)">💻 ${headLine}</span>
          ${statusBadge}
          <span style="font-size:10.5px;color:var(--primary);font-weight:600">📖 รายละเอียด</span>
        </div>
        ${specs.length ? `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">${specs.join(' <span style=\"color:var(--border)\">·</span> ')}</div>` : ''}
        ${ageStr ? `<div style="font-size:11.5px;color:var(--accent);font-weight:600">⏱ ใช้งานมาแล้ว ${escapeHtml(ageStr)}</div>` : ''}
      </div>
      ${tile}
    </button>
  `;
}

// v1.9.62 — Detail modal สำหรับ PC ในหน้า Team detail
// ซ้าย = ภาพ ; ขวา = รายละเอียด + ปุ่ม Edit
// v1.9.68 — รับ optional afterEdit callback สำหรับ refresh context ที่เปิด modal (เช่น unassigned page)
// v1.9.298 — โหลด members/teams cache ถ้ายังว่าง (ให้ slide panel มี avatar + ชื่อแผนก)
async function _ensureHwCaches() {
  if (_hwMembersCache.length && _hwTeamsCache.length) return;
  try {
    const [md, td] = await Promise.all([fetchJson('/api/admin/members'), fetchJson('/api/admin/teams')]);
    _hwMembersCache = md.members || _hwMembersCache;
    _hwTeamsCache = td.teams || _hwTeamsCache;
  } catch (_) { /* ignore */ }
}

function showTeamPcDetailModal(pc, teamId, afterEdit) {
  const tile = renderMyDevicePurchaseTile(pc.purchased_at);
  const ageStr = calcHwAgeStr(pc.purchased_at);

  // Owner row (avatar + ชื่อ + email)
  // v1.9.63 — หาเจ้าของจาก _lastTeamMembersData ก่อน (มีอยู่แน่นอนเพราะ PC ผูกอยู่กับ member ในทีม)
  // fallback _hwMembersCache สำหรับกรณีโหลดจาก context อื่น
  let ownerRow;
  if (pc.current_member_id) {
    const m = (_lastTeamMembersData || []).find(x => x.id === pc.current_member_id)
           || _hwMembersCache.find(x => x.id === pc.current_member_id);
    ownerRow = m
      ? renderHwMemberRow(m, false)
      : `<span style="color:var(--text-muted)">member#${pc.current_member_id} (ไม่พบในระบบ)</span>`;
  } else {
    ownerRow = '<span style="color:var(--text-muted);font-style:italic;font-size:13px">— ยังไม่ผูก —</span>';
  }

  // Photo blocks
  const photoBlock = pc.photo_data
    ? `<img src="${pc.photo_data}" alt="PC" style="width:100%;display:block;border-radius:10px;border:1px solid var(--border);object-fit:cover;aspect-ratio:4/3;background:#0f172a" />`
    : `<div style="width:100%;aspect-ratio:4/3;border-radius:10px;border:1.5px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:13px;flex-direction:column;gap:6px"><span style="font-size:48px;opacity:.5">💻</span><span>ยังไม่มีรูปอุปกรณ์</span></div>`;
  const assetPhotoBlock = pc.asset_photo_data
    ? `<div style="margin-top:12px">
         <div style="font-size:11px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📸 ภาพหมายเลข asset</div>
         <img src="${pc.asset_photo_data}" alt="asset-photo" style="width:100%;display:block;border-radius:8px;border:1px solid var(--border);object-fit:cover;aspect-ratio:4/3;background:#0f172a" />
       </div>`
    : '';

  // Status badge
  const statusBadge = hwStatusBadge(pc.status, { size: 'lg', fullLabel: true });

  // Field rows helper
  const fieldRow = (label, val) => val
    ? `<div style="display:flex;gap:10px;font-size:13px;line-height:1.7;padding:2px 0"><span style="color:var(--text-muted);min-width:110px;flex-shrink:0">${label}</span><span style="font-weight:500;color:var(--text);word-break:break-word">${escapeHtml(String(val))}</span></div>`
    : '';
  const sect = (icon, title, content) => content.trim()
    ? `<div style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border)">
         <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">${icon} ${escapeHtml(title)}</div>
         ${content}
       </div>`
    : '';

  // Sections
  const ownerSection = `
    <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">👤 ผู้ดูแลปัจจุบัน</div>
    <div style="background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;padding:8px 10px;display:flex;align-items:center">${ownerRow}</div>
  `;
  const generalContent = [
    fieldRow('Asset', pc.asset_number),
    fieldRow('Serial', pc.serial_number),
    fieldRow('ซื้อเมื่อ', pc.purchased_at ? fmtMonthYearThai(pc.purchased_at) : ''),
    ageStr ? `<div style="display:flex;gap:10px;font-size:13px;line-height:1.7;padding:2px 0"><span style="color:var(--text-muted);min-width:110px;flex-shrink:0">อายุการใช้งาน</span><span style="font-weight:600;color:var(--accent)">⏱ ${escapeHtml(ageStr)}</span></div>` : '',
    fieldRow('Quotation', pc.quotation),
  ].join('');
  const specContent = [
    fieldRow('CPU', pc.cpu),
    fieldRow('RAM', pc.ram),
    fieldRow('Storage', pc.storage),
    fieldRow('Display', pc.display),
    fieldRow('Mainboard', pc.mainboard),
    fieldRow('GPU', pc.gpu),
    fieldRow('Battery', pc.battery),
    fieldRow('UPS', pc.ups),
  ].join('');
  const osContent = [
    fieldRow('OS', pc.os),
    fieldRow('Version', pc.os_version),
  ].join('');
  const allocContent = [
    fieldRow('Department', pc.department),
    fieldRow('Location', pc.location),
  ].join('');
  const notesContent = pc.notes ? `<div style="font-size:13px;color:var(--text);white-space:pre-wrap;line-height:1.6;background:var(--bg-soft);border-radius:8px;padding:10px 12px">${escapeHtml(pc.notes)}</div>` : '';

  const headLine = pc.model
    ? `${escapeHtml(pc.name)} <span style="color:var(--text-muted);font-weight:500;font-size:14px">— ${escapeHtml(pc.model)}</span>`
    : escapeHtml(pc.name);

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-xwide">
      <!-- v1.9.71 — sticky header + ปุ่ม Edit ไปบนขวา -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin:-14px -14px 14px;padding:14px 14px 12px;background:var(--bg-card);border-bottom:1px solid var(--border);position:sticky;top:-14px;z-index:5;flex-wrap:wrap">
        <div style="flex:1;min-width:0">
          <h3 style="margin:0 0 6px;font-size:18px;font-weight:700">💻 ${headLine}</h3>
          ${statusBadge}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex-shrink:0">
          <div style="display:flex;gap:6px">
            <button class="btn" id="tpdm-close" style="font-size:13px;padding:7px 14px;white-space:nowrap">ปิด</button>
            <button class="btn primary" id="tpdm-edit" style="font-size:13px;padding:7px 14px;white-space:nowrap">✏️ แก้ไขรายละเอียด</button>
          </div>
          ${tile}
        </div>
      </div>
      <!-- v1.9.296 — Tab strip: รายละเอียด | ประวัติการใช้เครื่อง -->
      <div class="tpdm-tabs" style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap">
        <button type="button" class="tpdm-tab" data-tpdm-tab="detail" style="background:none;border:none;border-bottom:2px solid var(--primary);padding:9px 14px;font-size:13.5px;color:var(--primary);font-weight:600;cursor:pointer">📋 รายละเอียด</button>
        <button type="button" class="tpdm-tab" data-tpdm-tab="history" style="background:none;border:none;padding:9px 14px;font-size:13.5px;color:var(--text-muted);font-weight:500;cursor:pointer">📜 ประวัติการใช้เครื่อง</button>
      </div>
      <div class="tpdm-pane" data-tpdm-pane="detail">
        <div style="display:grid;grid-template-columns:300px 1fr;gap:18px;align-items:flex-start">
          <div>
            ${photoBlock}
            ${assetPhotoBlock}
          </div>
          <div>
            ${ownerSection}
            ${sect('📋', 'ข้อมูลทั่วไป', generalContent)}
            ${sect('🔧', 'Specification', specContent)}
            ${sect('💿', 'ระบบปฏิบัติการ', osContent)}
            ${sect('🏢', 'การจัดสรร', allocContent)}
            ${sect('📝', 'หมายเหตุ', notesContent)}
          </div>
        </div>
      </div>
      <div class="tpdm-pane" data-tpdm-pane="history" style="display:none">
        <div id="tpdm-history"><div class="empty" style="padding:24px;font-size:12.5px">กำลังโหลด…</div></div>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#tpdm-close').addEventListener('click', close);
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#tpdm-edit').addEventListener('click', () => {
    close();
    // เปิด edit modal — หลังบันทึก reload context ที่เปิด modal (team detail / unassigned page / etc.)
    showHardwareModal(pc, 'pc', async () => {
      if (typeof afterEdit === 'function') {
        await afterEdit();
      } else if (teamId) {
        await loadTeamDetail(teamId);
      }
    });
  });
  // v1.9.296 — tab switching + lazy-load ประวัติการใช้เครื่อง
  bg.querySelectorAll('.tpdm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tpdmTab;
      bg.querySelectorAll('.tpdm-tab').forEach(b => {
        const active = b === btn;
        b.style.color = active ? 'var(--primary)' : 'var(--text-muted)';
        b.style.fontWeight = active ? '600' : '500';
        b.style.borderBottom = active ? '2px solid var(--primary)' : '';
      });
      bg.querySelectorAll('.tpdm-pane').forEach(p => { p.style.display = (p.dataset.tpdmPane === target) ? '' : 'none'; });
      if (target === 'history' && !btn.dataset.loaded) { btn.dataset.loaded = '1'; _tpdmLoadHistory(bg, pc.id); }
    });
  });
}

// v1.9.296 — ประวัติการใช้เครื่อง (การ์ด: period ซ้าย / ชื่อขวา + capsule) ใน showTeamPcDetailModal
async function _tpdmLoadHistory(bg, hwId) {
  const box = bg.querySelector('#tpdm-history');
  if (!box) return;
  let items = [];
  try { items = (await fetchJson('/api/admin/hardware/' + hwId + '/history')).history || []; }
  catch (e) { box.innerHTML = '<div class="empty" style="padding:20px;font-size:12.5px">โหลดประวัติไม่ได้</div>'; return; }
  if (!items.length) { box.innerHTML = '<div class="empty" style="padding:20px;font-size:12.5px">— ยังไม่มีประวัติการใช้เครื่อง —</div>'; return; }
  // v1.9.302 — current อยู่บนสุด
  items.sort((a, b) => { const aA = !a.unassigned_at, bA = !b.unassigned_at; if (aA !== bA) return aA ? -1 : 1; return (b.assigned_at || '').localeCompare(a.assigned_at || ''); });
  const _miniAv = (m, nm) => (m && m.avatar_data)
    ? `<img src="${m.avatar_data}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0" />`
    : `<span style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:13px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((String(nm).trim().charAt(0) || '?').toUpperCase())}</span>`;
  box.innerHTML = items.map(r => {
    const fromYm = (r.assigned_at || '').slice(0, 7), toYm = r.unassigned_at ? r.unassigned_at.slice(0, 7) : null;
    const fromLabel = fromYm ? fmtMonthYearThai(fromYm) : '—';
    const isActive = !r.unassigned_at;
    const toLabel = toYm ? fmtMonthYearThai(toYm) : 'ปัจจุบัน';
    const m = r.member_id ? _hwMembersCache.find(x => x.id === r.member_id) : null;
    const nm = r.member_label || '— ไม่ผูก —';
    const dept = (m && m.teams && m.teams.length) ? m.teams[0].name : '';
    const cap = isActive
      ? '<span style="flex-shrink:0;font-size:10px;font-weight:700;background:rgba(16,185,129,.12);color:var(--green);padding:2px 8px;border-radius:999px">current</span>'
      : '<span style="flex-shrink:0;font-size:10px;font-weight:700;background:var(--bg-soft);color:var(--text-muted);padding:2px 8px;border-radius:999px">previous</span>';
    return `<div style="border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-bottom:7px;${isActive ? '' : 'opacity:.92'}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span style="font-size:12.5px;font-weight:600;min-width:0;flex-shrink:0">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</span>
        <span style="display:flex;align-items:center;gap:8px;min-width:0">
          ${_miniAv(m, nm)}
          <span style="min-width:0">
            <span style="display:flex;align-items:center;gap:6px">
              <span style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(nm)}</span>
              ${cap}
            </span>
            ${dept ? `<div style="font-size:10.5px;color:var(--text-muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(dept)}</div>` : ''}
          </span>
        </span>
      </div>
      ${r.note ? `<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;margin-top:5px">📝 ${escapeHtml(r.note)}</div>` : ''}
    </div>`;
  }).join('');
}

async function uploadMyDevicePhoto(hwId, dataUrl) {
  try {
    await fetchJson(`/api/my-hardware/${hwId}/photo`, {
      method: 'PATCH',
      body: JSON.stringify({ photo_data: dataUrl || '' }),
    });
    await loadMyDevice();
  } catch (e) {
    alert('บันทึกรูปไม่สำเร็จ: ' + e.message);
  }
}

function handleMyDeviceAction(btn) {
  const act = btn.dataset.mdAct;
  const id = parseInt(btn.dataset.mdId, 10);
  const h = _myDeviceCache.find(x => x.id === id);
  if (!h) return;
  // Crop config — เหมือน admin Hardware module: 4:3, 640x480, JPEG q=0.85
  const cropOpts = {
    aspectRatio: 4 / 3,
    outputWidth: 640,
    outputHeight: 480,
    outputType: 'image/jpeg',
    outputQuality: 0.85,
    title: '✂️ Crop รูปอุปกรณ์ (สัดส่วน 4:3)',
  };
  if (act === 'preview') {
    if (h.photo_data) showHardwarePhotoModal(h);
  } else if (act === 'upload') {
    // สร้าง file input ชั่วคราว
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => openCropModal(ev.target.result, (dataUrl) => uploadMyDevicePhoto(id, dataUrl), cropOpts);
      reader.readAsDataURL(file);
    });
    input.click();
  } else if (act === 'camera') {
    openCameraModal((dataUrl) => uploadMyDevicePhoto(id, dataUrl), cropOpts);
  } else if (act === 'remove-photo') {
    if (!confirm(`ลบรูปของ "${btn.dataset.mdName}"?`)) return;
    uploadMyDevicePhoto(id, '');
  }
}

// === Hardware: Owner picker (avatar + display_name + email) ===
// แทน <select> ธรรมดาเพื่อให้ผู้ใช้เลือก member ได้อย่างถูกต้องโดยดูหน้าตาประกอบ
function renderHwMemberRow(m, compact, opts) {
  opts = opts || {};
  const display = m.display_name || m.email || m.phone || `member#${m.id}`;
  const initial = (display.trim().charAt(0) || '?').toUpperCase();
  const sub = m.email || m.phone || '';
  const size = compact ? 28 : 34;
  const fontSize = compact ? 12 : 14;
  const avatar = m.avatar_data
    ? `<img src="${m.avatar_data}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:1px solid var(--border);flex-shrink:0" />`
    : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:${fontSize}px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</div>`;
  // v1.9.54 — team chips (opt-in: opts.showTeams=true) — กรอง excludeTeamId ถ้าระบุ
  const visibleTeams = (opts.showTeams && Array.isArray(m.teams))
    ? m.teams.filter(t => t.id !== opts.excludeTeamId)
    : [];
  const teamChips = visibleTeams.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px">${visibleTeams.map(t => `<span title="${escapeHtml(t.name)}" style="display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;background:rgba(37,99,235,.10);color:var(--primary);border:1px solid rgba(37,99,235,.20);white-space:nowrap;line-height:1.5">👥 ${escapeHtml(t.name)}</span>`).join('')}</div>`
    : '';
  const alignItems = teamChips ? 'flex-start' : 'center';
  return `
    <div style="display:flex;align-items:${alignItems};gap:10px;min-width:0;flex:1">
      ${avatar}
      <div style="display:flex;flex-direction:column;min-width:0;line-height:1.3;flex:1">
        <span style="font-weight:600;font-size:13.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(display)}</span>
        ${sub ? `<span style="font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(sub)}</span>` : ''}
        ${teamChips}
      </div>
    </div>
  `;
}
function renderHwOwnerTriggerContent(memberId) {
  if (!memberId) {
    return `<span style="color:var(--text-muted);font-size:13px">— ยังไม่ผูก (คลิกเพื่อเลือกผู้ดูแล) —</span>`;
  }
  const m = _hwMembersCache.find(x => x.id === memberId);
  if (!m) return `<span style="color:var(--text-muted)">member#${memberId} (ไม่พบในระบบ)</span>`;
  return renderHwMemberRow(m, true);
}
function renderHwOwnerPickerHtml(currentMemberId) {
  const cid = currentMemberId || '';
  return `
    <div id="hm-owner-wrap" style="position:relative">
      <button type="button" id="hm-owner-trigger" style="width:100%;padding:6px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px">
        <span id="hm-owner-trigger-content" style="flex:1;min-width:0;display:flex">${renderHwOwnerTriggerContent(currentMemberId)}</span>
        <span id="hm-owner-trigger-arrow" style="color:var(--text-muted);font-size:11px">▼</span>
      </button>
      <div id="hm-owner-panel" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:8px;flex-direction:column;gap:6px">
        <input id="hm-owner-search" type="text" placeholder="🔍 ค้นหาชื่อ / email / เบอร์..." autocomplete="off" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:inherit;background:var(--bg-input);color:var(--text);box-sizing:border-box" />
        <div id="hm-owner-list" style="overflow-y:auto;max-height:280px;display:flex;flex-direction:column;gap:2px"></div>
      </div>
      <input type="hidden" id="hm-owner" value="${cid}" />
    </div>
  `;
}
let _hwOwnerOutsideListenerAttached = false;
// v1.9.65 — onChange(newMemberId|null): callback หลังจาก user เลือก member ใหม่
function wireHwOwnerPicker(onChange) {
  const wrap = $('hm-owner-wrap');
  if (!wrap) return;
  const trigger = $('hm-owner-trigger');
  const panel   = $('hm-owner-panel');
  const arrow   = $('hm-owner-trigger-arrow');
  const search  = $('hm-owner-search');
  const listEl  = $('hm-owner-list');
  const hidden  = $('hm-owner');
  let q = '';

  const isOpen = () => panel.style.display === 'flex';
  const open  = () => { panel.style.display = 'flex'; arrow.textContent = '▲'; q = ''; search.value = ''; refresh(); setTimeout(() => search.focus(), 0); };
  const close = () => { panel.style.display = 'none'; arrow.textContent = '▼'; };

  const refresh = () => {
    const ql = q.trim().toLowerCase();
    const filtered = _hwMembersCache.filter(m => {
      if (!ql) return true;
      return (m.display_name || '').toLowerCase().includes(ql)
          || (m.email || '').toLowerCase().includes(ql)
          || (m.phone || '').toLowerCase().includes(ql);
    });
    const noneRow = `
      <button type="button" data-mid="" style="cursor:pointer;padding:8px 10px;border-radius:6px;display:flex;align-items:center;gap:10px;color:var(--text-muted);font-size:13px;background:transparent;border:none;font-family:inherit;text-align:left">
        <span style="width:28px;height:28px;border-radius:50%;border:1px dashed var(--border);display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">∅</span>
        <span>— ไม่ผูก —</span>
      </button>`;
    const memberRows = filtered.map(m => `
      <button type="button" data-mid="${m.id}" style="cursor:pointer;padding:6px 8px;border-radius:6px;display:flex;background:transparent;border:none;font-family:inherit;text-align:left;width:100%;box-sizing:border-box">
        ${renderHwMemberRow(m, false)}
      </button>`).join('');
    const emptyMsg = (filtered.length === 0 && ql)
      ? `<div style="padding:10px;text-align:center;color:var(--text-muted);font-size:12px">ไม่พบ member ที่ตรงกับ "${escapeHtml(q)}"</div>`
      : '';
    listEl.innerHTML = noneRow + memberRows + emptyMsg;
    listEl.querySelectorAll('button[data-mid]').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--bg-soft)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'transparent');
      btn.addEventListener('click', () => {
        const mid = btn.dataset.mid;
        hidden.value = mid;
        const newId = mid ? parseInt(mid, 10) : null;
        $('hm-owner-trigger-content').innerHTML = renderHwOwnerTriggerContent(newId);
        close();
        // v1.9.65 — fire callback for unlinked-fields toggle
        if (typeof onChange === 'function') onChange(newId);
      });
    });
  };

  trigger.addEventListener('click', (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  search.addEventListener('input', (e) => { q = e.target.value; refresh(); });
  // Outside-click → close (attach once globally — modal is short-lived)
  if (!_hwOwnerOutsideListenerAttached) {
    document.addEventListener('click', (e) => {
      const w = document.getElementById('hm-owner-wrap');
      const p = document.getElementById('hm-owner-panel');
      if (!w || !p || p.style.display !== 'flex') return;
      if (!w.contains(e.target)) {
        p.style.display = 'none';
        const a = document.getElementById('hm-owner-trigger-arrow');
        if (a) a.textContent = '▼';
      }
    });
    _hwOwnerOutsideListenerAttached = true;
  }
}

// v1.9.62 — afterSubmit: optional callback แทน loadHardware() — สำหรับเปิดจากหน้าอื่น (Team detail) แล้ว reload ตรง context
// v1.9.66 — async + ensure caches โหลด (กรณีเปิดจาก context ที่ยังไม่ได้ pre-load — เช่น Team detail page)
async function showHardwareModal(hw, type, afterSubmit) {
  if (_hwMembersCache.length === 0 || _hwTeamsCache.length === 0) {
    try {
      const [md, td] = await Promise.all([
        fetchJson('/api/admin/members'),
        fetchJson('/api/admin/teams'),
      ]);
      _hwMembersCache = md.members || [];
      _hwTeamsCache = td.teams || [];
    } catch (_) { /* ignore — render ต่อแม้ load fail */ }
  }
  const isEdit = !!hw;
  const tabInfo = HW_TYPES.find(t => t.id === type) || HW_TYPES[0];
  // PC fields visible เฉพาะ type='pc' / Device fields เฉพาะ 'device'
  const showPC = (type === 'pc');
  const showDevice = (type === 'device');

  // Owner picker HTML — สร้างก่อน (ใช้ใน 2 ฟอร์ม)
  const ownerPickerHtml = renderHwOwnerPickerHtml(isEdit ? hw.current_member_id : null);

  // Status options — derive จาก HW_STATUS_META (single source of truth)
  const HW_STATUS_OPTS = [
    { value: '', label: '— ไม่ระบุ —' },
    ...Object.entries(HW_STATUS_META).map(([value, m]) => ({ value, label: m.full })),
  ];

  // Inline section header — visual hint สำหรับการจัดกลุ่ม
  const sect = (icon, title) => `
    <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;padding:14px 0 6px;border-bottom:1px solid var(--border);margin-bottom:10px">${icon} ${escapeHtml(title)}</div>
  `;

  // purchased_at — ใช้ month picker (YYYY-MM) สำหรับ PC, date picker สำหรับ device/network
  const purchVal = isEdit ? (hw.purchased_at || '').slice(0, showPC ? 7 : 10) : '';
  const purchInput = showPC
    ? `<input id="hm-purchased" type="month" value="${escapeHtml(purchVal)}" />`
    : `<input id="hm-purchased" type="date" value="${escapeHtml(purchVal)}" />`;

  showModal({
    title: isEdit ? `แก้ไข ${tabInfo.label}: ${hw.name}` : `+ เพิ่ม ${tabInfo.label}`,
    slide: true,   // v1.9.217 — สไลด์จากด้านขวาแทน popup
    // v1.9.70 — xwide สำหรับ PC เพื่อให้ layout 2 column (ซ้าย=รูป ขวา=ฟิลด์) เหมือนหน้า detail
    size: showPC ? 'xwide' : 'wide',
    body: `
      ${showPC ? `
        <!-- v1.9.64 — Tab strip: รายละเอียดอุปกรณ์ | ผู้ดูแลปัจจุบัน + ประวัติ -->
        <div class="hm-tabs" style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap">
          <button type="button" class="hm-tab" data-hm-tab="details" style="background:none;border:none;border-bottom:2px solid var(--primary);padding:10px 14px;font-size:13.5px;color:var(--primary);font-weight:600;cursor:pointer">📋 รายละเอียดอุปกรณ์</button>
          <button type="button" class="hm-tab" data-hm-tab="owner" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--text-muted);font-weight:500;cursor:pointer">👤 ผู้ดูแลปัจจุบัน${isEdit ? ' + ประวัติ' : ''}</button>
          ${isEdit ? `<button type="button" class="hm-tab" data-hm-tab="findoc" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--text-muted);font-weight:500;cursor:pointer">💰 Financial Document</button>` : ''}
          ${isEdit ? `<button type="button" class="hm-tab" data-hm-tab="status" style="background:none;border:none;padding:10px 14px;font-size:13.5px;color:var(--text-muted);font-weight:500;cursor:pointer">📊 สถานะ</button>` : ''}
        </div>

        <div class="hm-tab-pane" data-hm-pane="details">
        <!-- v1.9.70 — 2-column layout: ซ้าย=รูป ขวา=ฟิลด์ (เหมือนหน้า detail) -->
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
          <!-- LEFT COLUMN: photos -->
          <div style="flex:0 0 280px;max-width:100%;display:flex;flex-direction:column;gap:16px">
            <!-- Main PC photo -->
            <div>
              <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🖼 รูปอุปกรณ์</div>
              <div id="hm-photo-preview" style="width:100%;aspect-ratio:4/3;border-radius:10px;border:1.5px dashed var(--border);background:${(isEdit && hw.photo_data) ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;overflow:hidden">
                ${(isEdit && hw.photo_data)
                  ? `<img src="${hw.photo_data}" alt="photo" style="width:100%;height:100%;object-fit:cover;display:block" />`
                  : `<span style="color:var(--text-muted);font-size:12px;text-align:center;line-height:1.3">ยังไม่มี<br/>รูปอุปกรณ์</span>`
                }
              </div>
              <div style="display:flex;flex-direction:column;gap:5px;margin-top:8px">
                <button type="button" class="btn" id="hm-photo-upload-btn" style="font-size:12px;padding:6px 10px;text-align:left">📷 อัพโหลดไฟล์...</button>
                <button type="button" class="btn" id="hm-photo-camera-btn" style="font-size:12px;padding:6px 10px;text-align:left">📸 ถ่ายรูปจากกล้อง</button>
                <button type="button" class="btn danger" id="hm-photo-remove-btn" style="font-size:12px;padding:6px 10px;text-align:left;${(isEdit && hw.photo_data) ? '' : 'display:none'}">🗑 ลบรูป</button>
                <input type="file" id="hm-photo-file-input" accept="image/*" style="display:none" />
              </div>
              <input type="hidden" id="hm-photo-data" value="${escapeHtml((isEdit && hw.photo_data) || '')}" />
            </div>
            <!-- Asset photo + OCR -->
            <div>
              <div style="font-size:11.5px;font-weight:700;color:var(--primary-dark);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">📸 รูปหมายเลข asset</div>
              <div id="hm-asset-photo-preview" style="width:100%;aspect-ratio:4/3;border-radius:10px;border:1.5px dashed var(--border);background:${(isEdit && hw.asset_photo_data) ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;overflow:hidden">
                ${(isEdit && hw.asset_photo_data)
                  ? `<img src="${hw.asset_photo_data}" alt="asset-photo" style="width:100%;height:100%;object-fit:cover;display:block" />`
                  : `<span style="color:var(--text-muted);font-size:11.5px;text-align:center;line-height:1.3">📸<br/>ภาพ asset</span>`
                }
              </div>
              <div style="display:flex;flex-direction:column;gap:5px;margin-top:8px">
                <button type="button" class="btn" id="hm-asset-photo-upload-btn" style="font-size:11.5px;padding:5px 10px;text-align:left">📷 อัพโหลด</button>
                <button type="button" class="btn" id="hm-asset-photo-camera-btn" style="font-size:11.5px;padding:5px 10px;text-align:left">📸 กล้อง</button>
                <button type="button" class="btn" id="hm-asset-photo-ocr-btn" style="font-size:11.5px;padding:5px 10px;text-align:left;background:rgba(245,158,11,.15);color:#92400e;border-color:rgba(245,158,11,.3)" title="ใช้ OCR อ่านเลข asset จากรูป">🔍 OCR อ่านเลข asset</button>
                <button type="button" class="btn danger" id="hm-asset-photo-remove-btn" style="font-size:11.5px;padding:5px 10px;text-align:left;${(isEdit && hw.asset_photo_data) ? '' : 'display:none'}">🗑 ลบรูป</button>
                <input type="file" id="hm-asset-photo-file-input" accept="image/*" style="display:none" />
              </div>
              <!-- v1.9.69 — OCR result panel -->
              <div id="hm-asset-ocr-result" style="display:none;margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.08);border:1px dashed rgba(245,158,11,.35);border-radius:6px">
                <div style="font-size:11px;color:#92400e;font-weight:700;margin-bottom:4px">📄 ผลการอ่าน OCR (แก้ก่อนใช้ได้)</div>
                <textarea id="hm-asset-ocr-text" rows="2" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
                <div style="display:flex;gap:6px;margin-top:6px">
                  <button type="button" class="btn primary" id="hm-asset-ocr-apply" style="font-size:11.5px;padding:5px 10px">✓ ใช้ค่านี้เป็น Asset</button>
                  <button type="button" class="btn" id="hm-asset-ocr-close" style="font-size:11.5px;padding:5px 10px">ยกเลิก</button>
                </div>
              </div>
              <input type="hidden" id="hm-asset-photo-data" value="${escapeHtml((isEdit && hw.asset_photo_data) || '')}" />
            </div>
          </div>

          <!-- RIGHT COLUMN: fields -->
          <div style="flex:1;min-width:320px">
        ${sect('📋', 'ข้อมูลทั่วไป')}
        <div class="field">
          <label>ชื่อ *</label>
          <input id="hm-name" type="text" value="${isEdit ? escapeHtml(hw.name) : ''}" placeholder="เช่น MacBook Pro 14 ของอนัน" />
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
          <div class="field">
            <label>Model</label>
            <input id="hm-model" type="text" value="${isEdit ? escapeHtml(hw.model || '') : ''}" placeholder="เช่น MacBook Pro 14 M3 2023 / ThinkPad X1 Gen 11" />
          </div>
          <div class="field">
            <label>Status</label>
            <select id="hm-status" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
              ${HW_STATUS_OPTS.map(o => `<option value="${escapeHtml(o.value)}"${(isEdit && (hw.status || '') === o.value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>เลข Asset</label>
            <input id="hm-asset" type="text" value="${isEdit ? escapeHtml(hw.asset_number || '') : ''}" placeholder="เช่น A-001" />
          </div>
          <div class="field">
            <label>S/N (Serial Number)</label>
            <input id="hm-serial" type="text" value="${isEdit ? escapeHtml(hw.serial_number || '') : ''}" placeholder="เช่น C02ABC123XYZ" />
          </div>
        </div>

        ${sect('🔧', 'Specification')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>CPU</label>
            <input id="hm-cpu" type="text" value="${isEdit ? escapeHtml(hw.cpu || '') : ''}" placeholder="Apple M3 Pro / Intel i7-12700H" />
          </div>
          <div class="field">
            <label>RAM</label>
            <input id="hm-ram" type="text" value="${isEdit ? escapeHtml(hw.ram || '') : ''}" placeholder="16GB / 32GB DDR5" />
          </div>
          <div class="field">
            <label>Storage</label>
            <input id="hm-storage" type="text" value="${isEdit ? escapeHtml(hw.storage || '') : ''}" placeholder='512GB SSD / 1TB NVMe' />
          </div>
          <div class="field">
            <label>Display</label>
            <input id="hm-display" type="text" value="${isEdit ? escapeHtml(hw.display || '') : ''}" placeholder='14" Retina / 27" 4K' />
          </div>
          <div class="field">
            <label>Mainboard</label>
            <input id="hm-mainboard" type="text" value="${isEdit ? escapeHtml(hw.mainboard || '') : ''}" placeholder="ASUS Z790 / Apple silicon" />
          </div>
          <div class="field">
            <label>GPU</label>
            <input id="hm-gpu" type="text" value="${isEdit ? escapeHtml(hw.gpu || '') : ''}" placeholder="NVIDIA RTX 4070 / Apple M3 Pro 18-core" />
          </div>
          <div class="field">
            <label>Battery</label>
            <input id="hm-battery" type="text" value="${isEdit ? escapeHtml(hw.battery || '') : ''}" placeholder="Health 95% / 70 Wh" />
          </div>
          <div class="field">
            <label>UPS</label>
            <input id="hm-ups" type="text" value="${isEdit ? escapeHtml(hw.ups || '') : ''}" placeholder="APC BR1500MS2 / ไม่มี" />
          </div>
        </div>

        ${sect('💿', 'ระบบปฏิบัติการ')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>OS</label>
            <select id="hm-os" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
              <option value="">— เลือก —</option>
              ${['macOS', 'Windows 11', 'Windows 10', 'Ubuntu', 'Debian', 'อื่น ๆ'].map(o =>
                `<option value="${escapeHtml(o)}"${(isEdit && hw.os === o) ? ' selected' : ''}>${escapeHtml(o)}</option>`
              ).join('')}
            </select>
          </div>
          <div class="field">
            <label>OSX / Version</label>
            <input id="hm-os-version" type="text" value="${isEdit ? escapeHtml(hw.os_version || '') : ''}" placeholder="Sonoma 14.5 / Win11 23H2" />
          </div>
        </div>

        ${sect('🏢', 'แผนก / สถานที่ / การซื้อ')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>Department</label>
            <input id="hm-dept" type="text" value="${isEdit ? escapeHtml(hw.department || '') : ''}" placeholder="เช่น Marketing / IT / Design" />
          </div>
          <div class="field">
            <label>Location</label>
            <input id="hm-location" type="text" value="${isEdit ? escapeHtml(hw.location || '') : ''}" placeholder="เช่น HQ ชั้น 3 / Home Office" />
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>วันที่ซื้อ (เดือน/ปี)</label>
            ${purchInput}
          </div>
          <div class="field">
            <label>Quotation</label>
            <input id="hm-quotation" type="text" value="${isEdit ? escapeHtml(hw.quotation || '') : ''}" placeholder="เลข PO / ราคา / ใบเสนอราคา" />
          </div>
        </div>

        ${sect('📝', 'หมายเหตุ')}
        <div class="field">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px">หมวดหมายเหตุ</label>
          <select id="hm-note-category" onchange="(function(s){var t=document.getElementById('hm-notes');if(t)t.placeholder=({general:'หมายเหตุเพิ่มเติม (optional)',keep:'เหตุผลที่ยังไม่เปลี่ยน',procuring:'เหตุผลที่อยู่ระหว่างจัดหา',transferring:'ความคืบหน้าการ transfer ข้อมูล (เครื่องใหม่มาแล้ว)',transferring_rotation:'ความคืบหน้าการ transfer ข้อมูล (เครื่องจากการหมุนเวียน)'})[s.value]||'';})(this)" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;margin-bottom:8px">
            <option value="general" ${(!isEdit || !hw.note_category || hw.note_category === 'general') ? 'selected' : ''}>ทั่วไป — กรอกอะไรก็ได้</option>
            <option value="keep" ${(isEdit && hw.note_category === 'keep') ? 'selected' : ''}>ยังไม่เปลี่ยน — กรอกเหตุผลที่ยังไม่เปลี่ยน</option>
            <option value="procuring" ${(isEdit && hw.note_category === 'procuring') ? 'selected' : ''}>อยู่ระหว่างจัดหา — กรอกเหตุผล</option>
            <option value="transferring" ${(isEdit && hw.note_category === 'transferring') ? 'selected' : ''}>ได้เครื่องใหม่แล้ว — อยู่ระหว่าง transfer ข้อมูล</option>
            <option value="transferring_rotation" ${(isEdit && hw.note_category === 'transferring_rotation') ? 'selected' : ''}>ได้เครื่องใหม่แล้ว (เครื่องจากการหมุนเวียน) — อยู่ระหว่าง transfer ข้อมูล</option>
          </select>
          <textarea id="hm-notes" rows="3" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical" placeholder="${isEdit && hw.note_category === 'keep' ? 'เหตุผลที่ยังไม่เปลี่ยน' : (isEdit && hw.note_category === 'procuring' ? 'เหตุผลที่อยู่ระหว่างจัดหา' : (isEdit && hw.note_category === 'transferring' ? 'ความคืบหน้าการ transfer ข้อมูล (เครื่องใหม่มาแล้ว)' : (isEdit && hw.note_category === 'transferring_rotation' ? 'ความคืบหน้าการ transfer ข้อมูล (เครื่องจากการหมุนเวียน)' : 'หมายเหตุเพิ่มเติม (optional)')))}">${isEdit ? escapeHtml(hw.notes || '') : ''}</textarea>
        </div>
        <div class="field" style="margin-top:4px">
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px">
            <input type="checkbox" id="hm-personal-owned" ${isEdit && hw.is_personal_owned ? 'checked' : ''} style="width:17px;height:17px;accent-color:#7c3aed;cursor:pointer" />
            🙋 คอมพิวเตอร์ของตนเอง <span style="font-weight:500;color:var(--text-muted);font-size:12px">(เครื่องส่วนตัว / BYOD)</span>
          </label>
        </div>
        <div class="field" style="margin-top:4px">
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px">
            <input type="checkbox" id="hm-for-new-position" ${isEdit && hw.for_new_position ? 'checked' : ''} style="width:17px;height:17px;accent-color:#0ea5e9;cursor:pointer" />
            🆕 คอมฯสำหรับตำแหน่งเปิดใหม่ <span style="font-weight:500;color:var(--text-muted);font-size:12px">(สำรองรอพนักงานใหม่)</span>
          </label>
        </div>
        <div class="field" style="margin-top:4px">
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px">
            <input type="checkbox" id="hm-handed-down" ${isEdit && hw.is_handed_down ? 'checked' : ''} style="width:17px;height:17px;accent-color:#16a34a;cursor:pointer" />
            🔄 คอมฯส่งต่อมาจากท่านอื่น <span style="font-weight:500;color:var(--text-muted);font-size:12px">(มือสอง — ไม่นำไปคำนวณว่าควรเปลี่ยน)</span>
          </label>
        </div>
        <div class="field" style="margin-top:14px;padding-top:10px;border-top:1px dashed var(--border)">
          <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">สถานะคอมฯเก่า (เมื่อได้รับเครื่องนี้)</div>
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px;margin-bottom:6px">
            <input type="checkbox" id="hm-oldpc-bought" ${isEdit && hw.old_pc_bought_by_employee ? 'checked' : ''} style="width:17px;height:17px;accent-color:#f59e0b;cursor:pointer" />
            💵 คอมฯเก่า พนักงานซื้อไป <span style="font-weight:500;color:var(--text-muted);font-size:12px">(พนักงานเดิมซื้อคอมฯเก่ากลับไปใช้เอง)</span>
          </label>
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px;margin-bottom:6px">
            <input type="checkbox" id="hm-oldpc-broken" ${isEdit && hw.old_pc_broken ? 'checked' : ''} style="width:17px;height:17px;accent-color:#dc2626;cursor:pointer" />
            🛠 คอมฯเก่า ชำรุดซ่อมไม่ได้ <span style="font-weight:500;color:var(--text-muted);font-size:12px">(เสียหายเกินซ่อม)</span>
          </label>
          <label style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:600;font-size:13.5px">
            <input type="checkbox" id="hm-oldpc-donated" ${isEdit && hw.old_pc_donated_sold ? 'checked' : ''} style="width:17px;height:17px;accent-color:#0ea5e9;cursor:pointer" />
            🎁 คอมฯเก่า บริจาค หรือ จำหน่าย <span style="font-weight:500;color:var(--text-muted);font-size:12px">(ให้องค์กรอื่น / ขายทอดตลาด)</span>
          </label>
        </div>
          </div><!-- /right column -->
        </div><!-- /2-col flex -->
        </div><!-- /details pane -->

        <!-- v1.9.64 — Tab: ผู้ดูแลปัจจุบัน + ประวัติ -->
        <div class="hm-tab-pane" data-hm-pane="owner" style="display:none">
          ${sect('👤', 'ผู้ดูแลปัจจุบัน')}
          <div class="field">
            <label>เลือกผู้ดูแล</label>
            ${ownerPickerHtml}
            <div class="hint" style="font-size:11.5px;color:var(--text-muted);margin-top:4px">${isEdit ? 'เปลี่ยน owner → ปิด assignment เก่า (set วันสิ้นสุด = ปัจจุบัน) + เปิดใหม่อัตโนมัติ — เก็บประวัติให้ในแท็บนี้' : 'จะสร้าง initial assignment ให้อัตโนมัติหลังบันทึกครั้งแรก'}</div>
          </div>

          <!-- v1.9.65 — เมื่อเลือก 'ไม่ผูก' → แสดงช่องระบุทีม/แผนกที่สังกัด + ที่เก็บเครื่อง -->
          <div id="hm-unlinked-fields" style="${(isEdit && hw.current_member_id) ? 'display:none' : ''};padding:12px 14px;background:rgba(245,158,11,.06);border:1px dashed rgba(245,158,11,.4);border-radius:10px;margin-top:10px">
            <div style="font-size:11.5px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📦 เครื่องที่ยังไม่ผูก owner — ระบุที่สังกัด + ที่เก็บ</div>
            <div class="field">
              <label>ทีม/แผนก ที่เครื่องนี้สังกัด (เลือกจากต้นไม้)</label>
              <select id="hm-unassigned-team" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
                ${(() => {
                  const tree = buildTeamTree(_hwTeamsCache);
                  const flat = flattenTeamTreeDFS(tree);
                  const cid = (isEdit && hw.unassigned_team_id != null) ? hw.unassigned_team_id : null;
                  let html = '<option value="">— ไม่ระบุ —</option>';
                  for (const { team, depth } of flat) {
                    const indent = '    '.repeat(depth);
                    const arrow = depth > 0 ? '↳ ' : '';
                    const sel = (cid === team.id) ? ' selected' : '';
                    html += `<option value="${team.id}"${sel}>${escapeHtml(indent + arrow + team.name)}</option>`;
                  }
                  return html;
                })()}
              </select>
            </div>
            <div class="field" style="margin-top:8px">
              <label>ตำแหน่งเก็บ (เช่น 'ตู้ A-1 ห้อง IT', 'Stock ชั้น 3')</label>
              <input id="hm-storage-location" type="text" value="${isEdit ? escapeHtml(hw.storage_location || '') : ''}" placeholder="เช่น ตู้ A-1 ห้อง IT" />
            </div>
          </div>

          ${isEdit ? `
            ${sect('📜', 'ประวัติการครอบครอง')}
            <button type="button" class="btn" onclick="_addOwnershipHistory(${hw.id})" style="font-size:12px;margin-bottom:8px">+ เพิ่มผู้เคยครอบครอง (ย้อนหลัง)</button>
            <div id="hm-history-list" style="display:flex;flex-direction:column;gap:6px"><div class="empty" style="padding:18px;font-size:12.5px">กำลังโหลด…</div></div>
          ` : `
            <div class="hint" style="margin-top:14px;font-size:12px;color:var(--text-muted);font-style:italic">📜 ประวัติการครอบครองจะปรากฏหลังบันทึกครั้งแรก</div>
          `}
        </div>

        <!-- v1.9.82 — Tab: Financial Document (ผูกเอกสารสั่งซื้อกับอุปกรณ์นี้) -->
        ${isEdit ? `
        <div class="hm-tab-pane" data-hm-pane="findoc" style="display:none">
          ${sect('💰', 'Financial Document ที่ผูกอยู่')}
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
            <div class="hint" style="font-size:12px;color:var(--text-muted);margin:0">เอกสารการสั่งซื้อ/ใบสั่งจ่ายที่เกี่ยวกับอุปกรณ์นี้ — กดผูกได้หลายชุด</div>
            <button type="button" class="btn primary" id="hm-findoc-link-btn" style="font-size:12.5px;padding:6px 12px">+ ผูกเอกสาร</button>
          </div>
          <div id="hm-findoc-list" style="display:flex;flex-direction:column;gap:6px"><div class="empty" style="padding:18px;font-size:12.5px">กำลังโหลด…</div></div>
        </div>
        ` : ''}

        <!-- v1.9.291 — Tab: สถานะ (ประวัติหมายเหตุ + checkbox ใหม่บนสุด + ผู้กรอก) -->
        ${isEdit ? `
        <div class="hm-tab-pane" data-hm-pane="status" style="display:none">
          ${sect('📊', 'ประวัติสถานะ')}
          <div class="hint" style="font-size:12px;color:var(--text-muted);margin:0 0 12px">บันทึกทุกครั้งที่แก้ไข <b>หมายเหตุ</b> หรือติ๊ก checkbox สถานะ (คอมฯของตนเอง / ตำแหน่งเปิดใหม่ / ส่งต่อมา) — รายการใหม่อยู่บนสุด พร้อมชื่อผู้กรอก</div>
          <div id="hm-status-list" style="display:flex;flex-direction:column;gap:8px"><div class="empty" style="padding:18px;font-size:12.5px">กำลังโหลด…</div></div>
        </div>
        ` : ''}
      ` : `
        <!-- Device / Network — keep simpler form -->
        <div class="field">
          <label>ชื่อ *</label>
          <input id="hm-name" type="text" value="${isEdit ? escapeHtml(hw.name) : ''}" placeholder="${type === 'network' ? 'เช่น Cisco Switch 24-port' : 'เช่น External HDD WD My Passport 1TB'}" />
        </div>
        ${showDevice ? `
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <div class="field">
              <label>ประเภท Device</label>
              <input id="hm-subtype" type="text" list="hm-subtype-list" value="${isEdit ? escapeHtml(hw.device_subtype || '') : ''}" placeholder="เลือกหรือพิมพ์เอง..." />
              <datalist id="hm-subtype-list">
                ${HW_DEVICE_SUBTYPES.map(s => `<option value="${escapeHtml(s)}"></option>`).join('')}
              </datalist>
            </div>
            <div class="field">
              <label>ความจุ / Spec</label>
              <input id="hm-capacity" type="text" value="${isEdit ? escapeHtml(hw.capacity || '') : ''}" placeholder='1TB / 4K 27"' />
            </div>
          </div>
        ` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="field">
            <label>เลข Asset</label>
            <input id="hm-asset" type="text" value="${isEdit ? escapeHtml(hw.asset_number || '') : ''}" placeholder="เช่น A-001" />
          </div>
          <div class="field">
            <label>วันที่ซื้อ</label>
            ${purchInput}
          </div>
        </div>
        <div class="field">
          <label>ผู้ดูแลปัจจุบัน (Owner)</label>
          ${ownerPickerHtml}
        </div>
        <div class="field">
          <label>รูปภาพ</label>
          <div style="display:flex;gap:14px;align-items:flex-start;margin-top:6px">
            <div id="hm-photo-preview" style="width:120px;height:90px;border-radius:8px;border:1.5px dashed var(--border);background:${(isEdit && hw.photo_data) ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
              ${(isEdit && hw.photo_data)
                ? `<img src="${hw.photo_data}" alt="photo" style="width:100%;height:100%;object-fit:cover" />`
                : `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>รูปภาพ</span>`
              }
            </div>
            <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
              <button type="button" class="btn" id="hm-photo-upload-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">📷 อัพโหลดไฟล์...</button>
              <button type="button" class="btn" id="hm-photo-camera-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">📸 ถ่ายรูปจากกล้อง</button>
              <button type="button" class="btn danger" id="hm-photo-remove-btn" style="font-size:12.5px;padding:7px 12px;text-align:left;${(isEdit && hw.photo_data) ? '' : 'display:none'}">🗑 ลบรูป</button>
              <input type="file" id="hm-photo-file-input" accept="image/*" style="display:none" />
            </div>
          </div>
          <input type="hidden" id="hm-photo-data" value="${escapeHtml((isEdit && hw.photo_data) || '')}" />
        </div>
        <div class="field">
          <label>หมายเหตุ</label>
          <textarea id="hm-notes" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical">${isEdit ? escapeHtml(hw.notes || '') : ''}</textarea>
        </div>
      `}
    `,
    onSubmit: async () => {
      const data = {
        name: $('hm-name').value.trim(),
        asset_number: $('hm-asset').value.trim() || null,
        purchased_at: $('hm-purchased').value || null,
        notes: $('hm-notes').value.trim() || null,
        note_category: $('hm-note-category') ? $('hm-note-category').value : null,
        current_member_id: $('hm-owner').value ? parseInt($('hm-owner').value, 10) : null,
      };
      if (showPC) {
        data.os = $('hm-os').value || null;
        data.cpu = $('hm-cpu').value.trim() || null;
        data.ram = $('hm-ram').value.trim() || null;
        data.storage = $('hm-storage').value.trim() || null;
        // Extended PC fields (v1.9.38)
        data.model = $('hm-model').value.trim() || null;
        data.serial_number = $('hm-serial').value.trim() || null;
        data.display = $('hm-display').value.trim() || null;
        data.department = $('hm-dept').value.trim() || null;
        data.location = $('hm-location').value.trim() || null;
        data.os_version = $('hm-os-version').value.trim() || null;
        data.mainboard = $('hm-mainboard').value.trim() || null;
        data.gpu = $('hm-gpu').value.trim() || null;
        data.battery = $('hm-battery').value.trim() || null;
        data.ups = $('hm-ups').value.trim() || null;
        data.status = $('hm-status').value || null;
        data.quotation = $('hm-quotation').value.trim() || null;
        data.is_personal_owned = $('hm-personal-owned') ? $('hm-personal-owned').checked : false;
        data.for_new_position = $('hm-for-new-position') ? $('hm-for-new-position').checked : false;
        data.is_handed_down = $('hm-handed-down') ? $('hm-handed-down').checked : false;
        // v1.9.329 — สถานะคอมเก่า
        data.old_pc_bought_by_employee = $('hm-oldpc-bought') ? $('hm-oldpc-bought').checked : false;
        data.old_pc_broken = $('hm-oldpc-broken') ? $('hm-oldpc-broken').checked : false;
        data.old_pc_donated_sold = $('hm-oldpc-donated') ? $('hm-oldpc-donated').checked : false;
        // v1.9.65 — unlinked fields: ส่งเฉพาะ unassigned_team_id + storage_location
        // (เก็บเสมอ ไม่ว่าจะมี owner หรือไม่ — ถ้ามี owner ก็ยังเก็บเผื่อ admin ระบุไว้)
        const untSel = $('hm-unassigned-team');
        if (untSel) {
          const v = untSel.value;
          data.unassigned_team_id = v ? parseInt(v, 10) : null;
        }
        const stLoc = $('hm-storage-location');
        if (stLoc) data.storage_location = stLoc.value.trim() || null;
      }
      if (showDevice) {
        data.device_subtype = $('hm-subtype').value.trim() || null;
        data.capacity = $('hm-capacity').value.trim() || null;
      }
      // Photo — ส่งเฉพาะถ้าเปลี่ยน
      const photoEl = $('hm-photo-data');
      if (photoEl) {
        const cur = photoEl.value;
        const initial = photoEl.dataset.initial || '';
        if (cur !== initial) {
          data.photo_data = cur;   // '' = clear, non-empty = set
        }
      }
      // v1.9.50 — Asset photo (PC form เท่านั้น)
      const assetPhotoEl = $('hm-asset-photo-data');
      if (assetPhotoEl) {
        const cur = assetPhotoEl.value;
        const initial = assetPhotoEl.dataset.initial || '';
        if (cur !== initial) {
          data.asset_photo_data = cur;
        }
      }
      if (!data.name) throw new Error('กรอกชื่อ');
      const url = isEdit ? `/api/admin/hardware/${hw.id}` : '/api/admin/hardware';
      const method = isEdit ? 'PATCH' : 'POST';
      // POST ต้องระบุ hw_type
      if (!isEdit) data.hw_type = type;
      await fetchJson(url, { method, body: JSON.stringify(data) });
      // v1.9.62 — ใช้ afterSubmit ถ้ามี (เปิดจาก Team detail) — ไม่งั้น default reload hardware list
      if (typeof afterSubmit === 'function') {
        await afterSubmit();
      } else {
        await loadHardware();
      }
    },
  });

  // ---- v1.9.71 — ย้าย #m-cancel + #m-ok ไปแถวบนขวา + sticky (v1.9.72: รวมปุ่มยกเลิก) ----
  setTimeout(() => {
    const modal = document.querySelector('.modal-bg .modal');
    if (!modal) return;
    const h3 = modal.querySelector(':scope > h3');
    const okBtn = modal.querySelector('#m-ok');
    const cancelBtn = modal.querySelector('#m-cancel');
    if (!h3 || !okBtn) return;
    if (h3.parentElement && h3.parentElement.dataset.hmSticky === '1') return;
    const wrap = document.createElement('div');
    wrap.dataset.hmSticky = '1';
    wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:14px;margin:-26px -26px 14px;padding:18px 26px;background:var(--bg-card);border-bottom:1px solid var(--border);position:sticky;top:-26px;z-index:5;flex-wrap:wrap';
    h3.style.margin = '0';
    h3.style.flex = '1';
    h3.style.minWidth = '0';
    modal.insertBefore(wrap, h3);
    wrap.appendChild(h3);
    // กลุ่มปุ่ม cancel + ok ขวาสุด
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:6px;flex-shrink:0';
    if (cancelBtn) {
      cancelBtn.style.fontSize = '13px';
      cancelBtn.style.padding = '7px 14px';
      btnGroup.appendChild(cancelBtn);
    }
    okBtn.style.fontSize = '13px';
    okBtn.style.padding = '7px 16px';
    btnGroup.appendChild(okBtn);
    wrap.appendChild(btnGroup);
    // ซ่อน modal-actions ด้านล่าง (ปุ่มย้ายขึ้นมาบนหมดแล้ว)
    const bottomActions = modal.querySelector(':scope > .modal-actions');
    if (bottomActions) bottomActions.style.display = 'none';
  }, 0);

  // ---- v1.9.64 — Tab switching (PC only) ----
  if (showPC) {
    document.querySelectorAll('.modal-bg .modal .hm-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.hmTab;
        document.querySelectorAll('.modal-bg .modal .hm-tab').forEach(b => {
          const active = b === btn;
          b.style.color = active ? 'var(--primary)' : 'var(--text-muted)';
          b.style.fontWeight = active ? '600' : '500';
          b.style.borderBottom = active ? '2px solid var(--primary)' : '';
        });
        document.querySelectorAll('.modal-bg .modal .hm-tab-pane').forEach(p => {
          p.style.display = (p.dataset.hmPane === target) ? '' : 'none';
        });
        // โหลด history เฉพาะตอนคลิก tab owner ครั้งแรก (lazy)
        if (target === 'owner' && isEdit && hw && hw.id && !btn.dataset.hmHistoryLoaded) {
          btn.dataset.hmHistoryLoaded = '1';
          loadHmHistory(hw.id);
        }
        // v1.9.82 — โหลด financial documents tab (lazy)
        if (target === 'findoc' && isEdit && hw && hw.id && !btn.dataset.hmFindocLoaded) {
          btn.dataset.hmFindocLoaded = '1';
          loadHmFinDocs(hw.id);
        }
        // v1.9.291 — โหลด tab สถานะ (lazy)
        if (target === 'status' && isEdit && hw && hw.id && !btn.dataset.hmStatusLoaded) {
          btn.dataset.hmStatusLoaded = '1';
          loadHmStatusLog(hw.id);
        }
      });
    });
    // โหลด history เลยเพื่อให้ user ที่กด tab เห็นทันที (background — ไม่ block)
    if (isEdit && hw && hw.id) {
      loadHmHistory(hw.id);
      loadHmFinDocs(hw.id);   // v1.9.82 — eager-load findoc tab
    }
    // v1.9.82 — wire ปุ่ม + ผูกเอกสาร
    const linkBtn = document.querySelector('.modal-bg .modal #hm-findoc-link-btn');
    if (linkBtn) {
      linkBtn.addEventListener('click', async () => {
        _findocHwIdForPicker = hw.id;
        // ดึง linked ปัจจุบันจาก DOM (data-hm-findoc-unlink) เพื่อ pre-mark ใน picker
        const linkedIds = Array.from(document.querySelectorAll('.modal-bg .modal button[data-hm-findoc-unlink]'))
          .map(b => parseInt(b.dataset.hmFindocUnlink, 10));
        showHmFinDocPickerModal(hw.id, linkedIds);
      });
    }
  }

  // ---- Owner picker wiring (after modal in DOM) ----
  // v1.9.65 — onChange → toggle unlinked-fields visibility
  wireHwOwnerPicker((newMemberId) => {
    const el = document.getElementById('hm-unlinked-fields');
    if (el) el.style.display = newMemberId ? 'none' : '';
  });

  // ---- Photo wiring (after modal in DOM) ----
  const photoEl = $('hm-photo-data');
  if (photoEl) photoEl.dataset.initial = photoEl.value;

  const setHmPhoto = (dataUrl) => {
    const el = $('hm-photo-data');
    const preview = $('hm-photo-preview');
    const removeBtn = $('hm-photo-remove-btn');
    if (!el || !preview) return;
    el.value = dataUrl || '';
    if (dataUrl) {
      preview.style.background = 'var(--bg-card)';
      preview.innerHTML = `<img src="${dataUrl}" alt="photo" style="width:100%;height:100%;object-fit:cover" />`;
      if (removeBtn) removeBtn.style.display = '';
    } else {
      preview.style.background = 'var(--bg-soft)';
      preview.innerHTML = `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>รูปภาพ</span>`;
      if (removeBtn) removeBtn.style.display = 'none';
    }
  };
  // Crop config สำหรับ hardware photo: 4:3 landscape, JPEG, 640x480
  const cropOpts = {
    aspectRatio: 4 / 3,
    outputWidth: 640,
    outputHeight: 480,
    outputType: 'image/jpeg',
    outputQuality: 0.85,
    title: '✂️ Crop รูปภาพ (สัดส่วน 4:3)',
  };
  // Upload
  const fileInput = $('hm-photo-file-input');
  $('hm-photo-upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => openCropModal(ev.target.result, setHmPhoto, cropOpts);
    reader.readAsDataURL(file);
    fileInput.value = '';
  });
  // Camera — openCameraModal forward cropOpts → openCropModal ครั้งเดียว
  $('hm-photo-camera-btn').addEventListener('click', () => {
    openCameraModal(setHmPhoto, cropOpts);
  });
  // Remove
  $('hm-photo-remove-btn').addEventListener('click', () => {
    if (!confirm('ลบรูปของรายการนี้?')) return;
    setHmPhoto('');
  });

  // ---- v1.9.50: Asset photo wiring (PC form เท่านั้น — element อาจไม่มี) ----
  const assetPhotoEl = $('hm-asset-photo-data');
  if (assetPhotoEl) {
    assetPhotoEl.dataset.initial = assetPhotoEl.value;
    const setHmAssetPhoto = (dataUrl) => {
      const el = $('hm-asset-photo-data');
      const preview = $('hm-asset-photo-preview');
      const removeBtn = $('hm-asset-photo-remove-btn');
      if (!el || !preview) return;
      el.value = dataUrl || '';
      if (dataUrl) {
        preview.style.background = 'var(--bg-card)';
        preview.innerHTML = `<img src="${dataUrl}" alt="asset-photo" style="width:100%;height:100%;object-fit:cover" />`;
        if (removeBtn) removeBtn.style.display = '';
      } else {
        preview.style.background = 'var(--bg-soft)';
        preview.innerHTML = `<span style="color:var(--text-muted);font-size:10.5px;text-align:center;line-height:1.3">📸<br/>ภาพ asset</span>`;
        if (removeBtn) removeBtn.style.display = 'none';
      }
    };
    // Crop config — 4:3, 640x480, JPEG (เหมือน photo หลัก) เพื่อ consistency
    const assetCropOpts = {
      aspectRatio: 4 / 3,
      outputWidth: 640,
      outputHeight: 480,
      outputType: 'image/jpeg',
      outputQuality: 0.85,
      title: '✂️ Crop รูปหมายเลข asset (สัดส่วน 4:3)',
    };
    const assetFileInput = $('hm-asset-photo-file-input');
    $('hm-asset-photo-upload-btn').addEventListener('click', () => assetFileInput.click());
    assetFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => openCropModal(ev.target.result, setHmAssetPhoto, assetCropOpts);
      reader.readAsDataURL(file);
      assetFileInput.value = '';
    });
    $('hm-asset-photo-camera-btn').addEventListener('click', () => {
      openCameraModal(setHmAssetPhoto, assetCropOpts);
    });
    $('hm-asset-photo-remove-btn').addEventListener('click', () => {
      if (!confirm('ลบรูปหมายเลข asset?')) return;
      setHmAssetPhoto('');
    });
    // v1.9.69 — OCR button: อ่านเลข asset จากรูป + ปุ่ม Copy ใส่ในช่อง Asset
    const ocrBtn = $('hm-asset-photo-ocr-btn');
    const ocrResult = $('hm-asset-ocr-result');
    const ocrText = $('hm-asset-ocr-text');
    if (ocrBtn) {
      ocrBtn.addEventListener('click', async () => {
        const dataUrl = $('hm-asset-photo-data').value;
        if (!dataUrl) {
          alert('กรุณาอัพโหลดภาพหมายเลข asset ก่อน');
          return;
        }
        const orig = ocrBtn.textContent;
        ocrBtn.disabled = true;
        ocrBtn.textContent = '⏳ กำลังอ่าน...';
        try {
          const text = await ocrImage(dataUrl, 'eng', (m) => {
            // progress: m.status / m.progress (0..1)
            if (m && m.status && typeof m.progress === 'number') {
              const pct = Math.round(m.progress * 100);
              ocrBtn.textContent = `⏳ ${m.status} ${pct}%`;
            }
          });
          if (ocrText) ocrText.value = guessAssetFromOcrText(text);
          if (ocrResult) ocrResult.style.display = '';
        } catch (e) {
          alert('OCR ผิดพลาด: ' + e.message);
        } finally {
          ocrBtn.disabled = false;
          ocrBtn.textContent = orig;
        }
      });
    }
    const ocrApply = $('hm-asset-ocr-apply');
    if (ocrApply) {
      ocrApply.addEventListener('click', () => {
        const v = (ocrText.value || '').trim();
        if (!v) { alert('ผลการอ่านว่างเปล่า — แก้ใน textarea ก่อน'); return; }
        const assetInput = $('hm-asset');
        if (assetInput) {
          assetInput.value = v;
          assetInput.focus();
          assetInput.style.background = 'rgba(16,185,129,.10)';
          setTimeout(() => { assetInput.style.background = ''; }, 1200);
        }
        if (ocrResult) ocrResult.style.display = 'none';
      });
    }
    const ocrClose = $('hm-asset-ocr-close');
    if (ocrClose) {
      ocrClose.addEventListener('click', () => {
        if (ocrResult) ocrResult.style.display = 'none';
      });
    }
  }
}

// v1.9.64 — โหลด+render ประวัติการครอบครองสำหรับ tab 'ผู้ดูแลปัจจุบัน' ใน showHardwareModal
// v1.9.82 — Hardware ↔ Financial Documents (M:N)
async function loadHmFinDocs(hwId) {
  let items = [];
  try {
    const d = await fetchJson(`/api/admin/hardware/${hwId}/financial-documents`);
    items = d.documents || [];
  } catch (_) { /* ignore */ }
  renderHmFinDocList(hwId, items);
}

// v1.9.291 — ประวัติสถานะ (หมายเหตุ + checkbox) ใหม่บนสุด + ผู้กรอก
async function loadHmStatusLog(hwId) {
  const el = $('hm-status-list');
  if (!el) return;
  let log = [];
  try {
    const d = await fetchJson(`/api/admin/hardware/${hwId}/status-log`);
    log = d.log || [];
  } catch (e) { el.innerHTML = '<div class="empty" style="padding:16px;font-size:12.5px">โหลดประวัติสถานะไม่ได้</div>'; return; }
  if (!log.length) { el.innerHTML = '<div class="empty" style="padding:16px;font-size:12.5px">ยังไม่มีประวัติสถานะ — จะเริ่มบันทึกเมื่อมีการแก้ไขหมายเหตุ/สถานะครั้งถัดไป</div>'; return; }
  const catLabel = { keep: '🔸 ยังไม่เปลี่ยน', procuring: '🛒 อยู่ระหว่างจัดหา', transferring: '🔄 ได้เครื่องใหม่ — transfer', transferring_rotation: '♻️ ได้เครื่องใหม่ (หมุนเวียน) — transfer' };
  const chip = (bg, c, t) => `<span style="display:inline-flex;align-items:center;font-size:10.5px;font-weight:700;background:${bg};color:${c};padding:2px 9px;border-radius:999px">${t}</span>`;
  const fmtTime = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d.getTime()) ? escapeHtml(String(iso)) : d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  el.innerHTML = log.map((e, i) => {
    const isCurrent = i === 0;
    const chips = [];
    if (e.note_category && catLabel[e.note_category]) chips.push(chip('var(--bg-soft)', 'var(--text)', catLabel[e.note_category]));
    if (e.is_personal_owned) chips.push(chip('rgba(124,58,237,.12)', '#7c3aed', '🙋 คอมฯของตนเอง'));
    if (e.for_new_position) chips.push(chip('rgba(14,165,233,.12)', '#0284c7', '🆕 ตำแหน่งเปิดใหม่'));
    if (e.is_handed_down) chips.push(chip('rgba(22,163,74,.12)', '#16a34a', '🔄 ส่งต่อมาจากท่านอื่น'));
    const who = e.created_by ? escapeHtml(e.created_by) : (e.synthetic ? 'ยังไม่มีประวัติการแก้ไข' : '—');
    return `
      <div class="card" style="padding:11px 13px;border-left:3px solid ${isCurrent ? 'var(--primary)' : 'var(--border)'}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:${(chips.length || e.notes) ? '7' : '0'}px">
          ${isCurrent ? '<span style="font-size:10.5px;font-weight:800;background:rgba(37,99,235,.12);color:var(--primary);padding:2px 9px;border-radius:999px">● ปัจจุบัน</span>' : '<span style="font-size:10.5px;color:var(--text-muted)">ประวัติ</span>'}
          <span style="font-size:11px;color:var(--text-muted);white-space:nowrap">🕒 ${fmtTime(e.created_at)}</span>
        </div>
        ${chips.length ? `<div style="display:flex;flex-wrap:wrap;gap:5px;${e.notes ? 'margin-bottom:7px' : ''}">${chips.join('')}</div>` : ''}
        ${e.notes ? `<div style="font-size:12.5px;color:var(--text);background:var(--bg-soft);padding:7px 10px;border-radius:7px;line-height:1.5;white-space:pre-wrap">📝 ${escapeHtml(e.notes)}</div>` : (chips.length ? '' : '<div style="font-size:12px;color:var(--text-muted);font-style:italic">— ไม่มีหมายเหตุ/สถานะ —</div>')}
        <div style="font-size:11px;color:var(--text-muted);margin-top:7px">✍️ ${who}</div>
      </div>`;
  }).join('');
}

function renderHmFinDocList(hwId, items) {
  const el = $('hm-findoc-list');
  if (!el) return;
  if (items.length === 0) {
    el.innerHTML = '<div class="empty" style="padding:14px;font-size:12.5px">ยังไม่มีเอกสารผูกอยู่ — กด <strong>+ ผูกเอกสาร</strong></div>';
    return;
  }
  el.innerHTML = items.map(d => {
    const thumb = d.first_page_image
      ? `<img src="${d.first_page_image}" alt="" style="width:54px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--border);flex-shrink:0;display:block" />`
      : `<div style="width:54px;height:72px;border-radius:6px;border:1px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px">📄</div>`;
    return `
      <div class="card" style="display:flex;align-items:center;gap:10px;padding:9px 11px">
        ${thumb}
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.name)}</div>
          <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">📅 ${escapeHtml(fmtFinDocDate(d.doc_date))} · 📃 ${d.page_count} หน้า</div>
          <div style="font-size:12px;font-weight:700;color:var(--green);margin-top:2px;font-variant-numeric:tabular-nums">${escapeHtml(fmtFinDocAmount(d.amount, d.currency))}</div>
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;flex-direction:column">
          <button type="button" class="btn" data-hm-findoc-open="${d.id}" style="font-size:11.5px;padding:4px 9px" title="ดูเอกสาร">📖</button>
          <button type="button" class="btn danger" data-hm-findoc-unlink="${d.id}" data-hm-findoc-name="${escapeHtml(d.name)}" style="font-size:11.5px;padding:4px 9px" title="ปลดล็อก">🔗❌</button>
        </div>
      </div>
    `;
  }).join('');
  el.querySelectorAll('button[data-hm-findoc-unlink]').forEach(b => {
    b.addEventListener('click', async () => {
      const did = parseInt(b.dataset.hmFindocUnlink, 10);
      const nm = b.dataset.hmFindocName || '';
      if (!confirm(`ปลดล็อก "${nm}" จากอุปกรณ์นี้?\n(เอกสารไม่ถูกลบ แค่ปลด link)`)) return;
      try {
        await fetchJson(`/api/admin/hardware/${hwId}/financial-documents/${did}`, { method: 'DELETE' });
        await loadHmFinDocs(hwId);
      } catch (e) { alert('ปลดล็อกไม่สำเร็จ: ' + e.message); }
    });
  });
  el.querySelectorAll('button[data-hm-findoc-open]').forEach(b => {
    b.addEventListener('click', () => {
      const did = parseInt(b.dataset.hmFindocOpen, 10);
      // เปิดเอกสารในแท็บใหม่ของระบบ (ผ่าน hash route)
      _findocViewMode = 'detail';
      _findocCurrentId = did;
      location.hash = '#/financial-documents';
      // ปิด modal hardware ปัจจุบัน
      const bg = document.querySelector('.modal-bg');
      if (bg) bg.remove();
      renderFinDocDetailPage(did);
    });
  });
}

function showHmFinDocPickerModal(hwId, currentLinkedIds) {
  showModal({
    title: '+ ผูก Financial Document',
    size: 'wide',
    body: `
      <div class="hint" style="margin-bottom:10px;color:var(--text-muted);font-size:12px">เลือกเอกสารที่ต้องการผูกกับอุปกรณ์นี้ (เลือกได้หลายชุด)</div>
      <input id="hmfdp-search" type="text" placeholder="🔍 ค้นหาชื่อ / vendor..." autocomplete="off"
        style="width:100%;padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box" />
      <div id="hmfdp-tags" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div>
      <div id="hmfdp-count" style="font-size:11.5px;color:var(--text-muted);margin-top:6px">กำลังโหลด...</div>
      <div id="hmfdp-list" style="margin-top:8px;max-height:380px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);padding:6px;display:flex;flex-direction:column;gap:4px">
        <div class="empty" style="padding:14px;font-size:12.5px">กำลังโหลด...</div>
      </div>
    `,
    onSubmit: async () => { /* no submit — instant link on click */ },
  });
  setTimeout(() => {
    const okBtn = document.querySelector('.modal-bg .modal #m-ok');
    if (okBtn) okBtn.style.display = 'none';
  }, 10);
  // load all financial documents
  let allDocs = [];
  let q = '';
  let tagFilter = [];   // v1.9.302 — filter ตามหมวด (tag)
  fetchJson('/api/admin/financial-documents').then(d => {
    allDocs = d.documents || [];
    // v1.9.302 — เรียงตามวันที่ล่าสุด (doc_date → created_at) ใหม่→เก่า
    allDocs.sort((a, b) => (b.doc_date || b.created_at || '').localeCompare(a.doc_date || a.created_at || ''));
    refreshList();
  }).catch(e => {
    const el = $('hmfdp-list');
    if (el) el.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
  });
  const linkedSet = new Set(currentLinkedIds);
  function refreshList() {
    const ql = q.trim().toLowerCase();
    // v1.9.302 — tag filter bar (capsule)
    const tagsOf = (d) => (d.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const allTags = [...new Set(allDocs.flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'th'));
    tagFilter = tagFilter.filter(t => allTags.includes(t));
    const tagsEl = $('hmfdp-tags');
    if (tagsEl) {
      const chip = (label, active, attr) => `<button type="button" ${attr} style="border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--bg-card)'};color:${active ? '#fff' : 'var(--text-muted)'};font-size:11.5px;font-weight:600;padding:4px 11px;border-radius:999px;cursor:pointer;font-family:inherit">${label}</button>`;
      tagsEl.innerHTML = allTags.length
        ? `<span style="font-size:11.5px;color:var(--text-muted);font-weight:700;align-self:center">🏷️</span>${chip('ทั้งหมด', tagFilter.length === 0, 'data-hmfdp-fall="1"')}${allTags.map(t => chip(escapeHtml(t), tagFilter.includes(t), `data-hmfdp-ftag="${encodeURIComponent(t)}"`)).join('')}`
        : '';
      tagsEl.querySelectorAll('[data-hmfdp-fall]').forEach(b => b.addEventListener('click', () => { tagFilter = []; refreshList(); }));
      tagsEl.querySelectorAll('[data-hmfdp-ftag]').forEach(b => b.addEventListener('click', () => { const t = decodeURIComponent(b.dataset.hmfdpFtag); const i = tagFilter.indexOf(t); if (i >= 0) tagFilter.splice(i, 1); else tagFilter.push(t); refreshList(); }));
    }
    const filtered = allDocs.filter(d => {
      const matchQ = !ql || (d.name || '').toLowerCase().includes(ql) || (d.vendor || '').toLowerCase().includes(ql);
      if (!matchQ) return false;
      if (tagFilter.length) { const ts = tagsOf(d); return tagFilter.some(f => ts.includes(f)); }
      return true;
    });
    const countEl = $('hmfdp-count');
    if (countEl) countEl.textContent = (ql || tagFilter.length) ? `แสดง ${filtered.length} / ${allDocs.length} ชุด` : `ทั้งหมด ${allDocs.length} ชุด`;
    const listEl = $('hmfdp-list');
    if (!listEl) return;
    if (filtered.length === 0) {
      listEl.innerHTML = `<div class="empty" style="padding:14px;font-size:12.5px">${ql ? `ไม่พบเอกสารที่ตรง "${escapeHtml(q)}"` : 'ยังไม่มีเอกสารในระบบ'}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map(d => {
      const isLinked = linkedSet.has(d.id);
      const thumb = d.first_page_image
        ? `<img src="${d.first_page_image}" style="width:42px;height:56px;object-fit:cover;border-radius:5px;border:1px solid var(--border);flex-shrink:0;display:block" />`
        : `<div style="width:42px;height:56px;border-radius:5px;border:1px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">📄</div>`;
      return `
        <div data-hmfdp-id="${d.id}" data-linked="${isLinked ? 1 : 0}" style="display:flex;align-items:center;gap:10px;padding:7px 9px;border-radius:6px;background:${isLinked ? 'rgba(16,185,129,.08)' : 'transparent'};border:1px solid ${isLinked ? 'rgba(16,185,129,.3)' : 'transparent'}">
          ${thumb}
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">📅 ${escapeHtml(fmtFinDocDate(d.doc_date))} · ${escapeHtml(fmtFinDocAmount(d.amount, d.currency))}</div>
          </div>
          <button type="button" data-hmfdp-toggle="${d.id}" class="btn ${isLinked ? '' : 'primary'}" style="font-size:11.5px;padding:5px 11px;flex-shrink:0">${isLinked ? '✓ ผูกแล้ว' : '➕ ผูก'}</button>
        </div>
      `;
    }).join('');
    listEl.querySelectorAll('button[data-hmfdp-toggle]').forEach(b => {
      b.addEventListener('click', async () => {
        const did = parseInt(b.dataset.hmfdpToggle, 10);
        const wasLinked = linkedSet.has(did);
        b.disabled = true;
        const orig = b.textContent;
        b.textContent = '...';
        try {
          if (wasLinked) {
            await fetchJson(`/api/admin/hardware/${_findocHwIdForPicker}/financial-documents/${did}`, { method: 'DELETE' });
            linkedSet.delete(did);
          } else {
            await fetchJson(`/api/admin/hardware/${_findocHwIdForPicker}/financial-documents`, {
              method: 'POST', body: JSON.stringify({ document_id: did }),
            });
            linkedSet.add(did);
          }
          refreshList();
          // v1.9.82 — sync underlying hardware modal findoc list ทันที
          if (_findocHwIdForPicker) await loadHmFinDocs(_findocHwIdForPicker);
        } catch (e) {
          alert(e.message);
          b.disabled = false;
          b.textContent = orig;
        }
      });
    });
  }
  setTimeout(() => {
    const inp = $('hmfdp-search');
    if (inp) {
      inp.addEventListener('input', (e) => { q = e.target.value; refreshList(); });
      inp.focus();
    }
  }, 10);
}

// store hwId เพื่อให้ picker modal ใช้ได้ (ลด param passing)
let _findocHwIdForPicker = null;

async function loadHmHistory(hwId) {
  let items = [];
  try {
    const d = await fetchJson(`/api/admin/hardware/${hwId}/history`);
    items = d.history || [];
  } catch (_) { /* ignore */ }
  renderHmHistoryList(hwId, items);
}

function renderHmHistoryList(hwId, items) {
  const listEl = $('hm-history-list');
  if (!listEl) return;
  if (items.length === 0) {
    listEl.innerHTML = '<div class="empty" style="padding:14px;font-size:12.5px">ยังไม่มีประวัติ — รายการแรกจะถูกสร้างเมื่อตั้ง owner</div>';
    return;
  }
  listEl.innerHTML = items.map(r => {
    const fromYm = (r.assigned_at || '').slice(0, 7);
    const toYm = r.unassigned_at ? r.unassigned_at.slice(0, 7) : null;
    const fromLabel = fromYm ? fmtMonthYearThai(fromYm) : '—';
    const toLabel = toYm ? fmtMonthYearThai(toYm) : '<span style="color:var(--green);font-weight:700">ปัจจุบัน</span>';
    const isActive = !r.unassigned_at;
    return `
      <div class="card" style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:9px 12px;${isActive ? 'border-color:var(--primary);background:rgba(37,99,235,.04)' : ''}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:13px">👤 ${escapeHtml(r.member_label || '— ไม่ผูก —')}</span>
            ${isActive ? '<span style="display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:700;background:rgba(16,185,129,.12);color:var(--green)">⭐ ปัจจุบัน</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px">📅 <strong>${escapeHtml(fromLabel)}</strong> → ${toLabel}</div>
          ${r.note ? `<div style="font-size:11.5px;color:var(--text-muted);font-style:italic;margin-top:4px">📝 ${escapeHtml(r.note)}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          <button type="button" class="btn" data-ha-edit="${r.id}" style="font-size:11.5px;padding:4px 9px" title="แก้ไข">✏️</button>
          <button type="button" class="btn danger" data-ha-del="${r.id}" data-ha-label="${escapeHtml(r.member_label || '')}" style="font-size:11.5px;padding:4px 9px" title="ลบ">🗑</button>
        </div>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('button[data-ha-edit]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const id = parseInt(b.dataset.haEdit, 10);
      const rec = items.find(x => x.id === id);
      if (rec) showAssignmentEditModal(hwId, rec);
    });
  });
  listEl.querySelectorAll('button[data-ha-del]').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      const id = parseInt(b.dataset.haDel, 10);
      const lbl = b.dataset.haLabel || '';
      if (!confirm(`ลบประวัติของ "${lbl}"?\n(ไม่กระทบ owner ปัจจุบัน — แค่ลบ record ในประวัติ)`)) return;
      try {
        await fetchJson(`/api/admin/hardware-assignments/${id}`, { method: 'DELETE' });
        await loadHmHistory(hwId);
      } catch (err) {
        alert('ลบไม่สำเร็จ: ' + err.message);
      }
    });
  });
}

function showAssignmentEditModal(hwId, record) {
  const fromYm = (record.assigned_at || '').slice(0, 7);
  const toYm = record.unassigned_at ? record.unassigned_at.slice(0, 7) : '';
  showModal({
    title: 'แก้ไขประวัติการครอบครอง',
    body: `
      <div class="field">
        <label>ผู้ดูแล</label>
        <div style="padding:9px 12px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;font-size:13.5px;font-weight:600">👤 ${escapeHtml(record.member_label || '— ไม่ผูก —')}</div>
        <div class="hint" style="font-size:11px;color:var(--text-muted);margin-top:4px">ต้องการเปลี่ยนตัว owner → ไปที่ tab 'ผู้ดูแลปัจจุบัน' เลือกใหม่ (จะ auto-close รายการเดิม + เปิดรายการใหม่)</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field">
          <label>วันที่เริ่ม (เดือน/ปี) *</label>
          ${_monthPickerHtml('hae-start', fromYm, '— เลือกเดือน/ปี —')}
        </div>
        <div class="field">
          <label>วันที่สิ้นสุด (เว้นว่าง = ปัจจุบัน)</label>
          ${_monthPickerHtml('hae-end', toYm, '— ปัจจุบัน —')}
        </div>
      </div>
      <div class="field">
        <label>หมายเหตุ (optional)</label>
        <input id="hae-note" type="text" value="${escapeHtml(record.note || '')}" placeholder="เช่น โอนจาก/ไป แผนกอื่น" />
      </div>
    `,
    onSubmit: async () => {
      const start = $('hae-start').value;
      if (!start) throw new Error('กรอกวันที่เริ่ม');
      const end = $('hae-end').value;
      const note = $('hae-note').value.trim();
      await fetchJson(`/api/admin/hardware-assignments/${record.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          assigned_at: start,
          unassigned_at: end || '',   // '' = clear → backend แปลงเป็น null
          note: note || null,
        }),
      });
      await loadHmHistory(hwId);
    },
  });
  setTimeout(() => {
    _initMonthPicker('hae-start', '— เลือกเดือน/ปี —', false);
    _initMonthPicker('hae-end', '— ปัจจุบัน —', true);
  }, 0);
}

// v1.9.247 — เพิ่มประวัติการครอบครองเอง (ระบุผู้เคยครอบครองย้อนหลัง)
function _addOwnershipHistory(hwId) {
  const opts = _hwMembersCache.map(m => ({ id: m.id, name: m.display_name || m.email || ('member#' + m.id), avatar: m.avatar_data, team: (m.teams && m.teams[0]) ? m.teams[0].name : '' }));
  showModal({
    title: '+ เพิ่มประวัติการครอบครอง',
    body: `
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">บันทึกย้อนหลังว่าใครเคยครอบครองเครื่องนี้ (ไม่กระทบ owner ปัจจุบัน)</div>
      <div class="field"><label>ผู้ครอบครอง</label>${_memberPickerHtml('aoh-member', null, '— เลือกผู้ครอบครอง —')}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:150px"><label>เริ่มครอบครอง (เดือน/ปี)</label>${_monthPickerHtml('aoh-from', '', '— เลือกเดือน/ปี —')}</div>
        <div class="field" style="flex:1;min-width:150px"><label>สิ้นสุด (ว่าง = ปัจจุบัน)</label>${_monthPickerHtml('aoh-to', '', '— ปัจจุบัน —')}</div>
      </div>
      <div class="field"><label>หมายเหตุ (optional)</label><input id="aoh-note" placeholder="เช่น โอนให้ทีมอื่น / เครื่องเดิม" style="width:100%" /></div>
    `,
    onSubmit: async () => {
      const mid = $('aoh-member').value;
      const from = $('aoh-from').value;
      if (!mid) throw new Error('เลือกผู้ครอบครอง');
      if (!from) throw new Error('ระบุวันที่เริ่มครอบครอง');
      await fetchJson('/api/admin/hardware/' + hwId + '/history', {
        method: 'POST',
        body: JSON.stringify({ member_id: parseInt(mid, 10), assigned_at: from, unassigned_at: $('aoh-to').value || null, note: $('aoh-note').value.trim() || null }),
      });
      loadHmHistory(hwId);
    },
  });
  setTimeout(() => {
    _initMemberPicker('aoh-member', opts, '— เลือกผู้ครอบครอง —', null, _addNewMemberFromPicker);
    _initMonthPicker('aoh-from', '— เลือกเดือน/ปี —', false);
    _initMonthPicker('aoh-to', '— ปัจจุบัน —', true);
  }, 0);
}

async function showHardwareHistoryModal(hwId, hwName) {
  let data;
  try {
    data = await fetchJson(`/api/admin/hardware/${hwId}/history`);
  } catch (e) {
    alert('โหลดประวัติไม่สำเร็จ: ' + e.message);
    return;
  }
  const history = data.history || [];
  const fmtTs = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString('th-TH', {dateStyle:'medium', timeStyle:'short'});
  };
  const rows = history.length === 0
    ? '<div class="empty">ยังไม่มีประวัติการครอบครอง</div>'
    : history.map(h => {
        const isCurrent = !h.unassigned_at;
        const dur = isCurrent ? 'ปัจจุบัน' : `${Math.round((new Date(h.unassigned_at) - new Date(h.assigned_at)) / 86400000)} วัน`;
        return `
          <div class="card" style="display:block;padding:10px 14px;margin-bottom:6px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="flex:1">
                <div style="font-weight:700;font-size:13px;color:var(--text)">👤 ${escapeHtml(h.member_label || `member#${h.member_id || '?'}`)}</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">
                  📅 รับ: ${escapeHtml(fmtTs(h.assigned_at))}
                  ${h.unassigned_at ? ` · 🔚 คืน: ${escapeHtml(fmtTs(h.unassigned_at))}` : ''}
                </div>
              </div>
              <span style="font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;background:${isCurrent ? 'rgba(16,185,129,.12);color:var(--green)' : 'var(--bg-soft);color:var(--text-muted)'}">${escapeHtml(dur)}</span>
            </div>
          </div>
        `;
      }).join('');
  showModal({
    title: `📜 ประวัติการครอบครอง: ${hwName}`,
    body: `
      <div class="hint" style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
        เรียงจากใหม่ → เก่า — รวม ${history.length} รายการ
      </div>
      ${rows}
    `,
    onSubmit: async () => { /* read-only — no save */ },
  });
  // ซ่อนปุ่มบันทึก (เพราะ modal นี้ read-only)
  setTimeout(() => {
    const okBtn = document.querySelector('.modal-bg .modal #m-ok');
    if (okBtn) okBtn.style.display = 'none';
  }, 10);
}


async function renderLogsPage() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">📜 Logs</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="card-sub" id="log-count">—</span>
        <button class="btn" id="log-refresh" style="font-size:12px;padding:6px 12px">🔄 รีเฟรช</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:16px;color:var(--text-muted);font-size:13px">
      บันทึกทุกครั้งที่ user คลิก Prefill — เห็น credential ไหนถูกใช้กับเว็บไหน เมื่อไร จากเครื่องอะไร
    </div>
    <div id="log-list">
      <div class="empty">กำลังโหลด…</div>
    </div>
  `;
  $('log-refresh').addEventListener('click', loadLogsList);
  await loadLogsList();
}

function shortUserAgent(ua) {
  if (!ua) return '—';
  // Chrome/147.0 (Mac) — สั้นๆ
  const browser = (ua.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/) || ['—'])[0];
  let os = '';
  if (/Mac OS|Macintosh/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Win';
  else if (/Linux/.test(ua)) os = 'Linux';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  return browser + (os ? ' · ' + os : '');
}

async function loadLogsList() {
  let data;
  try {
    data = await fetchJson('/api/admin/logs?limit=200');
  } catch (e) {
    $('log-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const logs = data.logs;
  $('log-count').textContent = `${logs.length} / ${data.total} log`;

  if (logs.length === 0) {
    $('log-list').innerHTML = `<div class="empty">ยังไม่มี log การใช้งาน — ทดลอง prefill บนเว็บไหนก็จะมี log ขึ้นที่นี่</div>`;
    return;
  }

  $('log-list').innerHTML = `
    <div style="overflow-x:auto;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-sm)">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:var(--bg-soft)">
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">เวลา</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">เว็บ</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">บัญชีที่ใช้</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">User</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">เครื่อง</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">หน้า</th>
            <th style="text-align:left;padding:12px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:0.05em">Browser / IP</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(l => {
            const credInfo = l.credential_label
              ? `${escapeHtml(l.credential_label)} <span style="color:var(--text-muted);font-size:11px">(${escapeHtml(l.credential_username || '—')})</span>`
              : escapeHtml(l.credential_username || '—');
            const sourceUrl = l.source_url
              ? `<a href="${escapeHtml(l.source_url)}" target="_blank" style="color:var(--primary);font-size:12px;text-decoration:none" title="${escapeHtml(l.source_url)}">${escapeHtml(l.source_url.replace(/^https?:\/\//, '').slice(0, 40))}…</a>`
              : '—';
            return `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:10px 12px;color:var(--text-muted);font-size:12px;white-space:nowrap">${fmtMemberDate(l.timestamp)}</td>
                <td style="padding:10px 12px;font-weight:500">${escapeHtml(l.site_name || '(ลบแล้ว)')}</td>
                <td style="padding:10px 12px">${credInfo}</td>
                <td style="padding:10px 12px;font-size:12.5px">${escapeHtml(l.member_label || '—')}</td>
                <td style="padding:10px 12px;font-size:12.5px">${escapeHtml(l.device_label || '—')}</td>
                <td style="padding:10px 12px">${sourceUrl}</td>
                <td style="padding:10px 12px;color:var(--text-muted);font-size:12px;white-space:nowrap" title="${escapeHtml(l.user_agent || '')}">${escapeHtml(shortUserAgent(l.user_agent))}<br><span style="font-size:11px">${escapeHtml(l.client_ip || '')}</span></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// v1.9.124 — generic submenu page (2-column) สำหรับ Customer / Device & Software / Setting
// child render functions ใช้ _subMain() (= #sub-detail ถ้ามี, ไม่งั้น #main) เป็น target
function _subMain() { return document.getElementById('sub-detail') || $('main'); }
async function renderSubmenuPage(cfg) {
  const link = (it) => {
    const badge = (it.badge !== undefined && it.badge !== null && it.badge !== '')
      ? `<span class="acc-menu-badge" id="acc-badge-${escapeHtml(it.route)}">${escapeHtml(String(it.badge))}</span>` : '';
    return `<a href="#/${it.route}" class="acc-menu-item${it.route === cfg.active ? ' active' : ''}" style="text-decoration:none"><span class="acc-menu-ico">${it.ico}</span> ${it.label}${badge}</a>`;
  };
  // v1.9.155 — รองรับ group header (ใส่ field group ใน item)
  const menuHtml = cfg.items.map((it, i) => {
    const prev = cfg.items[i - 1];
    const header = (it.group && (!prev || prev.group !== it.group))
      ? `<div class="acc-menu-group">${escapeHtml(it.group)}</div>` : '';
    return header + link(it);
  }).join('');
  $('main').innerHTML = `
    <div class="page-head"><h2 class="page-title">${cfg.title}</h2></div>
    <div class="acc-layout">
      <div class="acc-menu">${menuHtml}</div>
      <div class="acc-detail"><div id="sub-detail">${skelStack(5)}</div></div>
    </div>`;
  const active = cfg.items.find(it => it.route === cfg.active) || cfg.items[0];
  if (active && active.render) await active.render(cfg.arg);
}
function renderCustomerPage(active, arg) {
  return renderSubmenuPage({ title: '🌐 Customer', active: active || 'calendar', arg, items: [
    { route: 'calendar',        ico: '📅',  label: 'Calendar',        render: () => renderDomainsPage() },
    { route: 'websites',        ico: '🔗',  label: 'Websites',        render: () => renderWebsitesPage() },
    { route: 'services-config', ico: '🛠️', label: 'Services Config',  render: () => renderServicesConfigPage() },
  ]});
}
async function renderDeviceSoftwarePage(active, arg) {
  // v1.9.234 — badge ตัวเลข: Personal Computer = ทั้งหมด, คอมส่วนกลาง = central
  let pcTotal = '', central = '';
  try {
    const s = await fetchJson('/api/hardware/pc-stats');
    pcTotal = s.total;
    central = (s.by_assignment && s.by_assignment.central != null) ? s.by_assignment.central : '';
  } catch { /* ไม่มี badge ถ้าโหลดไม่ได้ */ }
  // v1.9.314 — ย้าย Int. Platforms Config ไปเป็นปุ่ม Configuration ใน Platforms > Platform (admin only)
  // v1.9.339 — member: กรองเมนูย่อยตามสิทธิ์ IAM (hw-* modules) — admin เห็นครบ
  const allItems = [
    { group: 'Hardware',  route: 'hardware-pc-dashboard',  ico: '📊',  label: 'Dashboard',             render: () => renderPcDashboard() },
    { group: 'Hardware',  route: 'hardware-pc',            ico: '💻',  label: 'Personal Computer', badge: pcTotal, render: () => renderHardwarePage('pc') },
    { group: 'Hardware',  route: 'hardware-pc-unassigned', ico: '📦',  label: 'คอมส่วนกลาง',       badge: central, render: () => renderHardwareUnassignedPcsPage() },
    { group: 'Hardware',  route: 'hardware-device',        ico: '📱',  label: 'Device',                render: () => renderHardwarePage('device') },
    { group: 'Hardware',  route: 'hardware-network',       ico: '📡',  label: 'Network',               render: () => renderHardwarePage('network') },
    { group: 'Hardware',  route: 'hardware-report',        ico: '📑',  label: 'Report',                render: () => renderHardwareReportPage() },
    { group: 'Document',  route: 'financial-documents',    ico: '💰',  label: 'Financial Document',    render: () => renderFinancialDocumentsPage() },
  ];
  const items = (currentRole === 'member')
    ? allItems.filter(it => currentModules.has(ROUTE_MODULE[it.route]))
    : allItems;
  if (!items.length) { location.hash = '#/dashboard'; return; }
  const wanted = active || 'hardware-pc-dashboard';
  const effActive = items.some(it => it.route === wanted) ? wanted : items[0].route;
  return renderSubmenuPage({ title: '🖥️ Device & Software', active: effActive, arg, items });
}
function renderSettingPage(active, arg) {
  return renderSubmenuPage({ title: '⚙️ Setting', active: active || 'logs', arg, items: [
    { route: 'logs',     ico: '📜', label: 'Logs',    render: () => renderLogsPage() },
    { route: 'security', ico: '🔑', label: 'API Key', render: () => renderSecurityPage() },
    { route: 'iam',      ico: '🔐', label: 'IAM',     render: () => renderIamPage() },
    { route: 'sso',      ico: '🪪', label: 'SSO',     render: () => renderSsoClients() },
  ]});
}
// v1.9.212 — สเปค SSO พร้อมวางใน Claude Code ของระบบอื่น
function _ssoBrief(c, ep, uri) {
  const U = uri || '<ใส่ redirect_uri ของระบบนี้ — ต้องไปลงทะเบียนใน Beat ด้วย>';
  return `ภารกิจ: เพิ่ม "Login ด้วย Beat" (SSO) เข้าระบบนี้ โดยใช้ Beat เป็น Identity Provider
(OAuth2 Authorization Code flow → ได้ id_token เป็น JWT HS256). อย่าเก็บ/ขอรหัสผ่านผู้ใช้เอง.

=== ค่าจาก Beat (ใช้ได้เลย) ===
Issuer        : ${ep.issuer}
Authorize URL : ${ep.authorize_url}
Token URL     : ${ep.token_url}
UserInfo URL  : ${ep.userinfo_url}
client_id     : ${c.client_id}
client_secret : ${c.client_secret}
redirect_uri  : ${U}
(*) redirect_uri ต้องตรงเป๊ะกับที่ลงทะเบียนใน Beat — ถ้าเปลี่ยน path ต้องไปแก้ใน Beat ด้วย

=== Flow ที่ต้อง implement ===
1) ปุ่ม "Login ด้วย Beat" → redirect ผู้ใช้ไป:
   ${ep.authorize_url}?client_id=${c.client_id}&redirect_uri=<URLENCODE(redirect_uri)>&response_type=code&state=<RANDOM>
   - สร้าง state สุ่ม เก็บใน session ฝั่งนี้ (กัน CSRF)
2) สร้าง route callback ที่ redirect_uri → รับ query ?code=&state=
   - ตรวจ state ให้ตรงกับที่เก็บไว้
3) แลก code แบบ server-to-server:
   POST ${ep.token_url}   (Content-Type: application/x-www-form-urlencoded หรือ JSON ก็ได้)
   body: client_id=${c.client_id}&client_secret=${c.client_secret}&code=<code>&redirect_uri=<redirect_uri>
   → response: {"id_token":"<JWT>","access_token":"<JWT>","token_type":"Bearer","expires_in":3600,
                "profile":{"sub":"...","name":"...","email":"...","role":"..."}}
4) verify id_token เป็น JWT HS256 ด้วย client_secret:
   - alg=HS256, ตรวจ signature ด้วย secret
   - ตรวจ iss == "${ep.issuer}", aud == "${c.client_id}", exp ยังไม่หมด
   - claims ที่ได้: sub (เช่น "admin:1" หรือ "member:5"), name, email, role ("admin"|"member")
   (หรือเรียก GET ${ep.userinfo_url} พร้อม header Authorization: Bearer <id_token>)
5) ใช้ sub/email สร้าง session ของระบบนี้เอง → ถือว่า login สำเร็จ

=== ตัวอย่าง (Python — ปรับตาม framework จริง) ===
import requests, jwt   # pip install pyjwt
# callback handler:
tok = requests.post("${ep.token_url}", data={
    "client_id": "${c.client_id}", "client_secret": "${c.client_secret}",
    "code": request.args["code"], "redirect_uri": "${U}"}).json()["id_token"]
claims = jwt.decode(tok, "${c.client_secret}", algorithms=["HS256"],
                    audience="${c.client_id}", issuer="${ep.issuer}")
# claims["sub"], claims["email"], claims["role"] → login user ในระบบนี้

=== ความปลอดภัย ===
- เก็บ client_secret ไว้ฝั่ง server เท่านั้น (env/secret store) อย่าใส่ใน frontend
- code ใช้ครั้งเดียว หมดอายุ ~2 นาที · id_token อายุ 1 ชม.
- ตรวจ state ทุกครั้งตอน callback`;
}
function _ssoCopy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => alert('คัดลอกสเปคแล้ว — เอาไปวางในแชท Claude Code ของระบบอื่นได้เลย'),
      () => alert('คัดลอกไม่สำเร็จ — เลือกข้อความเองจากกล่องที่เปิด'));
  } else {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); alert('คัดลอกสเปคแล้ว'); } catch (e) { alert('คัดลอกไม่สำเร็จ'); }
    ta.remove();
  }
}
// v1.9.211 — SSO Identity Provider: จัดการ client (super admin)
async function renderSsoClients() {
  const root = _subMain();
  root.innerHTML = '<div class="empty">กำลังโหลด…</div>';
  let d;
  try { d = await fetchJson('/api/sso/clients'); }
  catch (e) {
    root.innerHTML = `<div class="empty" style="padding:24px;text-align:center">${/403/.test(e.message) ? '🔒 ต้องเป็น <b>super admin</b> (login ด้วย username/password ของ admin หลัก) เพื่อจัดการ SSO' : 'โหลดไม่สำเร็จ: ' + escapeHtml(e.message)}</div>`;
    return;
  }
  const epRow = (k, v) => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px"><span style="min-width:110px;color:var(--text-muted)">${k}</span><code style="background:var(--bg-soft);padding:2px 7px;border-radius:5px;word-break:break-all">${escapeHtml(v)}</code></div>`;
  const ep = `<div class="card" style="display:block;margin-bottom:16px">
    <div style="font-size:13px;font-weight:700;margin-bottom:8px">🔗 Endpoints (ให้ระบบอื่นตั้งค่า)</div>
    ${epRow('Issuer', d.issuer)}${epRow('Authorize', d.authorize_url)}${epRow('Token', d.token_url)}${epRow('UserInfo', d.userinfo_url)}
    <div style="font-size:11px;color:var(--text-soft);margin-top:8px;line-height:1.6">Flow: ระบบอื่น redirect ไป <b>Authorize</b> (พร้อม <code>client_id</code>, <code>redirect_uri</code>, <code>state</code>) → ผู้ใช้ login Beat → กลับ <code>redirect_uri?code=…</code> → แลก code ที่ <b>Token</b> (client_id+secret) ได้ <b>id_token (JWT)</b> · verify JWT ด้วย client_secret (HS256)</div>
  </div>`;
  const rows = (d.clients || []).map(c => `
    <div class="card" style="display:block" data-cid="${c.id}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <input class="sso-name" value="${escapeHtml(c.name)}" style="flex:1;min-width:140px;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)">
        <label style="font-size:12px;white-space:nowrap"><input type="checkbox" class="sso-en" ${c.enabled ? 'checked' : ''}> เปิดใช้</label>
        <button class="btn sso-save" style="font-size:12px;padding:6px 11px">💾</button>
        <button class="btn sso-del" style="font-size:12px;padding:6px 11px;color:#dc2626">🗑</button>
      </div>
      <div style="font-size:12px;display:grid;grid-template-columns:auto 1fr;gap:4px 8px;margin-bottom:8px;align-items:center">
        <span style="color:var(--text-muted)">client_id</span><code style="background:var(--bg-soft);padding:2px 7px;border-radius:5px;word-break:break-all">${escapeHtml(c.client_id)}</code>
        <span style="color:var(--text-muted)">client_secret</span><span><code class="sso-sec" data-sec="${escapeHtml(c.client_secret)}" style="background:var(--bg-soft);padding:2px 7px;border-radius:5px;word-break:break-all">••••••••••</code> <button class="btn sso-reveal" style="font-size:10px;padding:2px 7px">👁</button> <button class="btn sso-rotate" style="font-size:10px;padding:2px 7px">↻ หมุน</button></span>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:3px">redirect_uris (1 บรรทัด/อัน — ต้องตรงเป๊ะ)</div>
      <textarea class="sso-uris" placeholder="https://app2.example.com/auth/beat/callback" style="width:100%;height:52px;font-size:11px;font-family:ui-monospace,monospace;padding:7px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);resize:vertical">${escapeHtml(c.redirect_uris || '')}</textarea>
      <button class="btn sso-copy" style="font-size:12px;padding:7px 13px;margin-top:8px;width:100%;background:var(--primary);color:#fff">📋 คัดลอกสเปคให้ Claude Code (ระบบอื่น)</button>
    </div>`).join('');
  root.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input id="sso-new-name" placeholder="ชื่อระบบใหม่ที่จะให้ login ด้วย Beat (เช่น Internal CRM)" style="flex:1;padding:9px 12px;font-size:13px;border:1px solid var(--border);border-radius:9px;background:var(--bg-input);color:var(--text)">
      <button class="btn" id="sso-add" style="font-size:13px;padding:9px 16px">+ เพิ่ม client</button>
    </div>
    ${ep}
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Clients (${(d.clients || []).length})</div>
    ${rows || '<div class="empty" style="padding:18px">— ยังไม่มี client —</div>'}`;
  $('sso-add').onclick = async () => {
    const name = $('sso-new-name').value.trim(); if (!name) { alert('ใส่ชื่อระบบ'); return; }
    try {
      const r = await fetchJson('/api/sso/clients', { method: 'POST', body: JSON.stringify({ name, redirect_uris: '', enabled: true }) });
      alert('สร้าง client แล้ว — เก็บค่านี้ไว้:\n\nclient_id: ' + r.client_id + '\nclient_secret: ' + r.client_secret);
      renderSsoClients();
    } catch (e) { alert('ไม่สำเร็จ: ' + e.message); }
  };
  root.querySelectorAll('[data-cid]').forEach(card => {
    const id = card.dataset.cid;
    card.querySelector('.sso-save').onclick = async () => {
      try { await fetchJson('/api/sso/clients/' + id, { method: 'PUT', body: JSON.stringify({ name: card.querySelector('.sso-name').value.trim(), redirect_uris: card.querySelector('.sso-uris').value.trim(), enabled: card.querySelector('.sso-en').checked }) }); alert('บันทึกแล้ว'); }
      catch (e) { alert('ไม่สำเร็จ: ' + e.message); }
    };
    card.querySelector('.sso-del').onclick = async () => { if (!confirm('ลบ client นี้? (ระบบที่ใช้อยู่จะ login ด้วย Beat ไม่ได้)')) return; try { await fetchJson('/api/sso/clients/' + id, { method: 'DELETE' }); renderSsoClients(); } catch (e) { alert(e.message); } };
    card.querySelector('.sso-reveal').onclick = () => { const el = card.querySelector('.sso-sec'); el.textContent = el.textContent.startsWith('•') ? el.dataset.sec : '••••••••••'; };
    card.querySelector('.sso-copy').onclick = () => {
      const c = (d.clients || []).find(x => String(x.id) === String(id)); if (!c) return;
      const uri = (card.querySelector('.sso-uris').value.split('\n').map(s => s.trim()).filter(Boolean)[0]) || '';
      _ssoCopy(_ssoBrief(c, d, uri));
    };
    card.querySelector('.sso-rotate').onclick = async () => { if (!confirm('หมุน secret ใหม่? ระบบที่ใช้อยู่ต้องอัปเดต secret')) return; try { const r = await fetchJson('/api/sso/clients/' + id + '/rotate', { method: 'POST' }); alert('client_secret ใหม่:\n' + r.client_secret); renderSsoClients(); } catch (e) { alert(e.message); } };
  });
}

