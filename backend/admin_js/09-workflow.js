// ============================ v1.9.278 — Workflow builder (n8n-style) ============================
let _wfList = [];
let _wfMembersCache = [];
let _wfEditor = null;
async function _wfLoadMembers() {
  if (_wfMembersCache.length) return _wfMembersCache;
  try { _wfMembersCache = (await fetchJson('/api/workflow-members')).members || []; } catch { _wfMembersCache = []; }
  return _wfMembersCache;
}
function _wfMember(id) { return _wfMembersCache.find(m => m.id === id) || null; }
function _wfAvatar(m, px) {
  px = px || 30;
  if (!m) return `<span style="width:${px}px;height:${px}px;border-radius:50%;background:var(--bg-soft);display:inline-flex;align-items:center;justify-content:center;font-size:${Math.round(px * 0.5)}px;flex-shrink:0">👤</span>`;
  return m.avatar
    ? `<img src="${m.avatar}" alt="" style="width:${px}px;height:${px}px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1.5px solid #fff" />`
    : `<span style="width:${px}px;height:${px}px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:${Math.round(px * 0.42)}px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml((String(m.name).trim().charAt(0) || '?').toUpperCase())}</span>`;
}
function _wfAgo(iso) { if (!iso) return '—'; const diff = (Date.now() - new Date(iso).getTime()) / 1000; if (diff < 60) return 'เมื่อสักครู่'; if (diff < 3600) return Math.floor(diff / 60) + ' นาทีที่แล้ว'; if (diff < 86400) return Math.floor(diff / 3600) + ' ชม.ที่แล้ว'; return Math.floor(diff / 86400) + ' วันที่แล้ว'; }

async function renderWorkflowPage() {
  const main = $('main');
  main.innerHTML = `
    <div class="page-head"><h2 class="page-title">🔀 Workflows</h2>
      <button class="btn primary" id="wf-create" style="margin-left:auto">+ Create New Workflow</button>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">ลากกล่อง Task / Logic เข้า canvas แล้วเชื่อมต่อกัน — บันทึกอัตโนมัติ · เฉพาะผู้สร้าง/collaborator แก้ไขได้</div>
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <input id="wf-search" placeholder="🔍 ค้นหา workflow..." autocomplete="off" style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
      <select id="wf-dept" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);cursor:pointer"></select>
    </div>
    <div id="wf-list">${skelStack(3)}</div>`;
  $('wf-create').addEventListener('click', _wfCreate);
  $('wf-search').addEventListener('input', _wfRenderList);
  $('wf-dept').addEventListener('change', _wfRenderList);
  await _wfLoadMembers();
  await _wfLoadList();
}
async function _wfLoadList() {
  try { _wfList = (await fetchJson('/api/workflows')).workflows || []; }
  catch (e) { if ($('wf-list')) $('wf-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  const depts = [...new Set(_wfList.map(w => w.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th'));
  const sel = $('wf-dept');
  if (sel) { const cur = sel.value; sel.innerHTML = `<option value="">🏢 ทุกแผนก</option>` + depts.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join(''); sel.value = cur; }
  _wfRenderList();
}
function _wfRenderList() {
  const listEl = $('wf-list'); if (!listEl) return;
  const q = ($('wf-search') ? $('wf-search').value : '').trim().toLowerCase();
  const dept = $('wf-dept') ? $('wf-dept').value : '';
  const list = _wfList.filter(w => (!q || (w.name || '').toLowerCase().includes(q)) && (!dept || w.department === dept));
  if (list.length === 0) { listEl.innerHTML = `<div class="empty">— ไม่มี workflow — กด <strong>+ Create New Workflow</strong></div>`; return; }
  listEl.innerHTML = `<div class="cfg-table-wrap"><div class="cfg-table-scroll"><table class="cfg-table">
    <thead><tr><th>Name</th><th>แผนก</th><th>กล่อง</th><th>แก้ไขล่าสุด</th><th>ผู้สร้าง</th><th style="text-align:right">จัดการ</th></tr></thead>
    <tbody>${list.map(_wfRow).join('')}</tbody></table></div></div>`;
  listEl.querySelectorAll('tr[data-wf-row]').forEach(r => r.addEventListener('click', () => renderWorkflowEditor(parseInt(r.dataset.wfRow, 10))));
  listEl.querySelectorAll('[data-wf-del]').forEach(b => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('ลบ workflow นี้?')) return;
    try { await fetchJson('/api/workflows/' + b.dataset.wfDel, { method: 'DELETE' }); await _wfLoadList(); } catch (err) { alert('ลบไม่ได้: ' + err.message); }
  }));
}
function _wfRow(w) {
  const c = w.creator;
  return `<tr data-wf-row="${w.id}" title="คลิกเพื่อเปิด">
    <td style="font-weight:700">${escapeHtml(w.name)}</td>
    <td>${w.department ? `<span style="font-size:11px;background:var(--bg-soft);padding:2px 9px;border-radius:999px">${escapeHtml(w.department)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
    <td style="color:var(--text-muted);white-space:nowrap">${w.node_count} กล่อง</td>
    <td style="color:var(--text-muted);white-space:nowrap">${escapeHtml(_wfAgo(w.updated_at))}</td>
    <td><div style="display:flex;align-items:center;gap:7px">${_wfAvatar(c, 24)}<span style="font-size:12.5px">${c ? escapeHtml(c.name) : '—'}</span></div></td>
    <td style="text-align:right;white-space:nowrap">${w.can_edit ? '<span style="font-size:11px;color:var(--primary);font-weight:600">✏️ แก้ไขได้</span>' : '<span style="font-size:11px;color:var(--text-muted)">🔒 อ่านอย่างเดียว</span>'} ${w.can_edit ? `<button class="kebab-btn" data-wf-del="${w.id}" title="ลบ" style="font-size:13px">🗑</button>` : ''}</td>
  </tr>`;
}
async function _wfCreate() {
  try { const r = await fetchJson('/api/workflows', { method: 'POST', body: JSON.stringify({ name: 'Workflow ใหม่' }) }); renderWorkflowEditor(r.id); }
  catch (e) { alert('สร้างไม่ได้: ' + e.message); }
}

// ---------------- Editor ----------------
async function renderWorkflowEditor(id) {
  const main = $('main');
  main.innerHTML = `<div class="empty">กำลังโหลด…</div>`;
  let wf;
  try { wf = await fetchJson('/api/workflows/' + id); } catch (e) { main.innerHTML = `<div class="empty">โหลดไม่ได้: ${escapeHtml(e.message)}</div>`; return; }
  await _wfLoadMembers();
  const data = (wf.data && Array.isArray(wf.data.nodes)) ? wf.data : { nodes: [], edges: [] };
  if (!Array.isArray(data.edges)) data.edges = [];
  _wfEditor = { id, data, canEdit: wf.can_edit, isCreator: wf.is_creator, creator: wf.creator, collaborators: wf.collaborators || [], selected: null, saveTimer: null, notesLatest: wf.notes_latest || null, notesCount: wf.notes_count || 0 };
  const ce = wf.can_edit;
  main.innerHTML = `
    <div class="page-head" style="gap:10px;align-items:center">
      <button class="btn" id="wf-back">← Workflows</button>
      <input id="wf-name" value="${escapeHtml(wf.name)}" ${ce ? '' : 'disabled'} placeholder="ชื่อ workflow" style="font-size:18px;font-weight:800;border:1px solid transparent;background:transparent;color:var(--text);min-width:180px;flex:1;font-family:inherit;padding:5px 8px;border-radius:8px" />
      <input id="wf-dept-in" value="${escapeHtml(wf.department || '')}" ${ce ? '' : 'disabled'} placeholder="แผนก" list="wf-dept-list" style="width:150px;font-size:13px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-family:inherit;padding:7px 10px;border-radius:8px" />
      <span id="wf-save-status" style="font-size:12px;color:var(--text-muted);min-width:80px"></span>
      ${wf.is_creator ? '<button class="btn" id="wf-collab" style="font-size:12.5px">👥 Collaborators</button>' : ''}
    </div>
    ${ce ? '' : '<div class="hint" style="margin-bottom:10px;color:#92400e;background:rgba(245,158,11,.1);padding:8px 12px;border-radius:8px;font-size:12.5px">🔒 อ่านอย่างเดียว — เฉพาะผู้สร้างหรือ collaborator แก้ไขได้</div>'}
    <div id="wf-note-bar" style="display:flex;align-items:center;gap:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:9px 14px;margin-bottom:12px"></div>
    <div style="display:flex;gap:12px;align-items:flex-start">
      ${ce ? `<div style="width:172px;flex-shrink:0">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">กล่อง · ลากเข้า canvas</div>
        <div class="wf-palette-item" draggable="true" data-wf-add="task"><span class="wf-node-ico" style="background:rgba(37,99,235,.12)">📋</span><div><div style="font-weight:700;font-size:13px">Task</div><div style="font-size:10px;color:var(--text-muted)">งาน + ผู้รับผิดชอบ</div></div></div>
        <div class="wf-palette-item" draggable="true" data-wf-add="logic"><span class="wf-node-ico" style="background:rgba(245,158,11,.16)">🔀</span><div><div style="font-weight:700;font-size:13px">Logic</div><div style="font-size:10px;color:var(--text-muted)">เงื่อนไข / ทางแยก</div></div></div>
      </div>` : ''}
      <div style="flex:1;min-width:0"><div class="wf-canvas" id="wf-canvas"><svg class="wf-edges" id="wf-edges"></svg><div id="wf-nodes"></div></div></div>
      <div id="wf-inspector" style="width:288px;flex-shrink:0"></div>
    </div>
    <datalist id="wf-dept-list">${[...new Set(_wfList.map(w => w.department).filter(Boolean))].map(d => `<option value="${escapeHtml(d)}"></option>`).join('')}</datalist>`;
  $('wf-back').addEventListener('click', () => renderWorkflowPage());
  if (ce) {
    $('wf-name').addEventListener('input', () => _wfScheduleSave({ name: $('wf-name').value }));
    $('wf-dept-in').addEventListener('input', () => _wfScheduleSave({ department: $('wf-dept-in').value }));
    const cb = $('wf-collab'); if (cb) cb.addEventListener('click', _wfCollabModal);
    // palette drag
    document.querySelectorAll('[data-wf-add]').forEach(p => p.addEventListener('dragstart', e => e.dataTransfer.setData('wf-type', p.dataset.wfAdd)));
    const canvas = $('wf-canvas');
    canvas.addEventListener('dragover', e => e.preventDefault());
    canvas.addEventListener('drop', e => {
      e.preventDefault();
      const type = e.dataTransfer.getData('wf-type'); if (!type) return;
      const rect = canvas.getBoundingClientRect();
      _wfAddNode(type, e.clientX - rect.left + canvas.scrollLeft - 100, e.clientY - rect.top + canvas.scrollTop - 20);
    });
    canvas.addEventListener('mousedown', e => { if (e.target.id === 'wf-canvas' || e.target.id === 'wf-nodes' || e.target.tagName === 'svg') _wfSelect(null); });
  }
  _wfRenderCanvas();
  _wfRenderInspector();
  _wfRenderNoteBar();
}
// v1.9.282 — หมายเหตุ workflow (log + ผู้กรอก + ดูย้อนหลัง)
function _wfRenderNoteBar() {
  const bar = $('wf-note-bar'); if (!bar || !_wfEditor) return;
  const ln = _wfEditor.notesLatest;
  const latest = ln
    ? `<span style="font-size:16px;flex-shrink:0">📝</span><div style="flex:1;min-width:0"><div style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ln.body)}</div><div style="font-size:10.5px;color:var(--text-muted)">${escapeHtml(ln.author_name)} · ${escapeHtml(_wfAgo(ln.created_at))}</div></div>`
    : `<span style="font-size:16px;flex-shrink:0">📝</span><span style="font-size:12.5px;color:var(--text-muted)">ยังไม่มีหมายเหตุ</span>`;
  bar.innerHTML = `${latest}<button class="btn" id="wf-note-more" style="margin-left:auto;flex-shrink:0;font-size:12px;padding:6px 12px">📋 ดูทั้งหมด / เพิ่ม${_wfEditor.notesCount ? ` (${_wfEditor.notesCount})` : ''}</button>`;
  $('wf-note-more').addEventListener('click', () => _wfNotesModal(_wfEditor.id, async () => {
    try { const ns = (await fetchJson('/api/workflows/' + _wfEditor.id + '/notes')).notes || []; _wfEditor.notesLatest = ns[0] || null; _wfEditor.notesCount = ns.length; _wfRenderNoteBar(); } catch (_) {}
  }));
}
async function _wfNotesModal(wfId, onAdded) {
  let notes = [];
  try { notes = (await fetchJson('/api/workflows/' + wfId + '/notes')).notes || []; } catch (e) { alert('โหลดหมายเหตุไม่ได้: ' + e.message); return; }
  const histHtml = notes.length
    ? notes.map(n => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">${_wfAvatar(n.author, 28)}<div style="min-width:0"><div style="font-size:12.5px;font-weight:700">${escapeHtml(n.author_name)}${n.author && n.author.position ? ` <span style="font-weight:400;color:var(--text-muted)">· ${escapeHtml(n.author.position)}</span>` : ''}</div><div style="font-size:10.5px;color:var(--text-muted)">${escapeHtml(_wfAgo(n.created_at))}</div></div></div>
        <div style="font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:var(--text)">${escapeHtml(n.body)}</div>
      </div>`).join('')
    : '<div style="color:var(--text-muted);font-size:12.5px;padding:8px 0;font-style:italic">— ยังไม่มีหมายเหตุ —</div>';
  showModal({
    title: '📝 หมายเหตุ Workflow',
    body: `<div class="field"><label>เพิ่มหมายเหตุใหม่</label><textarea id="wf-note-input" rows="3" placeholder="พิมพ์หมายเหตุ..." style="width:100%;padding:9px 11px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical;box-sizing:border-box"></textarea><div style="font-size:11px;color:var(--text-muted);margin-top:4px">บันทึกชื่อผู้กรอก + เวลาให้อัตโนมัติ · กด "บันทึก" เพื่อเพิ่ม (เว้นว่าง = ปิดเฉย ๆ)</div></div>
      <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 4px">ประวัติหมายเหตุ (${notes.length})</div>
      <div style="max-height:320px;overflow-y:auto;padding-right:4px">${histHtml}</div>`,
    onSubmit: async () => {
      const v = ($('wf-note-input') ? $('wf-note-input').value : '').trim();
      if (!v) return;
      await fetchJson('/api/workflows/' + wfId + '/notes', { method: 'POST', body: JSON.stringify({ body: v }) });
      if (typeof onAdded === 'function') await onAdded();
    },
  });
}
function _wfSaveStatus(t) { const el = $('wf-save-status'); if (el) el.textContent = t; }
function _wfScheduleSave(extra) {
  if (!_wfEditor || !_wfEditor.canEdit) return;
  _wfSaveStatus('● แก้ไข…');
  clearTimeout(_wfEditor.saveTimer);
  const body = { data: _wfEditor.data };
  if (extra) Object.assign(body, extra);
  _wfEditor.saveTimer = setTimeout(async () => {
    try { await fetchJson('/api/workflows/' + _wfEditor.id, { method: 'PATCH', body: JSON.stringify(body) }); _wfSaveStatus('✓ บันทึกแล้ว'); }
    catch (e) { _wfSaveStatus('⚠ ' + (e.message || 'บันทึกไม่สำเร็จ')); }
  }, 700);
}
let _wfNodeSeq = 0;
function _wfAddNode(type, x, y) {
  const id = 'n' + Date.now() + '_' + (_wfNodeSeq++);
  const node = { id, type, x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), title: type === 'logic' ? 'เงื่อนไข' : 'งานใหม่', detail: '', assignee_id: null, condition: '' };
  _wfEditor.data.nodes.push(node);
  _wfRenderCanvas(); _wfSelect(id); _wfScheduleSave();
}
function _wfPath(x1, y1, x2, y2) { const dx = Math.max(40, Math.abs(x2 - x1) * 0.5); return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`; }
function _wfPortCenter(nodeEl, cls) {
  const p = nodeEl.querySelector('.wf-port.' + cls); if (!p) return null;
  const canvas = $('wf-canvas'), cr = canvas.getBoundingClientRect(), pr = p.getBoundingClientRect();
  return { x: pr.left + pr.width / 2 - cr.left + canvas.scrollLeft, y: pr.top + pr.height / 2 - cr.top + canvas.scrollTop };
}
function _wfRenderCanvas() {
  const wrap = $('wf-nodes'); if (!wrap) return;
  wrap.innerHTML = _wfEditor.data.nodes.map(_wfNodeHtml).join('');
  wrap.querySelectorAll('.wf-node').forEach(el => {
    const node = _wfEditor.data.nodes.find(n => n.id === el.dataset.wfNode);
    el.querySelector('.wf-node-head').addEventListener('mousedown', e => { if (e.button !== 0) return; _wfSelect(node.id); _wfStartNodeDrag(node, el, e); });
    el.addEventListener('mousedown', e => { if (!e.target.closest('.wf-port')) _wfSelect(node.id); });
    const outp = el.querySelector('.wf-port.out');
    if (outp && _wfEditor.canEdit) outp.addEventListener('mousedown', e => _wfStartConnect(node, e));
  });
  _wfRenderEdges();
}
function _wfNodeHtml(n) {
  const sel = _wfEditor.selected === n.id ? ' selected' : '';
  const isLogic = n.type === 'logic';
  const ico = isLogic ? '🔀' : '📋';
  const icoBg = isLogic ? 'rgba(245,158,11,.16)' : 'rgba(37,99,235,.12)';
  let body;
  if (isLogic) {
    body = `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">${n.condition ? '⚖️ ' + escapeHtml(n.condition.length > 60 ? n.condition.slice(0, 57) + '…' : n.condition) : '<span style="font-style:italic">— ยังไม่ตั้งเงื่อนไข —</span>'}</div>`;
  } else {
    const m = _wfMember(n.assignee_id);
    const detail = n.detail ? `<div style="font-size:11px;color:var(--text-muted);line-height:1.45;margin-bottom:7px">${escapeHtml(n.detail.length > 60 ? n.detail.slice(0, 57) + '…' : n.detail)}</div>` : '';
    const person = m
      ? `<div style="display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)">${_wfAvatar(m, 30)}<div style="min-width:0"><div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.name)}</div>${m.position ? `<div style="font-size:10px;color:var(--text-muted)">${escapeHtml(m.position)}</div>` : ''}</div></div>`
      : `<div style="display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border);color:var(--text-muted)">${_wfAvatar(null, 30)}<span style="font-size:11px;font-style:italic">ยังไม่กำหนดผู้รับผิดชอบ</span></div>`;
    body = detail + person;
  }
  return `<div class="wf-node${sel}" data-wf-node="${n.id}" style="left:${n.x}px;top:${n.y}px;${isLogic ? 'border-color:rgba(245,158,11,.5)' : ''}">
    <div class="wf-port in" title="input"></div>
    <div class="wf-node-head"><span class="wf-node-ico" style="background:${icoBg}">${ico}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(n.title || (isLogic ? 'เงื่อนไข' : 'งาน'))}</span></div>
    <div class="wf-node-body">${body}</div>
    <div class="wf-port out" title="output (ลากเพื่อเชื่อม)" style="top:50%;transform:translateY(-50%)"></div>
  </div>`;
}
function _wfRenderEdges() {
  const svg = $('wf-edges'); if (!svg) return;
  const wrap = $('wf-nodes');
  let paths = '';
  (_wfEditor.data.edges || []).forEach((ed, i) => {
    const fromEl = wrap.querySelector(`.wf-node[data-wf-node="${ed.from}"]`);
    const toEl = wrap.querySelector(`.wf-node[data-wf-node="${ed.to}"]`);
    if (!fromEl || !toEl) return;
    const a = _wfPortCenter(fromEl, 'out'), b = _wfPortCenter(toEl, 'in');
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    paths += `<path d="${_wfPath(a.x, a.y, b.x, b.y)}" stroke="var(--primary)" stroke-width="2.5" fill="none" opacity=".75" />`;
    paths += `<circle cx="${b.x}" cy="${b.y}" r="3.5" fill="var(--primary)" />`;
    if (ed.label) paths += `<text x="${mx}" y="${my - 6}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--text)" style="paint-order:stroke;stroke:var(--bg-soft);stroke-width:4px">${escapeHtml(ed.label)}</text>`;
    if (_wfEditor.canEdit) paths += `<g class="wf-edge-del" data-wf-edge="${i}" style="cursor:pointer"><circle cx="${mx}" cy="${my}" r="9" fill="var(--bg-card)" stroke="var(--border)" /><text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="11" fill="var(--critical)">✕</text></g>`;
  });
  svg.innerHTML = paths;
  if (_wfEditor.canEdit) svg.querySelectorAll('.wf-edge-del').forEach(g => {
    g.style.pointerEvents = 'all';
    g.addEventListener('click', e => { e.stopPropagation(); const i = parseInt(g.dataset.wfEdge, 10); const ed = _wfEditor.data.edges[i]; const lbl = prompt('ใส่ป้ายเงื่อนไขของเส้นนี้ (เว้นว่าง=ไม่มี) · พิมพ์ "ลบ" เพื่อลบเส้น', ed.label || ''); if (lbl === null) return; if (lbl.trim() === 'ลบ') { _wfEditor.data.edges.splice(i, 1); } else { ed.label = lbl.trim() || undefined; } _wfRenderEdges(); _wfScheduleSave(); });
  });
}
function _wfStartNodeDrag(node, el, e) {
  if (!_wfEditor.canEdit) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = node.x, oy = node.y;
  const move = ev => { node.x = Math.max(0, ox + ev.clientX - sx); node.y = Math.max(0, oy + ev.clientY - sy); el.style.left = node.x + 'px'; el.style.top = node.y + 'px'; _wfRenderEdges(); };
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); _wfScheduleSave(); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}
function _wfStartConnect(node, e) {
  if (!_wfEditor.canEdit) return;
  e.preventDefault(); e.stopPropagation();
  const canvas = $('wf-canvas'), rect = canvas.getBoundingClientRect(), svg = $('wf-edges');
  const fromEl = $('wf-nodes').querySelector(`.wf-node[data-wf-node="${node.id}"]`);
  const from = _wfPortCenter(fromEl, 'out');
  const temp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  temp.setAttribute('stroke', 'var(--primary)'); temp.setAttribute('stroke-width', '2.5'); temp.setAttribute('fill', 'none'); temp.setAttribute('stroke-dasharray', '5 4');
  svg.appendChild(temp);
  const move = ev => { const x = ev.clientX - rect.left + canvas.scrollLeft, y = ev.clientY - rect.top + canvas.scrollTop; temp.setAttribute('d', _wfPath(from.x, from.y, x, y)); };
  const up = ev => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); temp.remove();
    const tgt = ev.target.closest && ev.target.closest('.wf-port.in');
    if (tgt) { const toId = tgt.closest('.wf-node').dataset.wfNode; if (toId && toId !== node.id) _wfAddEdge(node.id, toId); }
  };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}
function _wfAddEdge(from, to) {
  if (_wfEditor.data.edges.some(e => e.from === from && e.to === to)) return;
  _wfEditor.data.edges.push({ from, to });
  _wfRenderEdges(); _wfScheduleSave();
}
function _wfSelect(id) {
  _wfEditor.selected = id;
  $('wf-nodes').querySelectorAll('.wf-node').forEach(el => el.classList.toggle('selected', el.dataset.wfNode === id));
  _wfRenderInspector();
}
function _wfRenderInspector() {
  const box = $('wf-inspector'); if (!box) return;
  const n = _wfEditor.selected ? _wfEditor.data.nodes.find(x => x.id === _wfEditor.selected) : null;
  if (!n) { box.innerHTML = `<div style="border:1px solid var(--border);border-radius:12px;padding:22px 16px;text-align:center;color:var(--text-muted);font-size:12.5px">คลิกกล่องเพื่อแก้ไขรายละเอียด<br>หรือลากกล่องจากซ้ายเข้า canvas</div>`; return; }
  const ce = _wfEditor.canEdit, dis = ce ? '' : 'disabled';
  const isLogic = n.type === 'logic';
  const inp = 'width:100%;padding:8px 11px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;box-sizing:border-box';
  let mid = '';
  if (isLogic) {
    mid = `<div class="field"><label>เงื่อนไข</label><textarea id="wf-i-cond" rows="3" ${dis} style="${inp};resize:vertical">${escapeHtml(n.condition || '')}</textarea><div style="font-size:11px;color:var(--text-muted);margin-top:4px">ลากเส้นออกหลายเส้นเพื่อแยกทาง · คลิกที่เส้น (✕) เพื่อใส่ป้าย/ลบ</div></div>`;
  } else {
    mid = `<div class="field"><label>รายละเอียดงาน</label><textarea id="wf-i-detail" rows="3" ${dis} style="${inp};resize:vertical">${escapeHtml(n.detail || '')}</textarea></div>
      <div class="field"><label>ผู้รับผิดชอบ</label>${ce ? _memberPickerHtml('wf-i-assignee', n.assignee_id, '— ยังไม่กำหนด —') : `<div style="padding:8px 11px;border:1px solid var(--border);border-radius:8px;font-size:13px">${(() => { const m = _wfMember(n.assignee_id); return m ? escapeHtml(m.name) + (m.position ? ' · ' + escapeHtml(m.position) : '') : '— ยังไม่กำหนด —'; })()}</div>`}</div>`;
  }
  box.innerHTML = `<div style="border:1px solid var(--border);border-radius:12px;padding:14px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:13px;font-weight:800">${isLogic ? '🔀 Logic' : '📋 Task'}</div>
      ${ce ? `<button class="btn danger" id="wf-i-del" style="font-size:11.5px;padding:5px 11px">🗑 ลบกล่อง</button>` : ''}
    </div>
    <div class="field"><label>ชื่อกล่อง</label><input id="wf-i-title" value="${escapeHtml(n.title || '')}" ${dis} style="${inp}" /></div>
    ${mid}
  </div>`;
  if (!ce) return;
  $('wf-i-title').addEventListener('input', e => { n.title = e.target.value; _wfRefreshNode(n.id); _wfScheduleSave(); });
  if (isLogic) { $('wf-i-cond').addEventListener('input', e => { n.condition = e.target.value; _wfRefreshNode(n.id); _wfScheduleSave(); }); }
  else {
    $('wf-i-detail').addEventListener('input', e => { n.detail = e.target.value; _wfRefreshNode(n.id); _wfScheduleSave(); });
    const aopts = _wfMembersCache.map(m => ({ id: m.id, name: m.name, avatar: m.avatar, team: m.position }));
    _initMemberPicker('wf-i-assignee', aopts, '— ยังไม่กำหนด —', (val) => { n.assignee_id = val ? parseInt(val, 10) : null; _wfRefreshNode(n.id); _wfScheduleSave(); });
  }
  $('wf-i-del').addEventListener('click', () => {
    if (!confirm('ลบกล่องนี้?')) return;
    _wfEditor.data.nodes = _wfEditor.data.nodes.filter(x => x.id !== n.id);
    _wfEditor.data.edges = _wfEditor.data.edges.filter(e => e.from !== n.id && e.to !== n.id);
    _wfEditor.selected = null; _wfRenderCanvas(); _wfRenderInspector(); _wfScheduleSave();
  });
}
function _wfRefreshNode(id) {
  const el = $('wf-nodes').querySelector(`.wf-node[data-wf-node="${id}"]`);
  const n = _wfEditor.data.nodes.find(x => x.id === id);
  if (!el || !n) return;
  const tmp = document.createElement('div'); tmp.innerHTML = _wfNodeHtml(n);
  const fresh = tmp.firstElementChild;
  el.replaceWith(fresh);
  const node = n;
  fresh.querySelector('.wf-node-head').addEventListener('mousedown', e => { if (e.button !== 0) return; _wfSelect(node.id); _wfStartNodeDrag(node, fresh, e); });
  fresh.addEventListener('mousedown', e => { if (!e.target.closest('.wf-port')) _wfSelect(node.id); });
  const outp = fresh.querySelector('.wf-port.out'); if (outp && _wfEditor.canEdit) outp.addEventListener('mousedown', e => _wfStartConnect(node, e));
  _wfRenderEdges();
}
async function _wfCollabModal() {
  await _wfLoadMembers();
  const opts = _wfMembersCache.map(m => `<option value="${m.id}">${escapeHtml(m.name)}${m.position ? ' · ' + escapeHtml(m.position) : ''}</option>`).join('');
  const chips = () => (_wfEditor.collaborators || []).map(c => `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-soft);border:1px solid var(--border);border-radius:999px;padding:3px 6px 3px 10px;font-size:12px;margin:3px 3px 0 0">${_wfAvatar(c, 20)} ${escapeHtml(c.name)} <button data-wf-rmc="${c.id}" style="border:none;background:rgba(220,38,38,.1);color:var(--critical);width:16px;height:16px;border-radius:999px;cursor:pointer;font-size:10px;line-height:1">×</button></span>`).join('') || '<span style="color:var(--text-muted);font-size:12.5px">— ยังไม่มี collaborator —</span>';
  showModal({
    title: '👥 Collaborators — ผู้ที่แก้ไข workflow นี้ได้',
    body: `<div style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">ผู้สร้างแก้ไขได้เสมอ · เพิ่มคนอื่นให้แก้ไขร่วมได้</div>
      <div id="wf-collab-chips" style="margin-bottom:14px">${chips()}</div>
      <div class="field"><label>เพิ่ม collaborator</label><div style="display:flex;gap:8px"><select id="wf-collab-sel" style="flex:1;padding:9px 11px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit"><option value="">— เลือก —</option>${opts}</select><button class="btn primary" id="wf-collab-add" type="button">เพิ่ม</button></div></div>`,
    onSubmit: async () => {},
  });
  const refresh = () => { const c = $('wf-collab-chips'); if (c) { c.innerHTML = chips(); wireRm(); } };
  const wireRm = () => document.querySelectorAll('[data-wf-rmc]').forEach(b => b.addEventListener('click', async () => {
    const mid = parseInt(b.dataset.wfRmc, 10);
    try { await fetchJson(`/api/workflows/${_wfEditor.id}/collaborators/${mid}`, { method: 'DELETE' }); _wfEditor.collaborators = _wfEditor.collaborators.filter(x => x.id !== mid); refresh(); } catch (e) { alert(e.message); }
  }));
  setTimeout(() => {
    wireRm();
    const addBtn = $('wf-collab-add');
    if (addBtn) addBtn.addEventListener('click', async () => {
      const mid = parseInt($('wf-collab-sel').value, 10); if (!mid) return;
      if ((_wfEditor.collaborators || []).some(c => c.id === mid)) return;
      try { await fetchJson(`/api/workflows/${_wfEditor.id}/collaborators`, { method: 'POST', body: JSON.stringify({ member_id: mid }) }); const m = _wfMember(mid); if (m) _wfEditor.collaborators.push(m); refresh(); } catch (e) { alert(e.message); }
    });
  }, 0);
}

async function loadMyWorkflows() {
  const box = $('mywf-list'); if (!box) return;
  let list;
  try { list = (await fetchJson('/api/my-workflows')).workflows || []; }
  catch (e) { box.innerHTML = `<div class="empty">โหลดไม่ได้: ${escapeHtml(e.message)}</div>`; return; }
  if (!list.length) { box.innerHTML = `<div class="empty">— ยังไม่มี workflow ที่เกี่ยวข้องกับคุณ —</div>`; return; }
  const relLabel = { creator: '👑 ผู้สร้าง', collaborator: '🤝 collaborator', assignee: '📋 ผู้รับผิดชอบ' };
  box.innerHTML = `<div class="cfg-table-wrap"><div class="cfg-table-scroll"><table class="cfg-table">
    <thead><tr><th>Workflow</th><th>แผนก</th><th>บทบาท</th><th>แก้ไขล่าสุด</th><th style="text-align:right">สิทธิ์</th></tr></thead>
    <tbody>${list.map(w => `<tr data-mywf="${w.id}" title="คลิกเปิด workflow">
      <td style="font-weight:700">${escapeHtml(w.name)}</td>
      <td>${w.department ? `<span style="font-size:11px;background:var(--bg-soft);padding:2px 9px;border-radius:999px">${escapeHtml(w.department)}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${w.relations.map(r => `<span style="font-size:10.5px;background:rgba(37,99,235,.08);color:var(--primary);padding:2px 8px;border-radius:999px;margin:0 3px 2px 0;white-space:nowrap;display:inline-block">${relLabel[r] || r}</span>`).join('')}</td>
      <td style="color:var(--text-muted);white-space:nowrap">${escapeHtml(_wfAgo(w.updated_at))}</td>
      <td style="text-align:right;white-space:nowrap">${w.can_edit ? '<span style="font-size:11px;color:var(--primary);font-weight:600">✏️ แก้ไขได้</span>' : '<span style="font-size:11px;color:var(--text-muted)">🔒 ดูอย่างเดียว</span>'}</td>
    </tr>`).join('')}</tbody></table></div></div>`;
  box.querySelectorAll('[data-mywf]').forEach(r => r.addEventListener('click', () => renderWorkflowEditor(parseInt(r.dataset.mywf, 10))));
}

async function renderAccountPage() {
  // super admin → admin form (เปลี่ยน super admin pw)
  // admin-member หรือ member → member profile form (แก้ตัวเองได้ — name/email/password)
  if (currentIsSuper) return renderAdminAccountPage();
  return renderMemberAccountPage();
}

async function renderAdminAccountPage() {
  $('main').innerHTML = `
    <div class="page-head">
      <h2 class="page-title">👤 My Profile</h2>
    </div>
    <div class="acc-layout">
      <div class="acc-menu">
        <button type="button" class="acc-menu-item active" data-acc-tab="account"><span class="acc-menu-ico">🔑</span> บัญชี</button>
        <button type="button" class="acc-menu-item" data-acc-tab="absence"><span class="acc-menu-ico">🌴</span> Absence</button>
      </div>
      <div class="acc-detail">
        <div data-acc-panel="account">
          <div class="warning-box">
            ⚠️ <strong>คำเตือน:</strong> นี่คือบัญชี <strong>super admin</strong> ที่ใช้จัดการระบบทั้งหมด
            หากเปลี่ยน username/password แล้วลืม จะ recover ไม่ได้ — ระวังเก็บไว้ดีๆ
          </div>

          <div class="card" style="display:block;margin-bottom:14px">
            <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">ข้อมูลปัจจุบัน</h3>
            <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 16px;font-size:13.5px">
              <div style="color:var(--text-muted)">Username</div>
              <div id="cur-username" style="font-weight:500">…</div>
            </div>
          </div>

          <div class="card" style="display:block">
            <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">เปลี่ยน Username / Password</h3>
            <div class="hint" style="margin-bottom:14px;font-size:12.5px;color:var(--text-muted)">
              เว้นช่องที่ไม่ต้องการเปลี่ยนได้ (กรอกเฉพาะที่ต้องการแก้ไข)
            </div>

            <div class="field">
              <label>Username ใหม่</label>
              <input id="new-username" type="text" autocomplete="username" placeholder="เช่น admin@gmail.com" />
            </div>
            <div class="field">
              <label>Password ใหม่ (อย่างน้อย 4 ตัว)</label>
              <input id="new-password" type="password" autocomplete="new-password" placeholder="ปล่อยว่างถ้าไม่เปลี่ยน" />
            </div>
            <div class="field">
              <label>ยืนยัน Password ใหม่</label>
              <input id="confirm-password" type="password" autocomplete="new-password" />
            </div>

            <div class="hint" id="acc-msg" style="margin-bottom:10px;display:none"></div>
            <button class="btn primary" id="save-acc-btn">บันทึก</button>
          </div>
        </div>
        <div data-acc-panel="absence" style="display:none"><div id="absence-root"></div></div>
      </div>
    </div>
  `;

  // v1.9.381 — สลับแท็บ บัญชี / Absence
  const _accPanels = $('main').querySelectorAll('[data-acc-panel]');
  $('main').querySelectorAll('[data-acc-tab]').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.accTab;
    $('main').querySelectorAll('[data-acc-tab]').forEach(b => b.classList.toggle('active', b === btn));
    _accPanels.forEach(p => { p.style.display = (p.dataset.accPanel === tab) ? '' : 'none'; });
    if (tab === 'absence') renderAbsence();
  }));

  // โหลด state ปัจจุบัน
  try {
    const s = await fetch('/api/admin/state', { credentials: 'same-origin' }).then(r => r.json());
    $('cur-username').textContent = s.username || '—';
  } catch {}

  function setMsg(text, isErr) {
    const el = $('acc-msg');
    el.textContent = text;
    el.style.display = '';
    el.style.color = isErr ? 'var(--critical)' : 'var(--green)';
  }

  $('save-acc-btn').addEventListener('click', async () => {
    const username = $('new-username').value.trim();
    const password = $('new-password').value;
    const confirm = $('confirm-password').value;

    if (!username && !password) {
      setMsg('กรอกอย่างน้อย username หรือ password ใหม่', true);
      return;
    }
    if (password && password !== confirm) {
      setMsg('Password ยืนยันไม่ตรงกัน', true);
      return;
    }
    if (password && password.length < 4) {
      setMsg('Password ต้องมีอย่างน้อย 4 ตัว', true);
      return;
    }

    const body = {};
    if (username) body.username = username;
    if (password) body.password = password;

    $('save-acc-btn').disabled = true;
    try {
      const res = await fetchJson('/api/admin/credentials', {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      setMsg('บันทึกสำเร็จ — username ใหม่: ' + res.username, false);
      $('cur-username').textContent = res.username;
      $('new-username').value = '';
      $('new-password').value = '';
      $('confirm-password').value = '';
      // อัพเดท sidebar footer ด้วย
      $('who').textContent = '👤 ' + res.username;
    } catch (e) {
      setMsg(e.message, true);
    } finally {
      $('save-acc-btn').disabled = false;
    }
  });
}

// ==== v1.9.381 — Absence: ดึงเมลแจ้งลาจาก Microsoft Graph (me/messages) มาทำปฏิทินสรุปการลา (ปี 2026) ====
let _absToken = '';
let _absData = null;   // array ของ messages ที่โหลดแล้ว (ปี 2026)
let _absYM = '';       // เดือนที่กำลังดู 'YYYY-MM'
const _ABS_MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

function renderAbsence() {
  const root = $('absence-root'); if (!root) return;
  if (!_absToken) _absToken = sessionStorage.getItem('ms_graph_token') || '';
  root.innerHTML = `
    <div class="card" style="display:block;margin-bottom:14px">
      <h3 style="margin:0 0 8px;font-size:15px;font-weight:700">🌴 สรุปการลา (ปี 2026)</h3>
      <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7;margin-bottom:12px">
        ดึงอีเมลแจ้งลาจาก <b>notify.tigersoft1998@gmail.com</b> ผ่าน Microsoft Graph<br>
        <b>วิธีเอา token:</b> เปิด <a href="https://developer.microsoft.com/en-us/graph/graph-explorer" target="_blank" rel="noopener noreferrer" style="color:var(--primary);font-weight:600">Graph Explorer</a> → Sign in บัญชี Microsoft → คัดลอกจากแท็บ <b>"Access token"</b> มาวางด้านล่าง (token มีอายุ ~1 ชม.)
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="abs-token" type="password" placeholder="วาง Microsoft Graph access token ที่นี่" value="${escapeHtml(_absToken)}" style="flex:1;min-width:240px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;font-size:12.5px;box-sizing:border-box" />
        <button class="btn primary" id="abs-load" style="font-size:13px">โหลดข้อมูล</button>
      </div>
      <div id="abs-status" style="font-size:12px;color:var(--text-muted);margin-top:9px"></div>
    </div>
    <div id="abs-body"></div>`;
  $('abs-load').onclick = _absLoad;
  const inp = $('abs-token');
  if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') _absLoad(); });
  if (_absData) _absRenderCal();
}

async function _absLoad() {
  const tok = ($('abs-token').value || '').trim();
  if (!tok) { $('abs-status').textContent = '⚠️ วาง access token ก่อน'; return; }
  _absToken = tok; sessionStorage.setItem('ms_graph_token', tok);
  const st = $('abs-status'); const btn = $('abs-load');
  st.textContent = 'กำลังดึงข้อมูลจาก Microsoft Graph…'; st.style.color = 'var(--text-muted)';
  if (btn) btn.disabled = true;
  try {
    const r = await fetch('/api/absence/messages', { headers: { 'Authorization': 'Bearer ' + tok }, credentials: 'same-origin' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || ('HTTP ' + r.status));
    _absData = data.messages || [];
    _absData.forEach((m, i) => { m.__id = i; });   // v1.9.383 — index สำหรับเปิดดูอีเมลเต็ม
    st.style.color = 'var(--green)';
    st.textContent = `✓ พบ ${_absData.length} รายการ (ปี 2026) · ดึงจากกล่องเมลทั้งหมด ${data.total_fetched} ฉบับ`;
    _absRenderCal();
  } catch (e) {
    st.style.color = 'var(--critical)';
    st.textContent = '❌ ' + (e.message || e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- v1.9.383 — parser: อ่าน body อีเมลแจ้งลา → ชื่อ + ประเภท + ช่วงวันลา ----
function _absType(m) {
  const s = (m.subject || '').toLowerCase();
  if (s.includes('cancel')) return 'cancel';                       // ยกเลิกการลา
  if (s.includes('in-out') || s.includes('time in') || s.includes('time-in')) return 'timeio';  // ลงเวลา (ไม่ใช่การลา)
  if (s.includes('leave') || s.includes('absence') || s.includes('ลา')) return 'leave';
  return 'other';
}
function _absToISO(d, mo, y) {
  d = +d; mo = +mo; y = +y;
  if (y >= 2500) y -= 543;   // พ.ศ. → ค.ศ.
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31) || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function _absParse(m) {
  const txt = ((m.bodyText || '') + '\n' + (m.bodyPreview || '')).replace(/\r/g, '\n');
  let emp = '';
  const em = txt.match(/(?:พนักงานที่ขอลา|พนักงาน|Employee)\s*(?:\([^)]*\))?\s*[:：]\s*([^\n]+)/i);
  if (em) emp = em[1].replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 60);
  let lt = '';
  const lm = txt.match(/(?:ประเภทการลา|Leave\s*Type)\s*(?:\([^)]*\))?\s*[:：]\s*([^\n]+)/i);
  if (lm) lt = lm[1].replace(/\s*\([^)]*\)\s*$/, '').trim().slice(0, 40);
  const dre = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/;
  const nearDate = (re) => { const i = txt.search(re); if (i < 0) return null; const md = txt.slice(i, i + 90).match(dre); return md ? _absToISO(md[1], md[2], md[3]) : null; };
  let from = nearDate(/ตั้งแต่วันที่|วันที่เริ่ม|วันที่ลา|\bFrom\b/i);
  let to = nearDate(/ถึงวันที่|วันที่สิ้นสุด|\bTo\b/i);
  const allISO = []; let md; const g = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/g;
  while ((md = g.exec(txt))) { const iso = _absToISO(md[1], md[2], md[3]); if (iso) allISO.push(iso); }
  const sorted = allISO.slice().sort();
  if (!from && sorted.length) from = sorted[0];
  if (!to && sorted.length) to = sorted[sorted.length - 1];
  if (from && !to) to = from;
  return { employee: emp, leaveType: lt, from, to };
}
function _absDays(from, to) {
  const out = []; if (!from) return out;
  const s = new Date(from + 'T00:00:00'); if (isNaN(s)) return [];
  let e = new Date((to || from) + 'T00:00:00'); if (isNaN(e) || e < s) e = s;
  let d = new Date(s), guard = 0;
  while (d <= e && guard < 370) {
    if (d.getFullYear() === 2026) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    d.setDate(d.getDate() + 1); guard++;
  }
  return out;
}
function _absThai(iso) { if (!iso) return ''; const p = iso.split('-'); return `${+p[2]} ${_ABS_MONTHS[+p[1] - 1]}`; }
function _absBuildEntries() {
  const seen = new Set(); const entries = []; let skipped = 0;
  (_absData || []).forEach(m => {
    const kind = _absType(m);
    if (kind === 'timeio' || kind === 'other') { skipped++; return; }
    const p = _absParse(m);
    let days = _absDays(p.from, p.to), guess = false;
    if (!days.length) { const rd = (m.receivedDateTime || '').slice(0, 10); if (rd.slice(0, 4) === '2026') { days = [rd]; guess = true; } }
    const label = p.employee || (m.subject || '(ไม่ระบุ)');
    days.forEach(iso => {
      const key = kind + '|' + label + '|' + (p.leaveType || '') + '|' + iso;
      if (seen.has(key)) return; seen.add(key);
      entries.push({ iso, ym: iso.slice(0, 7), day: +iso.slice(8, 10), mid: m.__id, label, leaveType: p.leaveType, kind, guess, from: p.from, to: p.to });
    });
  });
  return { entries, skipped };
}
function _absShowFull(mid) {
  const m = (_absData || [])[mid]; if (!m) return;
  const bg = document.createElement('div'); bg.className = 'modal-bg is-slide'; bg.style.zIndex = '3000';
  bg.innerHTML = `<div class="modal" style="width:min(640px,96vw);padding:18px;display:flex;flex-direction:column">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px">
      <div style="font-size:14px;font-weight:800;line-height:1.35">${escapeHtml(m.subject || '(ไม่มีหัวข้อ)')}</div>
      <button class="btn" id="absf-close" style="font-size:12px;flex-shrink:0">✕ ปิด</button>
    </div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px">📅 ได้รับ: ${escapeHtml((m.receivedDateTime || '').replace('T', ' ').slice(0, 16))} · จาก ${escapeHtml(m.from || '')}</div>
    <div style="flex:1;overflow-y:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.65;background:var(--bg-soft);border-radius:8px;padding:12px">${escapeHtml(m.bodyText || m.bodyPreview || '(ไม่มีเนื้อหา)')}</div>`;
  document.body.appendChild(bg);
  requestAnimationFrame(() => bg.classList.add('is-open'));
  const close = () => bg.remove();
  bg.querySelector('#absf-close').onclick = close;
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
}
function _absRenderCal() {
  const body = $('abs-body'); if (!body) return;
  const { entries, skipped } = _absBuildEntries();
  if (!entries.length) { body.innerHTML = '<div class="empty" style="font-size:12.5px">— ไม่พบรายการลาในปี 2026 —</div>'; return; }
  const months = [...new Set(entries.map(e => e.ym))].sort();
  if (!_absYM || !months.includes(_absYM)) _absYM = months[months.length - 1];
  const idx = months.indexOf(_absYM);
  const [Y, M] = _absYM.split('-').map(Number);
  const daysIn = new Date(Y, M, 0).getDate();
  const firstDow = new Date(Y, M - 1, 1).getDay();
  const _now = new Date();
  const todayD = (_now.getFullYear() === Y && _now.getMonth() + 1 === M) ? _now.getDate() : 0;
  const byDay = new Map();
  entries.filter(e => e.ym === _absYM).forEach(e => { if (!byDay.has(e.day)) byDay.set(e.day, []); byDay.get(e.day).push(e); });
  const monthCount = [...byDay.values()].reduce((s, a) => s + a.length, 0);
  const item = (en) => {
    const ic = en.kind === 'cancel' ? '❌' : '🌴';
    const rng = en.from ? (en.from === en.to ? _absThai(en.from) : _absThai(en.from) + '–' + _absThai(en.to)) : '';
    const sub = en.guess ? '(ตามวันรับเมล)' : [en.leaveType, rng].filter(Boolean).join(' · ');
    return `<div class="abs-item" data-mid="${en.mid}" title="คลิกดูอีเมลเต็ม" style="padding:2px 4px;border-radius:5px;margin-top:2px;cursor:pointer;background:${en.guess ? 'transparent' : 'var(--bg-soft)'};${en.guess ? 'opacity:.55' : ''}">
      <div style="font-size:10px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ic} ${escapeHtml(en.label)}</div>
      ${sub ? `<div style="font-size:9px;color:var(--text-soft);line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(sub)}</div>` : ''}
    </div>`;
  };
  const dow = ['อา','จ','อ','พ','พฤ','ศ','ส'];
  let cells = '';
  for (let i = 0; i < firstDow; i++) cells += `<div style="background:var(--bg-soft);border-radius:8px;min-height:76px;opacity:.35"></div>`;
  for (let d = 1; d <= daysIn; d++) {
    const arr = byDay.get(d) || [];
    const isToday = d === todayD;
    cells += `<div style="background:${isToday ? 'rgba(37,99,235,.09)' : 'var(--bg-card)'};border:1px solid ${isToday ? 'var(--primary)' : 'var(--border)'};border-radius:8px;min-height:76px;padding:4px 5px;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;font-weight:700;${isToday ? 'background:var(--primary);color:#fff;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center' : 'color:var(--text-muted)'}">${d}</span>
        ${arr.length ? `<span style="font-size:9px;font-weight:700;color:var(--primary)">${arr.length}</span>` : ''}
      </div>${arr.map(item).join('')}
    </div>`;
  }
  body.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px">
        <button class="btn" id="abs-prev" ${idx <= 0 ? 'disabled' : ''} style="font-size:13px;padding:5px 11px">◀</button>
        <span style="font-size:15px;font-weight:800;min-width:110px;text-align:center">${_ABS_MONTHS[M - 1]} ${Y}</span>
        <button class="btn" id="abs-next" ${idx >= months.length - 1 ? 'disabled' : ''} style="font-size:13px;padding:5px 11px">▶</button>
      </div>
      <span style="font-size:12.5px;color:var(--text-muted)">${monthCount} วันลาในเดือนนี้${skipped ? ` · ไม่รวมลงเวลา ${skipped} ฉบับ` : ''}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px;margin-bottom:5px">${dow.map(x => `<div style="text-align:center;font-size:11px;font-weight:700;color:var(--text-muted);padding:2px 0">${x}</div>`).join('')}</div>
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:5px">${cells}</div>
    <div style="font-size:11px;color:var(--text-soft);margin-top:12px">💡 ปักตาม<b>วันลาจริง</b> (อ่านจากเนื้อหาอีเมล) · 🌴 = ลา · ❌ = ยกเลิกลา · รายการจาง = อ่านวันลาไม่ได้ (วางตามวันรับเมล) · <b>คลิกรายการเพื่อดูอีเมลเต็ม</b></div>`;
  const nav = (delta) => { const ni = idx + delta; if (ni < 0 || ni >= months.length) return; _absYM = months[ni]; _absRenderCal(); };
  $('abs-prev').onclick = () => nav(-1);
  $('abs-next').onclick = () => nav(1);
  body.querySelectorAll('.abs-item').forEach(el => el.addEventListener('click', () => _absShowFull(parseInt(el.dataset.mid, 10))));
}

async function renderMemberAccountPage() {
  $('main').innerHTML = `
    <div class="page-head">
      <h2 class="page-title">👤 My Profile</h2>
    </div>

    <div id="member-loading" style="padding:30px;text-align:center;color:var(--text-muted)">กำลังโหลด…</div>

    <div id="member-content" style="display:none">
      <div class="acc-layout">
        <!-- เมนูซ้าย -->
        <div class="acc-menu">
          <button type="button" class="acc-menu-item active" data-acc-tab="personal"><span class="acc-menu-ico">👤</span> Personal Info</button>
          <button type="button" class="acc-menu-item" data-acc-tab="link"><span class="acc-menu-ico">🔗</span> Link Account</button>
          <button type="button" class="acc-menu-item" data-acc-tab="password"><span class="acc-menu-ico">🔑</span> Change Password</button>
          <button type="button" class="acc-menu-item" data-acc-tab="device"><span class="acc-menu-ico">🖥️</span> My Device</button>
          <button type="button" class="acc-menu-item" data-acc-tab="extension"><span class="acc-menu-ico">🧩</span> Extension</button>
          <button type="button" class="acc-menu-item" data-acc-tab="beacon"><span class="acc-menu-ico">📍</span> Check-in</button>
          <button type="button" class="acc-menu-item" data-acc-tab="privacy"><span class="acc-menu-ico">🔒</span> Privacy</button>
          <button type="button" class="acc-menu-item" data-acc-tab="team" id="acc-tab-team" style="display:none"><span class="acc-menu-ico">👨‍👩‍👧</span> Team</button>
          <button type="button" class="acc-menu-item" data-acc-tab="myworkflow"><span class="acc-menu-ico">🔀</span> My Workflow</button>
          <button type="button" class="acc-menu-item" data-acc-tab="absence"><span class="acc-menu-ico">🌴</span> Absence</button>
        </div>

        <!-- รายละเอียดขวา -->
        <div class="acc-detail">
          <!-- ============ Personal Info (default) ============ -->
          <div data-acc-panel="personal">
            <div class="card" style="display:block;margin-bottom:14px">
              <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
                <div id="m-personal-avatar" style="width:96px;height:96px;border-radius:50%;border:2px solid var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
                  <span style="color:var(--text-muted);font-size:32px">👤</span>
                </div>
                <div style="flex:1;min-width:160px">
                  <div id="m-personal-name-display" style="font-size:17px;font-weight:700;letter-spacing:-0.01em">—</div>
                  <button type="button" class="btn" id="m-goto-photo" style="margin-top:9px;font-size:13px;padding:7px 14px">📷 เปลี่ยนรูปประจำตัว</button>
                </div>
              </div>
            </div>

            <div class="card" style="display:block">
              <h3 style="margin:0 0 14px;font-size:15px;font-weight:600">ข้อมูลส่วนตัว</h3>
              <!-- email เก็บเป็น hidden — แก้ไขผ่าน Link Account (Add Account) -->
              <input type="hidden" id="m-email" />
              <div class="field">
                <label>ชื่อแสดง</label>
                <input id="m-display_name" type="text" placeholder="เช่น สมชาย ใจดี" maxlength="120" />
              </div>
              <div class="field">
                <label>เบอร์มือถือ</label>
                <input id="m-phone" type="tel" placeholder="เช่น 0812345678" maxlength="40" />
                <div class="hint">ใช้รับการแจ้งเตือน (ห้ามว่าง)</div>
              </div>
              <div class="field">
                <label>วันเกิด</label>
                <input id="m-birthdate" type="date" style="width:auto;min-width:200px" />
                <div class="hint" id="m-age-hint" style="margin-top:4px">— ยังไม่ได้กรอก</div>
              </div>
              <div class="field">
                <label>ขนาดเสื้อ</label>
                <div id="m-shirt-size-group" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
                  ${['XS','S','M','L','XL','XXL'].map(sz => `
                    <button type="button" class="m-shirt-opt" data-size="${sz}"
                      style="padding:7px 16px;font-size:13px;font-weight:700;font-family:inherit;border:1.5px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer;min-width:54px;transition:all .12s">${sz}</button>
                  `).join('')}
                  <button type="button" class="m-shirt-opt" data-size="__other__"
                    style="padding:7px 14px;font-size:13px;font-weight:600;font-family:inherit;border:1.5px solid var(--border);border-radius:8px;background:var(--bg-card);color:var(--text);cursor:pointer;transition:all .12s">อื่น ๆ ...</button>
                </div>
                <div id="m-shirt-other-wrap" style="display:none;margin-top:8px">
                  <input id="m-shirt-other" type="text" placeholder="ระบุขนาดเสื้อ (เช่น 3XL, FreeSize, ลึก 16)" maxlength="40" />
                </div>
                <input type="hidden" id="m-shirt-size" value="" />
              </div>
              <div class="hint" id="m-profile-msg" style="margin-bottom:10px;display:none"></div>
              <button class="btn primary" id="m-save-profile">บันทึกข้อมูล</button>
            </div>
          </div>

          <!-- ============ Link Account ============ -->
          <div data-acc-panel="link" style="display:none">
            <div class="card" style="display:block;margin-bottom:14px">
              <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">ข้อมูลบัญชี</h3>
              <div style="display:grid;grid-template-columns:140px 1fr;gap:10px 16px;font-size:13.5px">
                <div style="color:var(--text-muted)">เบอร์มือถือ</div>
                <div id="m-info-phone" style="font-weight:500">—</div>
                <div style="color:var(--text-muted)">อีเมล</div>
                <div id="m-info-email">—</div>
                <div style="color:var(--text-muted)">รหัสผ่าน</div>
                <div id="m-info-pw">—</div>
                <div style="color:var(--text-muted)">สมัครเมื่อ</div>
                <div id="m-info-created">—</div>
              </div>
            </div>
            <div class="card" style="display:block">
              <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">🔐 วิธี Login ที่ใช้ได้</div>
              <div id="m-info-login-cards" style="display:flex;flex-direction:column;gap:6px"></div>
              <button type="button" id="m-add-account-btn" class="btn" style="margin-top:12px;font-size:13px;padding:9px 16px;color:var(--primary);font-weight:600">+ เพิ่มวิธี Login (Add Account)</button>
            </div>
          </div>

          <!-- ============ Change Password ============ -->
          <div data-acc-panel="password" style="display:none">
            <div class="card" style="display:block">
              <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">เปลี่ยนรหัสผ่าน</h3>
              <div class="hint" style="margin-bottom:14px;font-size:12.5px;color:var(--text-muted)">
                รหัสผ่านอย่างน้อย 4 ตัว — ใช้คู่กับอีเมลเพื่อ login ครั้งถัดไป
              </div>
              <div class="field">
                <label>รหัสผ่านใหม่</label>
                <input id="m-password" type="password" placeholder="อย่างน้อย 4 ตัว" autocomplete="new-password" />
              </div>
              <div class="field">
                <label>ยืนยันรหัสผ่าน</label>
                <input id="m-confirm" type="password" autocomplete="new-password" />
              </div>
              <div class="hint" id="m-pw-msg" style="margin-bottom:10px;display:none"></div>
              <button class="btn primary" id="m-save-password">บันทึกรหัสผ่าน</button>
            </div>
          </div>

          <!-- ============ Extension ============ -->
          <div data-acc-panel="extension" style="display:none">
            <div id="ext-embed"><div class="empty">กำลังโหลด…</div></div>
          </div>

          <!-- ============ Team (supervise — รูป+ชื่อ แบ่งตามทีม) ============ -->
          <!-- v1.9.131 — ไม่มี header, grid scroll ภายในตัวเอง (menu+tabs อยู่นิ่ง) -->
          <div data-acc-panel="team" style="display:none">
            <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
              <button type="button" id="bday-cal-btn" class="btn" style="font-size:12.5px;padding:7px 14px;background:rgba(236,72,153,.10);color:#be185d;border-color:rgba(236,72,153,.30)">🎂 Birthday Calendar</button>
            </div>
            <div id="m-team-tabs" style="display:flex;gap:8px;overflow-x:auto;padding:2px 2px 10px;scroll-behavior:smooth;flex-shrink:0"></div>
            <div id="m-team-grid" style="overflow-y:auto;max-height:calc(100vh - 170px);padding-right:4px">${skelStack(4)}</div>
          </div>

          <!-- ============ My Workflow ============ -->
          <div data-acc-panel="myworkflow" style="display:none">
            <h3 style="margin:0 0 4px;font-size:15px;font-weight:700">🔀 My Workflow</h3>
            <div class="hint" style="font-size:12.5px;color:var(--text-muted);margin-bottom:14px">Workflow ที่เกี่ยวข้องกับคุณ — เป็นผู้สร้าง / collaborator / ผู้รับผิดชอบงาน</div>
            <div id="mywf-list">${skelStack(3)}</div>
          </div>

          <!-- ============ Absence (v1.9.382) ============ -->
          <div data-acc-panel="absence" style="display:none"><div id="absence-root"></div></div>

          <!-- ============ My Device ============ -->
          <div data-acc-panel="device" style="display:none">
            <div class="card" style="display:block;margin-bottom:14px">
              <h3 style="margin:0 0 6px;font-size:15px;font-weight:600">🖥️ My Device</h3>
              <div class="hint" style="font-size:12.5px;color:var(--text-muted);line-height:1.6">
                อุปกรณ์ทั้งหมดที่ผูกกับคุณ — แก้ไขข้อมูลไม่ได้ แต่<strong>อัพโหลดรูปอุปกรณ์</strong>เองได้
              </div>
            </div>
            <div id="md-list">${skelStack(2)}</div>
          </div>

          <!-- ============ Check-in (Beacon) ============ -->
          <div data-acc-panel="beacon" style="display:none">
            <div class="card" style="display:block">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <h3 style="margin:0;font-size:15px;font-weight:600">📍 ตำแหน่ง Check-in (Beacon)</h3>
                <button type="button" class="btn" id="m-beacon-refresh" style="font-size:12.5px;padding:6px 12px">🔄 รีเฟรช</button>
              </div>
              <div id="m-beacon-body" style="font-size:13.5px;color:var(--text-muted)">กำลังโหลด…</div>
            </div>
          </div>

          <!-- ============ Privacy ============ -->
          <div data-acc-panel="privacy" style="display:none">
            <div class="card" style="display:block">
              <h3 style="margin:0 0 6px;font-size:15px;font-weight:600">🔒 ความเป็นส่วนตัว (Privacy)</h3>
              <div class="hint" style="font-size:12.5px;color:var(--text-muted);line-height:1.6;margin-bottom:16px">
                เลือกว่าจะ<strong>แชร์ข้อมูลให้คนอื่นเห็น</strong>หรือไม่ (เช่น หัวหน้าทีมที่ดูแลคุณ ในเมนู My Team) — <strong>ปิด = เก็บเป็นส่วนตัว</strong> ไม่แสดงให้คนอื่นเห็น
              </div>
              <div id="m-privacy-rows" style="display:flex;flex-direction:column;gap:2px">
                ${[
                  { key: 'phone', icon: '📞', label: 'เบอร์โทรศัพท์', desc: 'แสดงเบอร์ให้คนอื่นที่ดูโปรไฟล์คุณ' },
                  { key: 'birthdate', icon: '🎂', label: 'วันเกิด', desc: 'แสดงวันเกิดของคุณ' },
                  { key: 'shirt_size', icon: '👕', label: 'ขนาดเสื้อ', desc: 'แสดงไซส์เสื้อของคุณ' },
                ].map(it => `
                  <div style="display:flex;align-items:center;gap:12px;padding:13px 4px;border-bottom:1px solid var(--border)">
                    <span style="font-size:22px;width:30px;text-align:center;flex-shrink:0">${it.icon}</span>
                    <div style="flex:1;min-width:0">
                      <div style="font-weight:600;font-size:14px">${it.label}</div>
                      <div style="font-size:12px;color:var(--text-muted);margin-top:1px">${it.desc}</div>
                    </div>
                    <span class="m-priv-status" data-for="${it.key}" style="font-size:11.5px;font-weight:600;color:var(--text-soft);white-space:nowrap">—</span>
                    <label class="tgl"><input type="checkbox" class="tgl-input m-priv-toggle" data-priv="${it.key}" /><span class="tgl-track"><span class="tgl-thumb"></span></span></label>
                  </div>`).join('')}
              </div>
            </div>
          </div>

          <!-- ============ Change Photo (sub-view จาก Personal Info) ============ -->
          <div data-acc-panel="photo" style="display:none">
            <div class="card" style="display:block">
              <button type="button" class="btn" id="m-photo-back" style="margin-bottom:14px;font-size:13px;padding:7px 14px">← กลับ</button>
              <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">เปลี่ยนรูปประจำตัว</h3>
              <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
                <div id="m-avatar-preview" style="width:120px;height:120px;border-radius:50%;border:2px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0">
                  <span style="color:var(--text-muted);font-size:12px;text-align:center">ยังไม่มี<br/>รูปประจำตัว</span>
                </div>
                <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:8px">
                  <button type="button" class="btn" id="m-avatar-upload-btn" style="font-size:13px;padding:8px 14px;text-align:left">📷 อัพโหลดรูปจากเครื่อง</button>
                  <button type="button" class="btn" id="m-avatar-camera-btn" style="font-size:13px;padding:8px 14px;text-align:left">📸 ถ่ายจากกล้อง</button>
                  <button type="button" class="btn" id="m-avatar-wazzup-btn" style="font-size:13px;padding:8px 14px;text-align:left;display:none">🏢 เอาภาพจาก Wazzup</button>
                  <button type="button" class="btn danger" id="m-avatar-remove-btn" style="font-size:13px;padding:8px 14px;text-align:left;display:none">🗑 ลบรูป</button>
                  <div class="hint" style="font-size:11.5px;color:var(--text-muted);line-height:1.5">
                    รูปจะถูก crop เป็นสี่เหลี่ยมจัตุรัสก่อนบันทึก<br/>
                    แสดงในเมนูซ้ายและในรายการสมาชิก
                  </div>
                </div>
                <input type="file" id="m-avatar-file-input" accept="image/*" style="display:none" />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

  const fmtDate = iso => iso ? new Date(iso).toLocaleString('th-TH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }) : '—';

  const statusPill = set => set
    ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">✓ ตั้งแล้ว</span>'
    : '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.12);color:#b45309">⚠ ยังไม่ตั้ง</span>';

  let member = null;
  const SHIRT_OPTS = ['XS','S','M','L','XL','XXL'];

  // v1.9.95 — reload member data + re-render (เรียกหลัง add login method)
  async function loadMemberMe() {
    try {
      const r = await fetch('/api/member/me', { credentials: 'same-origin' }).then(r => r.json());
      if (!r.logged_in) { location.replace('/login'); return; }
      member = r.member;
      renderInfo();
    } catch (e) {
      showSavedToast('โหลด profile ไม่สำเร็จ: ' + e.message, 'error');
    }
  }

  // v1.9.95 — Add Account modal (3 methods: Email+PW / Phone OTP / Wazzup)
  function openAddAccountModal(onSuccess) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <div class="modal" style="max-height:88vh;overflow-y:auto">
        <h3 id="aa-title" style="margin:0 0 12px;font-size:17px;font-weight:700">+ เพิ่มวิธี Login</h3>
        <div id="aa-body"></div>
        <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <button class="btn" id="aa-cancel">ยกเลิก</button>
          <button class="btn" id="aa-back" style="display:none">← ย้อนกลับ</button>
          <button class="btn primary" id="aa-submit" style="display:none">บันทึก</button>
        </div>
        <div class="hint" id="aa-err" style="color:var(--critical);margin-top:6px;display:none"></div>
        <div class="hint" id="aa-ok" style="color:var(--green);margin-top:6px;display:none"></div>
      </div>
    `;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    const showErr = (m) => { const e = bg.querySelector('#aa-err'); e.textContent = m; e.style.display = ''; bg.querySelector('#aa-ok').style.display = 'none'; };
    const showOk  = (m) => { const e = bg.querySelector('#aa-ok');  e.textContent = m; e.style.display = ''; bg.querySelector('#aa-err').style.display = 'none'; };
    const clearMsg = () => { bg.querySelector('#aa-err').style.display = 'none'; bg.querySelector('#aa-ok').style.display = 'none'; };
    bg.querySelector('#aa-cancel').addEventListener('click', close);
    bg.addEventListener('click', e => { if (e.target === bg) close(); });

    const titleEl = bg.querySelector('#aa-title');
    const bodyEl = bg.querySelector('#aa-body');
    const submitBtn = bg.querySelector('#aa-submit');
    const backBtn = bg.querySelector('#aa-back');

    let currentSubmit = null;  // function to call on submit click

    const renderPicker = () => {
      clearMsg();
      titleEl.textContent = '+ เพิ่มวิธี Login';
      submitBtn.style.display = 'none';
      backBtn.style.display = 'none';
      const opt = (icon, color, title, desc, key) => `
        <button type="button" data-method="${key}" style="display:flex;gap:12px;align-items:center;padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);cursor:pointer;text-align:left;width:100%;box-sizing:border-box;font-family:inherit;transition:background .12s,border-color .12s">
          <div style="width:42px;height:42px;border-radius:50%;background:${color};color:#fff;font-size:20px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px">${title}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${desc}</div>
          </div>
          <div style="color:var(--text-muted);font-size:18px;flex-shrink:0">›</div>
        </button>`;
      bodyEl.innerHTML = `
        <div style="font-size:13px;color:var(--text-muted);margin-bottom:14px;line-height:1.55">
          เพิ่มวิธี login สำหรับ profile นี้ — เมื่อเพิ่มแล้ว ไม่ว่าจะ login เข้ามาด้วยวิธีไหน จะเห็น profile เดียวกันเสมอ
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${opt('🔑', '#10b981', 'Email + Password', 'ตั้ง email + รหัสผ่าน เพื่อ login ครั้งหน้า', 'email_pw')}
          ${opt('📱', '#2563eb', 'Phone OTP', 'ผูกเบอร์มือถือ — login ด้วย OTP จาก SMS', 'phone')}
          ${opt('🏢', '#f59e0b', 'Wazzup SSO', 'ผูกบัญชี Wazzup — login ด้วย username + password ของ Wazzup', 'wazzup')}
        </div>
      `;
      bodyEl.querySelectorAll('button[data-method]').forEach(b => {
        b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-soft)'; });
        b.addEventListener('mouseleave', () => { b.style.background = 'var(--bg-card)'; });
        b.addEventListener('click', () => {
          const m = b.dataset.method;
          if (m === 'email_pw') renderEmailPw();
          else if (m === 'phone') renderPhone();
          else if (m === 'wazzup') renderWazzup();
        });
      });
    };

    const renderEmailPw = () => {
      clearMsg();
      titleEl.textContent = '🔑 เพิ่ม Email + Password';
      backBtn.style.display = '';
      submitBtn.style.display = '';
      submitBtn.textContent = 'บันทึก';
      bodyEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">
            อีเมล
            <input type="email" id="aa-email" autocomplete="email" placeholder="you@example.com" style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">
            รหัสผ่าน (อย่างน้อย 4 ตัว)
            <input type="password" id="aa-pw" autocomplete="new-password" placeholder="••••••" style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          </label>
          <div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">
            หลังบันทึก — คุณจะ login ด้วย email + รหัสผ่านนี้ครั้งหน้าได้
          </div>
        </div>
      `;
      setTimeout(() => bodyEl.querySelector('#aa-email').focus(), 30);
      currentSubmit = async () => {
        const email = (bodyEl.querySelector('#aa-email').value || '').trim();
        const pw = bodyEl.querySelector('#aa-pw').value || '';
        if (!email || !pw) { showErr('กรอก email + รหัสผ่าน'); return; }
        if (pw.length < 4) { showErr('รหัสผ่านอย่างน้อย 4 ตัว'); return; }
        const r = await fetchJson('/api/member/add-email-password', {
          method: 'POST', body: JSON.stringify({ email, password: pw }),
        });
        showOk(`✓ เพิ่ม email login สำเร็จ (${r.email})`);
        if (onSuccess) await onSuccess();
        setTimeout(close, 800);
      };
    };

    const renderWazzup = () => {
      clearMsg();
      titleEl.textContent = '🏢 เพิ่ม Wazzup SSO';
      backBtn.style.display = '';
      submitBtn.style.display = '';
      submitBtn.textContent = 'เชื่อม Wazzup';
      bodyEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">
            Wazzup Username
            <input type="text" id="aa-waz-user" autocomplete="username" placeholder="username" style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600">
            Wazzup Password
            <input type="password" id="aa-waz-pw" autocomplete="current-password" placeholder="••••••" style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:inherit" />
          </label>
          <div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">
            ระบบจะใช้ Wazzup login ของคุณดึง email + profile แล้วผูกเข้ากับ profile นี้ — รหัสไม่ถูกเก็บ
          </div>
        </div>
      `;
      setTimeout(() => bodyEl.querySelector('#aa-waz-user').focus(), 30);
      currentSubmit = async () => {
        const u = (bodyEl.querySelector('#aa-waz-user').value || '').trim();
        const p = bodyEl.querySelector('#aa-waz-pw').value || '';
        if (!u || !p) { showErr('กรอก username + password'); return; }
        const r = await fetchJson('/api/member/add-wazzup', {
          method: 'POST', body: JSON.stringify({ username: u, password: p }),
        });
        // เก็บ Wazzup token ใน sessionStorage (ตาม SKILL.md)
        if (r.wazzup && r.wazzup.access_token) {
          try { sessionStorage.setItem(WAZZUP_STORAGE_KEY, JSON.stringify(r.wazzup)); } catch {}
        }
        showOk(`✓ เชื่อม Wazzup สำเร็จ (${r.email})`);
        if (onSuccess) await onSuccess();
        setTimeout(close, 800);
      };
    };

    const renderPhone = () => {
      clearMsg();
      titleEl.textContent = '📱 เพิ่ม Phone OTP';
      backBtn.style.display = '';
      submitBtn.style.display = 'none';
      bodyEl.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="font-size:13px;color:var(--text)">
            Phone OTP ต้องใช้ Firebase reCAPTCHA — กดปุ่มด้านล่างเปิดหน้าต่างใหม่
          </div>
          <div style="padding:10px 12px;background:rgba(37,99,235,.06);border:1px solid rgba(37,99,235,.20);border-radius:8px;font-size:12px;color:var(--text);line-height:1.55">
            1. หน้าต่างใหม่จะเปิด → กรอกเบอร์มือถือ + รับ OTP<br>
            2. หลัง verify สำเร็จ → ระบบจะผูกเบอร์เข้ากับ profile นี้ + ปิดหน้าต่างเอง<br>
            3. กลับมาที่นี่ → กด refresh เพื่อดูเบอร์ที่เพิ่งเพิ่ม
          </div>
          <button type="button" id="aa-phone-open" class="btn primary" style="font-size:13.5px;padding:10px 14px">📱 เปิดหน้า verify เบอร์</button>
        </div>
      `;
      bodyEl.querySelector('#aa-phone-open').addEventListener('click', () => {
        const w = 480, h = 640;
        const x = Math.max(0, (screen.width - w) / 2);
        const y = Math.max(0, (screen.height - h) / 2);
        const popup = window.open('/login?action=add-phone', 'add_phone', `width=${w},height=${h},left=${x},top=${y}`);
        if (!popup) { showErr('Popup ถูกบล็อก — โปรดอนุญาตและลองใหม่'); return; }
        // poll: popup ปิดเมื่อไหร่ → reload member
        const timer = setInterval(async () => {
          if (popup.closed) {
            clearInterval(timer);
            showOk('✓ ปิดหน้าต่างแล้ว — refresh profile...');
            if (onSuccess) await onSuccess();
            setTimeout(close, 600);
          }
        }, 600);
      });
      currentSubmit = null;
    };

    submitBtn.addEventListener('click', async () => {
      if (!currentSubmit) return;
      submitBtn.disabled = true;
      const orig = submitBtn.textContent;
      submitBtn.textContent = '⏳ กำลังบันทึก...';
      try {
        await currentSubmit();
      } catch (e) {
        showErr(e.message);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = orig;
      }
    });
    backBtn.addEventListener('click', () => renderPicker());

    renderPicker();
  }

  // v1.9.75 — คำนวณ "อายุ X ปี Y เดือน" + "(ตรงกับ พ.ศ. YYYY)" จาก birthdate
  function calcAgeText(birthdate) {
    if (!birthdate) return '— ยังไม่ได้กรอก';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthdate));
    if (!m) return '— รูปแบบไม่ถูกต้อง';
    const by = +m[1], bm = +m[2], bd = +m[3];
    const t = new Date();
    let years = t.getFullYear() - by;
    let months = t.getMonth() + 1 - bm;
    let days = t.getDate() - bd;
    if (days < 0) months -= 1;
    if (months < 0) { years -= 1; months += 12; }
    if (years < 0) return '— วันเกิดอยู่ในอนาคต (ตรวจสอบใหม่)';
    const ageStr = years > 0
      ? `${years} ปี${months > 0 ? ' ' + months + ' เดือน' : ''}`
      : `${months} เดือน`;
    const be = by + 543;
    const monthsTh = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
    const dateLabel = `${bd} ${monthsTh[bm - 1]} ${be}`;
    return `🎂 ${dateLabel} · อายุ <strong>${ageStr}</strong>`;
  }
  function updateAgeHint() {
    const inp = $('m-birthdate');
    const hint = $('m-age-hint');
    if (inp && hint) hint.innerHTML = calcAgeText(inp.value);
  }

  function applyShirtSizeUI(value) {
    // value: 'XS'/'S'/.../'XXL' หรือข้อความอิสระ หรือ null
    const v = (value || '').trim();
    const isStd = SHIRT_OPTS.includes(v);
    document.querySelectorAll('#m-shirt-size-group .m-shirt-opt').forEach(b => {
      const sz = b.dataset.size;
      const active = (sz === v) || (sz === '__other__' && v && !isStd);
      b.style.background = active ? 'var(--primary)' : 'var(--bg-card)';
      b.style.color = active ? '#fff' : 'var(--text)';
      b.style.borderColor = active ? 'var(--primary)' : 'var(--border)';
    });
    const otherWrap = $('m-shirt-other-wrap');
    const otherInp = $('m-shirt-other');
    if (v && !isStd) {
      if (otherWrap) otherWrap.style.display = '';
      if (otherInp) otherInp.value = v;
    } else {
      if (otherWrap) otherWrap.style.display = 'none';
      if (otherInp) otherInp.value = '';
    }
    const hidden = $('m-shirt-size');
    if (hidden) hidden.value = v;
  }
  function renderInfo() {
    $('m-info-phone').textContent = member.phone;
    $('m-info-email').innerHTML = member.email
      ? `<span style="margin-right:8px">${escapeHtml(member.email)}</span>${statusPill(true)}`
      : statusPill(false);
    $('m-info-pw').innerHTML = statusPill(member.has_password);
    $('m-info-created').textContent = fmtDate(member.created_at);
    $('m-display_name').value = member.display_name || '';
    $('m-email').value = member.email || '';
    if ($('m-phone')) $('m-phone').value = member.phone || '';
    applyShirtSizeUI(member.shirt_size || '');
    // v1.9.75 — birthdate + age hint
    if ($('m-birthdate')) {
      $('m-birthdate').value = member.birthdate || '';
      updateAgeHint();
    }
    // Avatar preview
    updateMyAvatarPreview(member.avatar_data || '');
    // v1.9.103 — ชื่อแสดงที่หัวการ์ด Personal Info
    if ($('m-personal-name-display')) {
      $('m-personal-name-display').textContent = member.display_name || member.email || member.phone || '—';
    }
    // v1.9.105 — ปุ่ม 'เอาภาพจาก Wazzup' แสดงถ้ามี live session หรือมีรูป Wazzup เก็บไว้ใน DB
    const wazBtn = $('m-avatar-wazzup-btn');
    if (wazBtn) {
      const waz = getWazzupSession();
      const hasLive = waz && waz.profileURL && getWazzupToken();
      wazBtn.style.display = (hasLive || member.has_wazzup_photo) ? '' : 'none';
    }
    // v1.9.127 — แสดง tab Team ถ้า member ดูแลทีม ≥1
    const teamTab = $('acc-tab-team');
    if (teamTab) teamTab.style.display = (member.supervised_count || 0) > 0 ? '' : 'none';
    // v1.9.88/95 — login methods cards (เหมือน Meta) + Add Account button
    renderMyLoginCards();
    // v1.9.147 — privacy toggles
    renderPrivacyToggles();
  }

  // v1.9.147 — set ค่า toggle Privacy จาก member.share_*
  const _PRIV_MAP = { phone: 'share_phone', birthdate: 'share_birthdate', shirt_size: 'share_shirt_size' };
  function renderPrivacyToggles() {
    document.querySelectorAll('.m-priv-toggle').forEach(t => {
      const on = member[_PRIV_MAP[t.dataset.priv]] !== 0;   // default = แชร์
      t.checked = on;
      const st = document.querySelector(`.m-priv-status[data-for="${t.dataset.priv}"]`);
      if (st) { st.textContent = on ? 'แชร์' : 'ส่วนตัว'; st.style.color = on ? 'var(--green)' : 'var(--text-soft)'; }
    });
  }

  function renderMyLoginCards() {
    const box = $('m-info-login-cards');
    if (!box) return;
    const methodMap = {
      phone:    { icon: '📱', title: 'Phone OTP',        bg: '#2563eb' },
      email_pw: { icon: '🔑', title: 'Email + Password', bg: '#10b981' },
      wazzup:   { icon: '🏢', title: 'Wazzup SSO',       bg: '#f59e0b' },
    };
    const lm = member.login_methods || [];
    const aliases = member.aliases || [];
    const rowStyle = 'display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card)';
    const avatar = member.avatar_data
      ? `<img src="${member.avatar_data}" alt="" style="width:38px;height:38px;border-radius:50%;object-fit:cover;border:1px solid var(--border);flex-shrink:0" />`
      : `<div style="width:38px;height:38px;border-radius:50%;background:var(--bg-soft);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px">👤</div>`;
    // v1.9.96 — ปุ่ม 🗑 (ลบ method) — disabled ถ้าจะเหลือ 0 (เช็คฝั่ง backend ด้วย)
    const removeBtnHtml = (label, dataAttrs) => {
      return `<button type="button" class="btn m-rm-method" ${dataAttrs} title="ลบวิธี login นี้: ${escapeHtml(label)}" style="font-size:11.5px;padding:5px 10px;color:var(--critical);background:transparent;border:1px solid var(--border);flex-shrink:0">🗑 ลบ</button>`;
    };
    const rows = [];
    if (lm.length === 0 && aliases.length === 0) {
      rows.push(`<div style="${rowStyle};font-size:12.5px;color:var(--text-muted);font-style:italic">— ยังไม่มี login method —</div>`);
    }
    for (const item of lm) {
      const mm = methodMap[item.kind];
      if (!mm) continue;
      const badge = `<div style="width:18px;height:18px;border-radius:50%;background:${mm.bg};color:#fff;font-size:11px;display:inline-flex;align-items:center;justify-content:center;position:absolute;bottom:-2px;right:-2px;border:2px solid var(--bg-card)">${mm.icon}</div>`;
      const dataAttrs = `data-rm-kind="${item.kind}" data-rm-label="${escapeHtml(item.label || '')}"`;
      rows.push(`
        <div style="${rowStyle}">
          <div style="position:relative;flex-shrink:0">${avatar}${badge}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13.5px">${escapeHtml(item.label || '(no label)')}</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">${escapeHtml(mm.title)}</div>
          </div>
          ${removeBtnHtml(`${mm.title} (${item.label})`, dataAttrs)}
        </div>`);
    }
    for (const a of aliases) {
      const icon = a.kind === 'phone' ? '📱' : (a.kind === 'email' ? '📧' : '🔗');
      const badge = `<div style="width:18px;height:18px;border-radius:50%;background:#7c3aed;color:#fff;font-size:10px;display:inline-flex;align-items:center;justify-content:center;position:absolute;bottom:-2px;right:-2px;border:2px solid var(--bg-card)">🔗</div>`;
      const dataAttrs = `data-rm-kind="alias" data-rm-alias-kind="${escapeHtml(a.kind)}" data-rm-value="${escapeHtml(a.value)}" data-rm-label="${escapeHtml(a.value)}"`;
      rows.push(`
        <div style="${rowStyle}">
          <div style="position:relative;flex-shrink:0">${avatar}${badge}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13.5px">${icon} ${escapeHtml(a.value)}</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Alias (จาก merge หรือ add) — ใช้ login ได้</div>
          </div>
          ${removeBtnHtml(`alias ${a.value}`, dataAttrs)}
        </div>`);
    }
    box.innerHTML = rows.join('');
    // wire ปุ่มลบ
    box.querySelectorAll('button.m-rm-method').forEach(btn => {
      btn.addEventListener('click', async () => {
        const kind = btn.dataset.rmKind;
        const aliasKind = btn.dataset.rmAliasKind || null;
        const value = btn.dataset.rmValue || null;
        const label = btn.dataset.rmLabel || '';
        if (!confirm(`ลบวิธี login นี้?\n\n${label}\n\nถ้านี่เป็นวิธีสุดท้าย จะเข้าระบบไม่ได้ — backend จะ block อัตโนมัติ`)) return;
        const orig = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳';
        try {
          await fetchJson('/api/member/remove-login-method', {
            method: 'POST',
            body: JSON.stringify({ kind, alias_kind: aliasKind, value }),
          });
          showSavedToast('✓ ลบวิธี login แล้ว');
          await loadMemberMe();
        } catch (e) {
          showSavedToast('❌ ' + e.message, 'error');
          btn.disabled = false;
          btn.textContent = orig;
        }
      });
    });
  }

  function updateMyAvatarPreview(dataUrl) {
    const box = $('m-avatar-preview');
    const removeBtn = $('m-avatar-remove-btn');
    if (box) {
      if (dataUrl) {
        box.style.background = 'transparent';
        box.style.borderStyle = 'solid';
        box.innerHTML = `<img src="${dataUrl}" alt="avatar" style="width:100%;height:100%;object-fit:cover" />`;
        if (removeBtn) removeBtn.style.display = '';
      } else {
        box.style.background = 'var(--bg-soft)';
        box.style.borderStyle = 'dashed';
        box.innerHTML = `<span style="color:var(--text-muted);font-size:12px;text-align:center">ยังไม่มี<br/>รูปประจำตัว</span>`;
        if (removeBtn) removeBtn.style.display = 'none';
      }
    }
    // v1.9.103 — sync avatar ที่หน้า Personal Info ด้วย
    const pBox = $('m-personal-avatar');
    if (pBox) {
      pBox.innerHTML = dataUrl
        ? `<img src="${dataUrl}" alt="avatar" style="width:100%;height:100%;object-fit:cover" />`
        : `<span style="color:var(--text-muted);font-size:32px">👤</span>`;
    }
  }

  // v1.9.89/105 — โหลดรูปจาก Wazzup → preview → confirm → saveAvatar
  // ใช้ live session ถ้ามี, ไม่งั้น fallback ไป URL ที่เก็บใน DB (/api/member/avatar-from-wazzup)
  async function loadAvatarFromWazzup() {
    const waz = getWazzupSession();
    const token = getWazzupToken();
    const btn = $('m-avatar-wazzup-btn');
    const origLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ กำลังโหลด...'; }
    try {
      let dataUrl;
      if (waz && token && waz.profileURL) {
        // live Wazzup session → ดึงตรงด้วย token
        const r = await fetchJson('/api/auth/wazzup-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ photo_url: waz.profileURL }),
        });
        dataUrl = r.data_url;
      } else {
        // ไม่มี session สด → ใช้ URL ที่เก็บไว้ใน DB
        const r = await fetchJson('/api/member/avatar-from-wazzup', {
          method: 'POST', body: JSON.stringify({}),
        });
        dataUrl = r.data_url;
      }
      // v1.9.142 — ส่งเข้า crop modal (256×256) เหมือนอัพโหลดจากเครื่อง — กันรูป Wazzup ใหญ่เกิน max_length
      openCropModal(dataUrl, saveAvatar, { title: '✂️ Crop รูปจาก Wazzup (สี่เหลี่ยมจัตุรัส)' });
    } catch (e) {
      showSavedToast('❌ ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = origLabel; }
    }
  }

  // Save callback — PATCH /api/member/profile with avatar_data, then update preview + reload member
  async function saveAvatar(dataUrl) {
    try {
      const r = await fetchJson('/api/member/profile', {
        method: 'PATCH',
        body: JSON.stringify({ avatar_data: dataUrl }),
      });
      member = r.member;
      updateMyAvatarPreview(member.avatar_data || '');
      showSavedToast(dataUrl ? '✓ บันทึกรูปแล้ว' : '✓ ลบรูปแล้ว');
    } catch (e) {
      showSavedToast('❌ ' + e.message, 'error');
    }
  }

  // v1.9.103 — สลับ panel (Personal Info / Link Account / Change Password / Photo)
  function showAccPanel(panel) {
    document.querySelectorAll('[data-acc-panel]').forEach(p => {
      p.style.display = (p.dataset.accPanel === panel) ? '' : 'none';
    });
    const menuActive = (panel === 'photo') ? 'personal' : panel;
    document.querySelectorAll('[data-acc-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.accTab === menuActive);
    });
    if (panel === 'beacon') loadBeacon();
    if (panel === 'myworkflow') loadMyWorkflows();
    if (panel === 'absence') renderAbsence();   // v1.9.382
    if (panel === 'team' && !_teamSupLoaded) { _teamSupLoaded = true; loadTeamSupervise(); }
    if (panel === 'device' && !_myDeviceLoaded) { _myDeviceLoaded = true; loadMyDevice(); }
    // v1.9.122 — Extension tab: render ลง #ext-embed + จัดการ polling
    if (panel === 'extension') {
      if (!_extLoaded) { _extLoaded = true; renderExtensionPage($('ext-embed')); }
      else if (typeof startExtStatusPolling === 'function') startExtStatusPolling();
    } else if (typeof stopExtStatusPolling === 'function') {
      stopExtStatusPolling();
    }
  }
  let _myDeviceLoaded = false;
  let _extLoaded = false;
  // v1.9.127 — Team (supervise) state
  let _teamSupLoaded = false;
  let _teamSupTeams = [];
  let _teamSupActive = '__all__';

  async function loadTeamSupervise() {
    const grid = $('m-team-grid');
    try {
      const r = await fetchJson('/api/member/supervised');
      _teamSupTeams = r.teams || [];
    } catch (e) {
      if (grid) grid.innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
      return;
    }
    _teamSupActive = '__all__';
    renderTeamSupTabs();
    renderTeamSupGrid();
    // v1.9.273 — Birthday Calendar
    const _bdayBtn = $('bday-cal-btn');
    if (_bdayBtn) _bdayBtn.onclick = () => {
      const byId = new Map();
      _teamSupTeams.forEach(t => t.members.forEach(m => {
        if (m.birthdate && !byId.has(m.id)) byId.set(m.id, { id: m.id, name: m.display_name || m.email || 'ไม่ระบุชื่อ', avatar: m.avatar_data, birthdate: m.birthdate, team: t.name });
      }));
      showBirthdayCalendar(Array.from(byId.values()));
    };
  }
  function renderTeamSupTabs() {
    const bar = $('m-team-tabs');
    if (!bar) return;
    const tabBtn = (key, label, count) => {
      const active = key === _teamSupActive;
      return `<button type="button" class="m-team-tab" data-team-key="${key}" style="flex-shrink:0;padding:7px 14px;border-radius:999px;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;white-space:nowrap;border:1px solid ${active ? 'var(--primary)' : 'var(--border)'};background:${active ? 'var(--primary)' : 'var(--bg-card)'};color:${active ? '#fff' : 'var(--text-muted)'};transition:all .12s">${escapeHtml(label)} <span style="opacity:.75">${count}</span></button>`;
    };
    // นับคนทั้งหมด (dedup by id) — v1.9.264 ไม่รวม Alumni
    const allIds = new Set();
    _teamSupTeams.forEach(t => t.members.forEach(m => { if (!m.is_alumni) allIds.add(m.id); }));
    let html = tabBtn('__all__', 'ทั้งหมด', allIds.size);
    _teamSupTeams.forEach(t => { html += tabBtn(String(t.id), t.name, t.members.filter(m => !m.is_alumni).length); });
    bar.innerHTML = html;
    bar.querySelectorAll('button.m-team-tab').forEach(b => {
      b.addEventListener('click', () => { _teamSupActive = b.dataset.teamKey; renderTeamSupTabs(); renderTeamSupGrid(); });
    });
  }
  function renderTeamSupGrid() {
    const grid = $('m-team-grid');
    if (!grid) return;
    let members, sites, pcs;
    if (_teamSupActive === '__all__') {
      const byId = new Map();
      _teamSupTeams.forEach(t => t.members.forEach(m => { if (!byId.has(m.id)) byId.set(m.id, m); }));
      members = Array.from(byId.values());
      const sById = new Map();
      _teamSupTeams.forEach(t => (t.sites || []).forEach(s => { if (!sById.has(s.id)) sById.set(s.id, s); }));
      sites = Array.from(sById.values());
      const pById = new Map();
      _teamSupTeams.forEach(t => (t.pcs || []).forEach(p => { if (!pById.has(p.id)) pById.set(p.id, p); }));
      pcs = Array.from(pById.values());
    } else {
      const t = _teamSupTeams.find(x => String(x.id) === _teamSupActive);
      members = t ? t.members : [];
      sites = t ? (t.sites || []) : [];
      pcs = t ? (t.pcs || []) : [];
    }
    // v1.9.242 — คอมฯ ของแต่ละคน (วางใต้ชื่อ/เบอร์) + คอมส่วนกลางของทีม
    const pcsByMember = {};
    pcs.forEach(p => { if (p.current_member_id) (pcsByMember[p.current_member_id] = pcsByMember[p.current_member_id] || []).push(p); });
    const centralPcs = pcs.filter(p => !p.current_member_id);
    const _pcLine = (p) => { const _a = calcHwAgeStr(p.purchased_at); return `💻 ${escapeHtml(p.model || p.name || '')}${p.is_personal_owned ? ' <span style="color:#7c3aed;font-weight:700">🙋 เครื่องตนเอง</span>' : ''}${_a ? `<br><span style="color:var(--text-muted)">⏱ ${escapeHtml(_a)}</span>` : ''}`; };
    // v1.9.264 — แยก Alumni (อดีตพนักงาน) ไปโซนล่าง (ภาพเล็ก ไม่เด่น)
    const activeMembers = members.filter(m => !m.is_alumni);
    const alumniMembers = members.filter(m => m.is_alumni)
      .sort((a, b) => (b.last_working_day || '').localeCompare(a.last_working_day || ''));
    const memberGrid = activeMembers.length === 0
      ? '<div class="empty" style="padding:24px;text-align:center;color:var(--text-muted)">— ไม่มีสมาชิกในทีมนี้ —</div>'
      : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px">` +
        activeMembers.map(m => {
          const initial = (m.display_name || m.email || '?').trim().charAt(0).toUpperCase();
          const photo = m.avatar_data
            ? `<img src="${m.avatar_data}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;display:block" />`
            : `<div style="width:100%;aspect-ratio:1;border-radius:12px;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-weight:700;font-size:38px;display:flex;align-items:center;justify-content:center">${escapeHtml(initial)}</div>`;
          // v1.9.151 — badge วันเกิด ทับมุมล่างของรูป
          const dBday = _daysUntilBirthday(m.birthdate);
          let bdayBadge = '';
          if (dBday === 0) {
            bdayBadge = `<div style="position:absolute;left:6px;right:6px;bottom:6px;text-align:center;padding:4px 6px;border-radius:8px;background:linear-gradient(135deg,#f59e0b,#ec4899);color:#fff;font-size:11px;font-weight:700;box-shadow:0 2px 8px rgba(15,23,42,.3)">🎂 เกิดวันนี้</div>`;
          } else if (dBday !== null && dBday >= 1 && dBday <= 30) {
            bdayBadge = `<div style="position:absolute;left:6px;right:6px;bottom:6px;text-align:center;padding:3px 6px;border-radius:8px;background:rgba(15,23,42,.72);color:#fff;font-size:10.5px;font-weight:600">🎂 วันเกิดในอีก ${dBday} วัน</div>`;
          }
          return `
            <div class="sup-member-card" data-sup-member="${m.id}" data-sup-name="${escapeHtml(m.display_name || m.email || '')}" style="display:flex;flex-direction:column;gap:7px;cursor:pointer;border-radius:12px;padding:4px;margin:-4px;transition:background .12s" title="ดูข้อมูล Profile / Device">
              <div style="position:relative;width:100%">${photo}${bdayBadge}</div>
              <div style="font-weight:600;font-size:13.5px;line-height:1.3">${escapeHtml(m.display_name || '(ไม่ได้ตั้งชื่อ)')}</div>
              <div style="font-size:11.5px;color:var(--text-muted);margin-top:-4px">${m.phone ? '📞 ' + escapeHtml(m.phone) : ''}</div>
              ${(pcsByMember[m.id] || []).map(p => `<div style="font-size:11px;color:var(--text-soft);line-height:1.45;margin-top:1px">${_pcLine(p)}</div>`).join('')}
              ${m.uses_own_computer ? `<div style="font-size:11px;color:#7c3aed;line-height:1.45;margin-top:1px;font-weight:600">🙋 ใช้เครื่องตนเอง${m.own_computer_info ? `<br><span style="color:var(--text-muted);font-weight:400">${escapeHtml(m.own_computer_info)}</span>` : ''}</div>` : ''}
            </div>`;
        }).join('') + `</div>`;
    // v1.9.148 — แพลตฟอร์มที่ทีมใช้ (ย้ายมาจากหน้า My Team เดิม)
    const platHtml = `
      <div style="margin-top:22px;border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">แพลตฟอร์มที่ทีมใช้ <span style="color:var(--text-soft)">${sites.length}</span></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${sites.length === 0 ? '<div style="font-size:12.5px;color:var(--text-muted);font-style:italic">— ไม่มีแพลตฟอร์ม —</div>' : sites.map(s => `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:10px;background:var(--bg-soft);border:1px solid var(--border)">
              <span style="font-size:16px;flex-shrink:0;margin-top:1px">${s.logo_data ? `<img src="${s.logo_data}" style="width:18px;height:18px;border-radius:3px;object-fit:contain;vertical-align:middle" />` : '🔗'}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:600;color:var(--text)">${escapeHtml(s.name)}</div>
                ${(s.credentials && s.credentials.length > 0)
                  ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${s.credentials.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:500;background:rgba(37,99,235,.10);color:var(--primary);font-family:ui-monospace,Menlo,monospace">👤 ${escapeHtml(u)}</span>`).join('')}</div>`
                  : `<div style="font-size:11px;color:var(--text-soft);margin-top:2px;font-style:italic">ยังไม่มี credential ที่คุณเข้าถึงได้</div>`}
              </div>
            </div>`).join('')}
        </div>
      </div>`;
    // v1.9.242 — คอมส่วนกลางของทีม (ไม่มี owner — แสดงต่อท้าย เพราะวางใต้ชื่อใครไม่ได้)
    const pcHtml = centralPcs.length ? `
      <div style="margin-top:20px;border-top:1px solid var(--border);padding-top:14px">
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">💻 คอมส่วนกลางของทีม <span style="color:var(--text-soft)">${centralPcs.length}</span></div>
        <div style="font-size:12px;color:var(--text-soft);line-height:1.8">${centralPcs.map(_pcLine).join('<br>')}</div>
      </div>` : '';
    // v1.9.264 — โซน Alumni (อดีตพนักงาน) ด้านล่าง · ภาพเล็ก ไม่เด่น · คลิกดูโปรไฟล์ได้ (ใช้ class เดิม)
    const alumniHtml = alumniMembers.length ? `
      <div style="margin-top:22px;border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">🎓 Alumni — อดีตพนักงาน <span style="color:var(--text-soft)">${alumniMembers.length}</span></div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(94px,1fr));gap:10px">
          ${alumniMembers.map(m => {
            const initial = (m.display_name || m.email || '?').trim().charAt(0).toUpperCase();
            const photo = m.avatar_data
              ? `<img src="${m.avatar_data}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block;filter:grayscale(.45);opacity:.85" />`
              : `<div style="width:100%;aspect-ratio:1;border-radius:10px;background:linear-gradient(135deg,#94a3b8,#64748b);color:#fff;font-weight:700;font-size:24px;display:flex;align-items:center;justify-content:center">${escapeHtml(initial)}</div>`;
            const lwd = m.last_working_day ? fmtDateThai(m.last_working_day) : '';
            return `
              <div class="sup-member-card" data-sup-member="${m.id}" data-sup-name="${escapeHtml(m.display_name || m.email || '')}" style="display:flex;flex-direction:column;gap:3px;cursor:pointer;border-radius:10px;padding:4px;margin:-4px;transition:background .12s" title="ดูข้อมูล Profile / Device">
                <div style="position:relative;width:100%">${photo}</div>
                <div style="font-weight:600;font-size:11.5px;line-height:1.25;color:var(--text-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(m.display_name || '(ไม่ได้ตั้งชื่อ)')}</div>
                ${lwd ? `<div style="font-size:9.5px;color:var(--text-muted);margin-top:-1px">📅 ${escapeHtml(lwd)}</div>` : ''}
              </div>`;
          }).join('')}
        </div>
      </div>` : '';
    grid.innerHTML = memberGrid + platHtml + pcHtml + alumniHtml;
    grid.querySelectorAll('.sup-member-card').forEach(c => {
      c.addEventListener('mouseenter', () => c.style.background = 'var(--bg-soft)');
      c.addEventListener('mouseleave', () => c.style.background = 'transparent');
      c.addEventListener('click', () => openSupervisedMemberPanel(parseInt(c.dataset.supMember, 10), c.dataset.supName));
    });
  }

  // v1.9.116 — Beacon check-in (ใช้ Wazzup token ดึงตำแหน่ง check-in ของตัวเอง)
  let _beaconLoaded = false;
  async function loadBeacon(force) {
    const box = $('m-beacon-body');
    if (!box) return;
    if (_beaconLoaded && !force) return;  // โหลดครั้งเดียวจนกด refresh
    const token = getWazzupToken();
    if (!token) {
      box.innerHTML = '<div style="padding:10px 0;color:var(--text-muted)">⚠️ ต้อง login ด้วย <strong>Wazzup</strong> ในเซสชันนี้ก่อน ถึงจะดูข้อมูล check-in ได้ (ไปที่ /login → Wazzup SSO)</div>';
      return;
    }
    box.innerHTML = 'กำลังโหลด…';
    try {
      const r = await fetchJson('/api/member/beacon-location', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      renderBeacon(r);
      _beaconLoaded = true;
    } catch (e) {
      box.innerHTML = `<div style="padding:10px 0;color:var(--critical)">❌ ${escapeHtml(e.message)}</div>`;
    }
  }
  function renderBeacon(r) {
    const box = $('m-beacon-body');
    const today = r.checkInToday;
    const last = r.checkInLastTime;
    const fmtEpoch = ms => {
      if (ms == null) return '—';
      try { return new Date(Number(ms)).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(ms); }
    };
    const fmtIso = iso => {
      if (!iso) return '—';
      try { return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); }
    };
    const typePill = t => {
      if (!t) return '';
      const enter = String(t).toLowerCase() === 'enter';
      const bg = enter ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.14)';
      const fg = enter ? 'var(--green)' : '#92400e';
      const label = enter ? 'เข้า (enter)' : (String(t).toLowerCase() === 'exit' ? 'ออก (exit)' : escapeHtml(t));
      return `<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:${bg};color:${fg}">${label}</span>`;
    };
    let html = '';
    // วันนี้
    if (today) {
      html += `
        <div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-card);margin-bottom:12px">
          <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">เช็คอินวันนี้</div>
          <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 14px;font-size:13.5px">
            <div style="color:var(--text-muted)">สถานที่</div><div style="font-weight:600">📍 ${escapeHtml(today.locationName || '—')}</div>
            <div style="color:var(--text-muted)">ทิศทาง</div><div>${typePill(today.type) || '—'}</div>
            <div style="color:var(--text-muted)">เวลา</div><div>${escapeHtml(fmtEpoch(today.timestamp))}</div>
            ${today.empName ? `<div style="color:var(--text-muted)">พนักงาน</div><div>${escapeHtml(today.empName)}${today.department ? ' · ' + escapeHtml(today.department) : ''}</div>` : ''}
          </div>
        </div>`;
    } else {
      html += `<div style="padding:14px;border:1px dashed var(--border);border-radius:10px;color:var(--text-muted);margin-bottom:12px">วันนี้ยังไม่มีการ check-in</div>`;
    }
    // ล่าสุด
    if (last) {
      html += `
        <div style="padding:14px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft)">
          <div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">check-in ล่าสุด</div>
          <div style="display:grid;grid-template-columns:120px 1fr;gap:8px 14px;font-size:13.5px">
            <div style="color:var(--text-muted)">สถานที่</div><div style="font-weight:600">📍 ${escapeHtml(last.checkInLocation || '—')}</div>
            <div style="color:var(--text-muted)">เวลา (ไทย)</div><div>${escapeHtml(fmtIso(last.checkInAtThailandTime || last.checkInAt))}</div>
          </div>
        </div>`;
    } else if (!today) {
      html = `<div style="padding:14px;color:var(--text-muted)">ยังไม่มีประวัติ check-in</div>`;
    }
    box.innerHTML = html;
  }

  // Wire avatar buttons + tabs
  setTimeout(() => {
    // tab menu
    document.querySelectorAll('[data-acc-tab]').forEach(b => {
      b.addEventListener('click', () => showAccPanel(b.dataset.accTab));
    });
    const gotoPhoto = $('m-goto-photo');
    if (gotoPhoto) gotoPhoto.addEventListener('click', () => showAccPanel('photo'));
    const photoBack = $('m-photo-back');
    if (photoBack) photoBack.addEventListener('click', () => showAccPanel('personal'));
    const beaconRefresh = $('m-beacon-refresh');
    if (beaconRefresh) beaconRefresh.addEventListener('click', () => loadBeacon(true));

    const fileInput = $('m-avatar-file-input');
    $('m-avatar-upload-btn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => openCropModal(ev.target.result, saveAvatar);
      reader.readAsDataURL(f);
      fileInput.value = '';
    });
    $('m-avatar-camera-btn').addEventListener('click', () => openCameraModal(saveAvatar));
    $('m-avatar-remove-btn').addEventListener('click', () => {
      if (!confirm('ลบรูปประจำตัว?')) return;
      saveAvatar('');
    });
    // v1.9.89/105 — Wazzup avatar: ผูก click ครั้งเดียว (visibility คุมใน renderInfo)
    const wazBtn = $('m-avatar-wazzup-btn');
    if (wazBtn) wazBtn.addEventListener('click', loadAvatarFromWazzup);
    // v1.9.95 — Add Account button
    const addBtn = $('m-add-account-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => openAddAccountModal(() => {
        // refresh member data หลัง add สำเร็จ
        loadMemberMe();
      }));
    }
    // v1.9.74 — wire shirt-size buttons
    document.querySelectorAll('#m-shirt-size-group .m-shirt-opt').forEach(b => {
      b.addEventListener('click', () => {
        const sz = b.dataset.size;
        if (sz === '__other__') {
          // toggle other-wrap visible — focus input
          const otherWrap = $('m-shirt-other-wrap');
          const otherInp = $('m-shirt-other');
          if (otherWrap) otherWrap.style.display = '';
          if (otherInp) otherInp.focus();
          // highlight 'อื่น ๆ' button
          document.querySelectorAll('#m-shirt-size-group .m-shirt-opt').forEach(x => {
            const a = x === b;
            x.style.background = a ? 'var(--primary)' : 'var(--bg-card)';
            x.style.color = a ? '#fff' : 'var(--text)';
            x.style.borderColor = a ? 'var(--primary)' : 'var(--border)';
          });
          const hidden = $('m-shirt-size');
          if (hidden) hidden.value = (otherInp && otherInp.value.trim()) || '';
        } else {
          applyShirtSizeUI(sz);
        }
      });
    });
    // ขณะพิมพ์ในช่อง 'อื่น ๆ' → update hidden + active state
    const otherInp = $('m-shirt-other');
    if (otherInp) {
      otherInp.addEventListener('input', () => {
        const v = otherInp.value.trim();
        const hidden = $('m-shirt-size');
        if (hidden) hidden.value = v;
      });
    }
    // v1.9.75 — birthdate change → update age hint live + set max=today
    const birthdayInp = $('m-birthdate');
    if (birthdayInp) {
      birthdayInp.setAttribute('max', new Date().toISOString().slice(0, 10));
      birthdayInp.addEventListener('input', updateAgeHint);
      birthdayInp.addEventListener('change', updateAgeHint);
    }
  }, 0);

  function setMsg(elId, text, isErr) {
    const el = $(elId);
    el.textContent = text;
    el.style.display = '';
    el.style.color = isErr ? 'var(--critical)' : 'var(--green)';
  }

  try {
    const r = await fetch('/api/member/me', { credentials: 'same-origin' }).then(r => r.json());
    if (!r.logged_in) { location.replace('/login'); return; }
    member = r.member;
    renderInfo();
    $('member-loading').style.display = 'none';
    $('member-content').style.display = '';
  } catch (e) {
    $('member-loading').textContent = 'โหลดไม่สำเร็จ: ' + e.message;
    return;
  }

  $('m-save-profile').addEventListener('click', async () => {
    const display_name = $('m-display_name').value.trim();
    const email = $('m-email').value.trim();
    const phone = ($('m-phone') ? $('m-phone').value.trim() : '');
    const shirt_size = ($('m-shirt-size') ? $('m-shirt-size').value.trim() : '');
    const birthdate = ($('m-birthdate') ? $('m-birthdate').value.trim() : '');
    if (!phone) { setMsg('m-profile-msg', 'เบอร์มือถือห้ามว่าง', true); return; }
    $('m-save-profile').disabled = true;
    try {
      const data = await fetchJson('/api/member/profile', {
        method: 'PATCH',
        body: JSON.stringify({ display_name, email, phone, shirt_size, birthdate }),
      });
      member = data.member;
      renderInfo();
      setMsg('m-profile-msg', 'บันทึกข้อมูลสำเร็จ', false);
      // อัพเดท sidebar footer ด้วย
      const display = member.display_name || member.email || member.phone;
      $('who').textContent = '👤 ' + display;
    } catch (e) {
      setMsg('m-profile-msg', e.message, true);
    } finally {
      $('m-save-profile').disabled = false;
    }
  });

  // v1.9.147 — privacy toggles → PATCH ทันทีที่สลับ
  document.querySelectorAll('.m-priv-toggle').forEach(t => {
    t.addEventListener('change', async () => {
      const field = _PRIV_MAP[t.dataset.priv];
      const val = t.checked;
      const st = document.querySelector(`.m-priv-status[data-for="${t.dataset.priv}"]`);
      const paint = (v) => { if (st) { st.textContent = v ? 'แชร์' : 'ส่วนตัว'; st.style.color = v ? 'var(--green)' : 'var(--text-soft)'; } };
      paint(val);
      try {
        const body = {}; body[field] = val;
        const data = await fetchJson('/api/member/profile', { method: 'PATCH', body: JSON.stringify(body) });
        if (data && data.member) member = data.member;
        showSavedToast(val ? '✓ แชร์ข้อมูลนี้ให้คนอื่นเห็นแล้ว' : '🔒 ตั้งเป็นส่วนตัวแล้ว');
      } catch (e) {
        t.checked = !val; paint(!val);   // revert
        showSavedToast('❌ ' + e.message, 'error');
      }
    });
  });

  $('m-save-password').addEventListener('click', async () => {
    const password = $('m-password').value;
    const confirm = $('m-confirm').value;
    if (password.length < 4) { setMsg('m-pw-msg', 'รหัสผ่านต้องมีอย่างน้อย 4 ตัว', true); return; }
    if (password !== confirm) { setMsg('m-pw-msg', 'รหัสผ่านยืนยันไม่ตรงกัน', true); return; }
    $('m-save-password').disabled = true;
    try {
      const data = await fetchJson('/api/member/profile', {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      });
      member = data.member;
      renderInfo();
      $('m-password').value = '';
      $('m-confirm').value = '';
      setMsg('m-pw-msg', 'ตั้งรหัสผ่านสำเร็จ — ใช้อีเมล + รหัสผ่าน login ครั้งหน้าได้', false);
    } catch (e) {
      setMsg('m-pw-msg', e.message, true);
    } finally {
      $('m-save-password').disabled = false;
    }
  });
}

// Polling reference สำหรับ extension status (ต้อง stop ตอนนำทางออก)
let _extStatusTimer = null;
function stopExtStatusPolling() {
  if (_extStatusTimer) { clearInterval(_extStatusTimer); _extStatusTimer = null; }
}

function fmtRelativeTh(iso) {
  if (!iso) return '—';
  const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 0) return 'อนาคต';
  if (sec < 5) return 'เมื่อสักครู่';
  if (sec < 60) return sec + ' วินาทีที่แล้ว';
  if (sec < 3600) return Math.floor(sec/60) + ' นาทีที่แล้ว';
  if (sec < 86400) return Math.floor(sec/3600) + ' ชั่วโมงที่แล้ว';
  return Math.floor(sec/86400) + ' วันที่แล้ว';
}

// ดึง pairing status จาก extension ผ่าน postMessage (รอผล + timeout)
function probePairing(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const requestId = 'fct_pairing_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const handler = (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.type !== 'FCT_PAIRING_RESULT' || d.requestId !== requestId) return;
      cleanup();
      resolve({ found: true, pairedUser: d.pairedUser });
    };
    const cleanup = () => {
      window.removeEventListener('message', handler);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ found: false });   // extension ไม่ตอบ
    }, timeoutMs);
    window.addEventListener('message', handler);
    window.postMessage({ type: 'FCT_GET_PAIRING', requestId }, '*');
  });
}

async function loadExtensionStatus() {
  // เรียกพร้อมกัน: backend status + extension pairing probe
  let s = null, p = null;
  try {
    [s, p] = await Promise.all([
      fetchJson('/api/admin/extension/status').catch(() => null),
      probePairing(1500),
    ]);
  } catch { return; }

  const card = document.getElementById('ext-status-card');
  const icon = document.getElementById('ext-status-icon');
  const text = document.getElementById('ext-status-text');
  const sub = document.getElementById('ext-status-sub');
  const meta = document.getElementById('ext-status-meta');
  const cta = document.getElementById('ext-status-cta');
  if (!card) return;  // หน้าเปลี่ยนแล้ว

  // ====== ตัดสินสถานะรวม (5 states) ======
  // ext-alive: backend เห็น heartbeat ภายใน 5 นาที
  // pair-found: postMessage ตอบกลับ (extension รันอยู่จริงในเครื่องนี้)
  const extAlive = !!(s && s.connected);
  const pairFound = p && p.found;
  const pairedUser = (p && p.pairedUser) || null;
  const isAdminPair = pairedUser && (pairedUser.role === 'admin' || pairedUser.member_id == null);
  const isMemberPair = pairedUser && pairedUser.role === 'member' && pairedUser.member_id != null;

  // กำหนดสไตล์ตาม state
  let bgColor, borderColor, textColor;
  let iconStr, mainText, subText, ctaHtml = '';

  if (!s || (!s.last_seen && !pairFound)) {
    // ============================ State 1: ยังไม่พบเลย ============================
    bgColor = '#fef2f2'; borderColor = '#fca5a5'; textColor = '#991b1b';
    iconStr = '❌';
    mainText = 'ยังไม่พบ Extension';
    subText = 'ติดตั้ง extension จากปุ่มดาวน์โหลดด้านล่าง + Reload หน้านี้';
  } else if (pairFound && !pairedUser) {
    // ============================ State 2: ติดตั้งแล้ว แต่ Unpaired ============================
    bgColor = '#fff7ed'; borderColor = '#fdba74'; textColor = '#9a3412';
    iconStr = '🔒';
    mainText = 'ยังใช้งานไม่ได้ — ต้อง Pair ก่อน';
    subText = 'Extension ติดตั้งแล้ว แต่ยังไม่ได้เชื่อมกับบัญชี → autofill จะไม่แสดงบนเว็บใดเลย';
    ctaHtml = '<a href="#" id="ext-cta-scroll" style="display:inline-block;padding:8px 14px;background:var(--primary);color:#fff;border-radius:8px;font-size:12.5px;font-weight:600;text-decoration:none">↓ ไปที่ปุ่ม Pair</a>';
  } else if (pairFound && isAdminPair) {
    // ============================ State 3: Paired เป็น Admin (bypass) ============================
    bgColor = '#fefce8'; borderColor = '#fcd34d'; textColor = '#854d0e';
    iconStr = '⚠️';
    mainText = `ใช้งานได้แบบ Admin — เห็นทุก site (bypass team filter)`;
    subText = `Paired เป็น <strong>${escapeHtml(pairedUser.label || 'admin')}</strong> (member_id=null) · หากต้องการทดสอบ team filter ให้กด Unpair แล้ว pair ใหม่ในฐานะ member`;
  } else if (pairFound && isMemberPair) {
    // ============================ State 4: พร้อมใช้งาน (member-paired) ============================
    bgColor = '#f0fdf4'; borderColor = '#86efac'; textColor = '#15803d';
    iconStr = '✅';
    mainText = 'พร้อมใช้งาน';
    subText = `Paired กับ <strong>${escapeHtml(pairedUser.label)}</strong> (member, ID ${escapeHtml(String(pairedUser.member_id))}) · autofill แสดงตามสิทธิ์ใน Team`;
  } else if (s.connected && !pairFound) {
    // ============================ State 5: Backend เห็น heartbeat แต่หน้านี้ไม่เจอ extension ============================
    // (น่าจะเปิดอีก browser/profile หรือ extension ของหน้านี้ปิดอยู่)
    bgColor = '#fefce8'; borderColor = '#fcd34d'; textColor = '#854d0e';
    iconStr = '⚠️';
    mainText = 'Extension ทำงานบนเครื่องอื่น';
    subText = `Backend เห็น heartbeat ล่าสุด ${fmtRelativeTh(s.last_seen)} แต่หน้านี้ไม่เจอ extension — อาจเปิดบน browser/profile อื่น หรือต้อง Reload extension ในเครื่องนี้`;
  } else {
    // ============================ State 6: เคยทำงาน แต่หายไป ============================
    bgColor = '#fff7ed'; borderColor = '#fdba74'; textColor = '#9a3412';
    iconStr = '⚠️';
    mainText = 'Extension ไม่ตอบ';
    subText = `เห็นล่าสุด ${fmtRelativeTh(s.last_seen)} — ไป chrome://extensions แล้วกด Reload`;
  }

  // เขียน UI
  card.style.background = bgColor;
  card.style.borderColor = borderColor;
  icon.textContent = iconStr;
  text.style.color = textColor;
  text.innerHTML = mainText;
  sub.style.color = textColor;
  sub.innerHTML = subText;
  cta.innerHTML = ctaHtml;

  // metadata (small text below)
  const parts = [];
  if (s && s.last_seen) parts.push(`เห็นล่าสุด ${fmtRelativeTh(s.last_seen)}`);
  if (s && s.call_count > 0) parts.push(`${s.call_count.toLocaleString('th-TH')} requests`);
  if (s && s.last_snapshot) {
    const snap = s.last_snapshot;
    if (snap.host_name) parts.push(`💻 ${escapeHtml(snap.host_name)}`);
    if (snap.user_agent) {
      const m = snap.user_agent.match(/Chrome\/[\d.]+/);
      if (m) parts.push(`🌐 ${m[0]}`);
    }
  }
  meta.innerHTML = parts.length ? parts.join(' &nbsp;·&nbsp; ') : '';

  // wire CTA scroll
  const scrollBtn = document.getElementById('ext-cta-scroll');
  if (scrollBtn) {
    scrollBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const pairBtn = document.getElementById('pair-btn');
      if (pairBtn) {
        pairBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        pairBtn.style.outline = '3px solid var(--primary)';
        setTimeout(() => { pairBtn.style.outline = ''; }, 2000);
      }
    });
  }
}

function startExtStatusPolling() {
  stopExtStatusPolling();
  loadExtensionStatus();
  _extStatusTimer = setInterval(loadExtensionStatus, 5000);
}

/**
 * Active probe — ส่ง postMessage ให้ content.js ของ extension ที่รันบนหน้านี้
 * extension จะส่งต่อให้ background → fetch backend ทันที → ตอบกลับผ่าน postMessage
 * Returns: {ok, backend, status, error, reason: 'timeout'|'extension'|'backend'}
 */
function activeProbeExtension(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const requestId = 'fct_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const handler = (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || d.type !== 'FCT_PING_RESULT' || d.requestId !== requestId) return;
      cleanup();
      resolve(d);
    };
    const cleanup = () => {
      window.removeEventListener('message', handler);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    window.addEventListener('message', handler);
    window.postMessage({ type: 'FCT_FORCE_PING', requestId }, '*');
  });
}

async function manualRefreshStatus() {
  const dot = $('ext-status-dot');
  const text = $('ext-status-text');
  const sub = $('ext-status-sub');
  const meta = $('ext-status-meta');
  if (!dot) return;

  // Probing state
  stopExtStatusPolling();
  dot.style.background = '#94a3b8';
  dot.style.boxShadow = '0 0 0 6px rgba(148,163,184,.15)';
  text.textContent = '⏳ กำลัง probe extension…';
  text.style.color = 'var(--text-muted)';
  sub.textContent = 'ส่งคำสั่งให้ extension ping backend ตอนนี้';
  meta.innerHTML = '';

  const result = await activeProbeExtension(4000);

  if (result.ok) {
    // ปิงสำเร็จ — refresh status จาก backend (heartbeat ใหม่ updated)
    await loadExtensionStatus();
    startExtStatusPolling();
    return;
  }

  if (result.reason === 'timeout') {
    dot.style.background = 'var(--critical)';
    dot.style.boxShadow = '0 0 0 6px rgba(220,38,38,.12)';
    text.textContent = '❌ Extension ไม่ตอบ';
    text.style.color = 'var(--critical)';
    sub.innerHTML = 'ไม่ได้ install หรือ extension ปิดอยู่ — เปิด <code>chrome://extensions</code> เช็คว่า "FEFL Beat" enabled + reload';
    meta.innerHTML = '';
  } else {
    // Extension ตอบกลับ แต่ ping backend ไม่ผ่าน
    dot.style.background = 'var(--critical)';
    dot.style.boxShadow = '0 0 0 6px rgba(220,38,38,.12)';
    text.textContent = '❌ Extension ติดต่อ backend ไม่ได้';
    text.style.color = 'var(--critical)';

    let reason = '';
    if (result.status === 401) {
      reason = 'API Key ใน extension ไม่ตรง — copy ใหม่จาก step 2.2 ด้านล่าง';
    } else if (result.status === 0 || (result.error || '').toLowerCase().includes('failed to fetch')) {
      reason = 'Backend URL ใน extension ผิด — ตั้งเป็น URL จาก step 2.1 ด้านล่าง';
    } else if (result.status) {
      reason = `Backend ตอบกลับ HTTP ${result.status}`;
    } else if (result.error) {
      reason = `Error: ${result.error}`;
    } else {
      reason = 'ไม่ทราบสาเหตุ';
    }
    sub.textContent = reason;
    meta.innerHTML = result.backend
      ? `Backend URL ที่ extension ตั้งไว้: <code style="font-size:11px;background:var(--bg-soft);padding:1px 5px;border-radius:4px">${escapeHtml(result.backend)}</code>`
      : '';
  }
}

function renderVersionCard(cl) {
  const cur = cl.current_entry;
  const ver = cl.current_version || '?';
  const olderVersions = (cl.versions || []).filter(v => v.version !== ver);

  const headerLine = cur
    ? `<span style="font-size:18px;font-weight:700;color:var(--primary)">v${escapeHtml(ver)}</span>
       <span style="margin-left:8px;font-size:14px;color:var(--text)">— ${escapeHtml(cur.title)}</span>`
    : `<span style="font-size:18px;font-weight:700;color:var(--primary)">v${escapeHtml(ver)}</span>
       <span style="margin-left:8px;font-size:13px;color:var(--text-muted)">(ไม่มี changelog entry)</span>`;

  const summary = cur && cur.summary
    ? `<div style="margin:6px 0 0;color:var(--text-muted);font-size:13px">${escapeHtml(cur.summary)}</div>`
    : '';

  const changesList = cur && cur.changes && cur.changes.length
    ? `<div style="margin-top:14px">
         <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">✨ ใหม่ในเวอร์ชันนี้</div>
         <ul style="margin:0;padding-left:20px;line-height:1.7;color:var(--text);font-size:13.5px">
           ${cur.changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
         </ul>
       </div>`
    : '';

  const olderSection = olderVersions.length > 0
    ? `<details style="margin-top:18px">
         <summary style="cursor:pointer;font-size:13px;color:var(--primary);font-weight:500;list-style:none">
           ▼ ดูประวัติเวอร์ชันที่ผ่านมา (${olderVersions.length})
         </summary>
         <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border);display:flex;flex-direction:column;gap:14px">
           ${olderVersions.map(v => `
             <div style="padding:12px 14px;background:var(--bg-soft);border-radius:8px;border:1px solid var(--border)">
               <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                 <span style="font-weight:700;color:var(--primary)">v${escapeHtml(v.version)}</span>
                 <span style="font-size:13px;font-weight:600">${escapeHtml(v.title || '—')}</span>
                 <span style="margin-left:auto;font-size:11.5px;color:var(--text-soft)">${escapeHtml(v.date || '')}</span>
               </div>
               ${v.summary ? `<div style="color:var(--text-muted);font-size:12.5px;margin-bottom:8px">${escapeHtml(v.summary)}</div>` : ''}
               ${v.changes && v.changes.length ? `
                 <ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--text);line-height:1.65">
                   ${v.changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}
                 </ul>
               ` : ''}
             </div>
           `).join('')}
         </div>
       </details>`
    : '';

  return `
    <div class="card" style="display:block;margin-bottom:14px;padding:20px 22px;background:linear-gradient(135deg, rgba(37,99,235,.04), rgba(124,58,237,.04));border-color:var(--primary-soft)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:22px">📦</span>
          <div>${headerLine}</div>
        </div>
        <a href="/api/admin/extension/download" class="btn primary" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none;font-size:12.5px;padding:7px 14px">
          📥 ดาวน์โหลดเวอร์ชันนี้
        </a>
      </div>
      ${summary}
      ${changesList}

      <div style="margin-top:18px;padding:12px 14px;background:var(--bg-soft);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:6px">🔄 วิธีอัพเดท extension (ไม่ต้อง remove)</div>
        <ol style="margin:0;padding-left:20px;line-height:1.7;color:var(--text);font-size:12.5px">
          <li>ดาวน์โหลด ZIP ใหม่ (ปุ่มด้านบน) — แตก <strong>ทับ folder เดิม</strong> (replace files)
            <br><span style="color:var(--text-muted);font-size:11.5px">หรือถ้า clone repo ไว้: <code style="background:var(--bg-card);padding:1px 5px;border-radius:3px;font-size:11px">git pull</code></span>
          </li>
          <li>เปิด <code style="background:var(--bg-card);padding:1px 5px;border-radius:3px;font-size:11px">chrome://extensions</code> → กดปุ่ม <strong>🔄 Reload</strong> บน card "FEFL Beat"</li>
          <li>เสร็จ — ไม่ต้อง re-pair, config เดิมยังอยู่</li>
        </ol>
      </div>

      ${olderSection}
    </div>
  `;
}

async function renderExtensionPage(mount) {
  mount = mount || $('main');   // v1.9.122 — render ลง container อื่นได้ (ใช้ใน Profile tab)
  const backendUrl = location.origin;

  // ดึง API Key (ทั้ง admin + member)
  let apiKey = null;
  let apiKeyError = null;
  try {
    const r = await fetchJson('/api/admin/api-key');
    apiKey = r.api_key;
  } catch (e) { apiKeyError = e.message; }

  // ดึง changelog (ทั้ง admin + member)
  let changelog = null;
  try {
    changelog = await fetchJson('/api/admin/extension/changelog');
  } catch {}

  mount.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🧩 Extension</h2>
      <button class="btn" id="ext-refresh" style="font-size:12px;padding:6px 12px">🔄 รีเฟรช status</button>
    </div>

    <!-- Unified status widget — รวม connectivity + pairing ในกล่องเดียว -->
    <div id="ext-status-card" class="card" style="display:block;margin-bottom:14px;padding:20px 24px;border-width:2px;transition:all .25s">
      <div style="display:flex;align-items:center;gap:16px">
        <div id="ext-status-icon" style="font-size:32px;line-height:1;flex-shrink:0">⏳</div>
        <div style="flex:1;min-width:0">
          <div id="ext-status-text" style="font-size:17px;font-weight:700;color:var(--text-muted);letter-spacing:-0.01em">กำลังตรวจสอบ…</div>
          <div id="ext-status-sub" style="font-size:13px;color:var(--text-muted);margin-top:4px;line-height:1.5">—</div>
          <div id="ext-status-meta" style="font-size:11.5px;color:var(--text-soft);margin-top:8px"></div>
        </div>
        <div id="ext-status-cta" style="flex-shrink:0"></div>
      </div>
    </div>

    <!-- Version card -->
    ${changelog ? renderVersionCard(changelog) : ''}

    <!-- Step 1: ติดตั้ง -->
    <div class="card" style="display:block;margin-bottom:14px">
      <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">
        <span style="display:inline-block;width:24px;height:24px;background:var(--primary);color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:12px;margin-right:8px">1</span>
        ติดตั้ง Extension เข้า Chrome
      </h3>
      <div style="margin-bottom:14px">
        <a href="/api/admin/extension/download" class="btn primary" style="display:inline-flex;align-items:center;gap:8px;text-decoration:none">
          📥 ดาวน์โหลด Extension (ZIP)
        </a>
        <span style="margin-left:10px;color:var(--text-muted);font-size:12px">
          ได้ไฟล์ zip — แตกออกแล้วเลือก folder ใน step ถัดไป
        </span>
      </div>
      <ol style="line-height:1.85;color:var(--text);font-size:13.5px;padding-left:20px;margin:0 0 12px">
        <li>เปิด Chrome พิมพ์ <code style="background:var(--bg-soft);padding:1px 6px;border-radius:4px">chrome://extensions</code> ใน address bar</li>
        <li>เปิดสวิตช์ <strong>Developer mode</strong> (มุมขวาบน)</li>
        <li>กด <strong>Load unpacked</strong> (มุมซ้ายบน)</li>
        <li>เลือก folder <strong>fefl-beat-extension</strong> ที่แตกออกมาจาก zip</li>
        <li>Extension "FEFL Beat" จะปรากฏใน toolbar — pin ไว้ใช้สะดวกกว่า</li>
      </ol>
    </div>

    <!-- Step 2: เชื่อมบัญชี (1-click) -->
    <div class="card" style="display:block;margin-bottom:14px;border-color:var(--primary);background:rgba(37,99,235,.04)">
      <h3 style="margin:0 0 8px;font-size:15px;font-weight:600">
        <span style="display:inline-block;width:24px;height:24px;background:var(--primary);color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:12px;margin-right:8px">2</span>
        🔗 เชื่อมบัญชีของคุณกับ Extension
      </h3>
      <p style="margin:0 0 14px;color:var(--text-muted);font-size:13px">
        กดปุ่มด้านล่างครั้งเดียว — ระบบจะส่ง Backend URL + API Key + ชื่อบัญชีคุณ ไปเก็บใน extension อัตโนมัติ — ไม่ต้องตั้ง options เอง
      </p>

      <div class="field" style="margin-bottom:10px">
        <label style="font-size:12.5px;font-weight:500;color:var(--text)">ชื่อเครื่อง (สำหรับ log)</label>
        <input id="device-label-input" type="text" placeholder="เช่น Anan MacBook, Office PC #3" maxlength="200" />
        <div class="hint" style="font-size:11.5px;color:var(--text-muted);margin-top:3px">
          แก้ไขได้ — ระบบ auto-fill จาก browser ให้ตอนเริ่ม
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="pair-btn" style="display:inline-flex;align-items:center;gap:8px">
          🔗 เชื่อมบัญชีของฉัน
        </button>
        <button class="btn" id="unpair-btn" style="display:inline-flex;align-items:center;gap:8px;background:#fef2f2;color:#991b1b;border-color:#fecaca">
          🔌 ยกเลิกการเชื่อมบัญชี (Unpair)
        </button>
      </div>
      <div class="hint" style="margin-top:8px;font-size:11.5px;color:var(--text-muted)">
        💡 สถานะ Pairing ปัจจุบันแสดงในกล่องสถานะด้านบน
      </div>
      <div id="pair-status" style="margin-top:10px;font-size:13px;display:none"></div>

      <details style="margin-top:14px">
        <summary style="cursor:pointer;font-size:12.5px;color:var(--text-muted)">หรือกรอก config เอง (manual)</summary>
        <div style="margin-top:10px">
          <div style="margin-bottom:10px">
            <div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-muted)">Backend URL</div>
            <div class="key-block">
              <span class="val" style="font-size:12px">${escapeHtml(backendUrl)}</span>
              <button class="btn" data-copy="${escapeHtml(backendUrl)}" style="white-space:nowrap;font-size:11px;padding:4px 9px">📋 คัดลอก</button>
            </div>
          </div>
          <div>
            <div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-muted)">API Key</div>
            <div class="key-block">
              <span class="val" id="ext-apikey" style="font-size:12px">${escapeHtml(apiKey || apiKeyError || '...')}</span>
              <button class="btn" id="ext-copy-apikey" style="white-space:nowrap;font-size:11px;padding:4px 9px" ${apiKey ? '' : 'disabled'}>📋 คัดลอก</button>
            </div>
          </div>
        </div>
      </details>
    </div>

    <!-- Step 3: Reload + ทดสอบ -->
    <div class="card" style="display:block;margin-bottom:14px">
      <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">
        <span style="display:inline-block;width:24px;height:24px;background:var(--primary);color:#fff;border-radius:50%;text-align:center;line-height:24px;font-size:12px;margin-right:8px">3</span>
        Reload + ทดสอบ
      </h3>
      <ol style="line-height:1.85;color:var(--text);font-size:13.5px;padding-left:20px;margin:0">
        <li>กลับ <code style="background:var(--bg-soft);padding:1px 6px;border-radius:4px">chrome://extensions</code> → กด <strong>🔄 Reload</strong> บน card "FEFL Beat" — สำคัญหลังเปลี่ยน config!</li>
        <li>เปิด tab ใหม่ไป <a href="https://www.freepik.com/log-in" target="_blank" style="color:var(--primary)">freepik.com/log-in</a> หรือ <a href="https://magnific.com" target="_blank" style="color:var(--primary)">magnific.com</a></li>
        <li>มุมขวาล่างของหน้าจอควรเห็นปุ่ม <strong>🔑 FEFL Beat : Sign On</strong></li>
        <li>คลิก → เลือก credential → form login จะถูกกรอกให้</li>
      </ol>
    </div>

    <!-- การใช้งาน -->
    <div class="card" style="display:block;margin-bottom:14px">
      <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">วิธีใช้งานสองโหมด</h3>
      <ul style="line-height:1.85;color:var(--text);font-size:13.5px;padding-left:20px;margin:0">
        <li><strong>เมื่อยังไม่ได้ login (เช่น freepik.com/log-in, magnific.com/login)</strong> — extension แสดงปุ่ม "🔑 FEFL Beat : Sign On" พร้อมรายชื่อบัญชี</li>
        <li><strong>เมื่อ login แล้ว</strong> — extension ติดตามยอดเครดิตอัตโนมัติ ส่งไป Dashboard (รองรับทั้ง <code>freepik.com</code> + <code>magnific.com</code>)</li>
        <li><strong>เพิ่มเว็บอื่น</strong> — admin ไปที่เมนู <a href="#/sites" style="color:var(--primary)">🛠 Config</a> → "+ เพิ่มเว็บใหม่"</li>
      </ul>
    </div>

    <!-- Troubleshooting -->
    <div class="card" style="display:block">
      <h3 style="margin:0 0 12px;font-size:15px;font-weight:600">🔧 Troubleshooting</h3>
      <div style="line-height:1.7;font-size:13px;color:var(--text)">

        <div style="margin-bottom:14px">
          <div style="font-weight:600;margin-bottom:4px">❌ Console: <code style="background:var(--bg-soft);padding:1px 5px;border-radius:4px">[FCT] prefill: backend unreachable, hiding widget: Failed to fetch</code></div>
          <div style="color:var(--text-muted);padding-left:14px">→ Backend URL ใน extension options ผิด หรือยังเป็น <code>localhost:8765</code> — แก้เป็น URL ด้านบนใน step 2.1 + reload extension</div>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-weight:600;margin-bottom:4px">❌ ปุ่ม Prefill ไม่โผล่บนหน้า login</div>
          <div style="color:var(--text-muted);padding-left:14px">→ เช็ค (1) extension reload หลัง config ใหม่แล้วหรือยัง (2) URL ของหน้านี้ตรง pattern ที่ตั้งไว้ใน Config หรือเปล่า (3) F12 → Console → filter "FCT" ดู error</div>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-weight:600;margin-bottom:4px">❌ คลิก Prefill แล้ว HTTP 401</div>
          <div style="color:var(--text-muted);padding-left:14px">→ API Key ไม่ตรง — copy จาก step 2.2 ใหม่ → วางใน extension options → reload extension</div>
        </div>

        <div>
          <div style="font-weight:600;margin-bottom:4px">❌ Service worker ค้าง</div>
          <div style="color:var(--text-muted);padding-left:14px">→ chrome://extensions → กดลิงก์ "service worker" สีน้ำเงินใน card → DevTools เปิด → ดู error / กด reload extension</div>
        </div>

      </div>
    </div>
  `;

  // Auto-detect device label จาก userAgentData → fill input
  (async () => {
    const inp = $('device-label-input');
    if (!inp) return;
    let label = '';
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const data = await navigator.userAgentData.getHighEntropyValues(['platform']);
        const brand = (navigator.userAgentData.brands || [])
          .find(b => /Chrome|Edge/.test(b.brand));
        const browserLabel = brand ? brand.brand.replace('Google ', '') + ' ' + brand.version : 'Chrome';
        label = (data.platform || 'Unknown') + ' · ' + browserLabel;
      }
    } catch {}
    if (!label) {
      // Fallback: parse user-agent
      const ua = navigator.userAgent;
      let os = 'Unknown';
      if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
      else if (/Windows/.test(ua)) os = 'Windows';
      else if (/Linux/.test(ua)) os = 'Linux';
      else if (/Android/.test(ua)) os = 'Android';
      else if (/iPhone|iPad/.test(ua)) os = 'iOS';
      const m = ua.match(/Chrome\/([\d.]+)/);
      const chrome = m ? 'Chrome ' + m[1].split('.')[0] : 'Chrome';
      label = os + ' · ' + chrome;
    }
    inp.value = label;
  })();

  // pair button → ส่ง config ผ่าน postMessage ไปให้ extension
  const pairBtn = $('pair-btn');
  if (pairBtn) {
    pairBtn.addEventListener('click', async () => {
      const status = $('pair-status');
      pairBtn.disabled = true;
      status.style.display = '';
      status.style.color = 'var(--text-muted)';
      status.textContent = '⏳ กำลังเชื่อม...';

      // เก็บ config — ทั้ง admin และ member ได้ API key (ดึงจาก /api/admin/api-key)
      let myApiKey = apiKey;
      let pairedUser = null;

      // หา label ของ user ที่ login ปัจจุบัน
      const deviceLabel = ($('device-label-input')?.value || '').trim() || null;
      try {
        if (currentRole === 'admin') {
          const s = await fetch('/api/admin/state', { credentials: 'same-origin' }).then(r => r.json());
          pairedUser = {
            role: 'admin', label: s.username, member_id: null,
            deviceLabel, paired_at: new Date().toISOString(),
          };
        } else {
          const m = await fetch('/api/member/me', { credentials: 'same-origin' }).then(r => r.json());
          if (m.logged_in && m.member) {
            const md = m.member;
            pairedUser = {
              role: 'member',
              label: md.display_name || md.email || md.phone,
              member_id: md.id,
              deviceLabel,
              paired_at: new Date().toISOString(),
            };
          }
        }
      } catch {}

      const config = {
        backendUrl: backendUrl,
        apiKey: myApiKey || null,    // member อาจไม่มี
        pairedUser,
      };

      // ส่ง postMessage รอ reply
      const requestId = 'fct_pair_' + Date.now();
      const handler = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.type !== 'FCT_PAIR_RESULT' || d.requestId !== requestId) return;
        cleanup();
        if (d.ok) {
          status.style.color = 'var(--green)';
          status.innerHTML = `✓ เชื่อมสำเร็จ — extension รู้แล้วว่าคุณคือ <strong>${escapeHtml(pairedUser?.label || 'unknown')}</strong>` +
            (deviceLabel ? ` จาก <strong>${escapeHtml(deviceLabel)}</strong>` : '');
          // refresh status widget
          setTimeout(() => loadExtensionStatus(), 500);
        } else {
          status.style.color = 'var(--critical)';
          status.textContent = '❌ เชื่อมไม่สำเร็จ: ' + (d.error || 'extension ไม่ตอบ');
        }
        pairBtn.disabled = false;
      };
      const timer = setTimeout(() => {
        cleanup();
        status.style.color = 'var(--critical)';
        status.innerHTML = '❌ Extension ไม่ตอบใน 4 วินาที — install + reload extension แล้วลองใหม่';
        pairBtn.disabled = false;
      }, 4000);
      const cleanup = () => {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
      };

      window.addEventListener('message', handler);
      window.postMessage({ type: 'FCT_PAIR', requestId, config }, '*');
    });
  }

  // ----- Unpair button -----
  const unpairBtn = $('unpair-btn');
  if (unpairBtn) {
    unpairBtn.addEventListener('click', async () => {
      if (!confirm('ลบ pairing ของ extension? (extension จะกลับเป็น unpaired — ไม่มี member_id ส่งไป backend)')) return;
      const status = $('pair-status');
      unpairBtn.disabled = true;
      status.style.display = '';
      status.style.color = 'var(--text-muted)';
      status.textContent = '⏳ กำลัง unpair...';

      const requestId = 'fct_unpair_' + Date.now();
      const handler = (ev) => {
        if (ev.source !== window) return;
        const d = ev.data;
        if (!d || d.type !== 'FCT_UNPAIR_RESULT' || d.requestId !== requestId) return;
        cleanup();
        if (d.ok) {
          status.style.color = '#15803d';
          status.innerHTML = '✓ Unpaired แล้ว — extension จะ <strong>ไม่แสดง autofill widget</strong> บนเว็บใดทั้งสิ้น จนกว่าจะ pair ใหม่<br/><span style="color:var(--text-muted);font-size:12px">หาก reload หน้าเว็บที่เคยมี widget แล้วยังโผล่ ให้ <code>chrome://extensions</code> → Reload extension อีกครั้ง</span>';
          // refresh top status widget
          setTimeout(() => loadExtensionStatus(), 300);
        } else {
          status.style.color = 'var(--critical)';
          status.textContent = '❌ Unpair ไม่สำเร็จ: ' + (d.error || 'extension ไม่ตอบ');
        }
        unpairBtn.disabled = false;
      };
      const timer = setTimeout(() => {
        cleanup();
        status.style.color = 'var(--critical)';
        status.innerHTML = '❌ Extension ไม่ตอบใน 4 วินาที — reload extension แล้วลองใหม่';
        unpairBtn.disabled = false;
      }, 4000);
      const cleanup = () => {
        window.removeEventListener('message', handler);
        clearTimeout(timer);
      };
      window.addEventListener('message', handler);
      window.postMessage({ type: 'FCT_UNPAIR', requestId }, '*');
    });
  }

  // wire copy buttons
  document.querySelectorAll('button[data-copy]').forEach(b => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy);
      const orig = b.textContent;
      b.textContent = '✓ คัดลอกแล้ว';
      setTimeout(() => { b.textContent = orig; }, 1200);
    });
  });
  if (apiKey) {
    const btn = $('ext-copy-apikey');
    if (btn) {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(apiKey);
        const orig = btn.textContent;
        btn.textContent = '✓ คัดลอกแล้ว';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    }
  }

  // Start polling status (admin + member)
  startExtStatusPolling();
  const refreshBtn = $('ext-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', manualRefreshStatus);
}

// ---------- modal helper ----------
function showModal({ title, body, onSubmit, size, slide }) {
  // size: 'wide' (720px) | 'xwide' (920px) | undefined (440px default)
  // slide: true → สไลด์จากด้านขวา (drawer) แทน popup กลางจอ
  const sizeClass = size === 'wide' ? ' modal-wide' : size === 'xwide' ? ' modal-xwide' : '';
  const bg = document.createElement('div');
  bg.className = 'modal-bg' + (slide ? ' is-slide' : '');
  bg.innerHTML = `
    <div class="modal${sizeClass}">
      <h3>${escapeHtml(title)}</h3>
      <div id="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn" id="m-cancel">ยกเลิก</button>
        <button class="btn primary" id="m-ok">บันทึก</button>
      </div>
      <div class="hint" id="m-err" style="color:var(--critical);margin-top:6px;display:none"></div>
    </div>
  `;
  document.body.appendChild(bg);
  if (slide) requestAnimationFrame(() => bg.classList.add('is-open'));

  const close = () => {
    if (slide) { bg.classList.remove('is-open'); setTimeout(() => bg.remove(), 280); }
    else bg.remove();
  };
  bg.querySelector('#m-cancel').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.querySelector('#m-ok').addEventListener('click', async (ev) => {
    const okBtn = ev.currentTarget;
    const errEl = bg.querySelector('#m-err');
    if (okBtn.disabled) return;                 // กันกดซ้ำระหว่างบันทึก
    errEl.style.display = 'none';
    const orig = okBtn.textContent;
    okBtn.disabled = true; okBtn.style.opacity = '0.65'; okBtn.style.cursor = 'wait';
    okBtn.textContent = 'กำลังบันทึก…';
    try {
      await onSubmit();
      close();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
      okBtn.disabled = false; okBtn.style.opacity = ''; okBtn.style.cursor = '';
      okBtn.textContent = orig;
    }
  });
}

// ---------- bootstrap ----------
// v1.9.118 — Hamburger → left slide-in drawer (Google Cloud style)
(() => {
  const btn = $('hamburgerBtn'); const menu = $('brandMenu');
  const backdrop = $('brandBackdrop'); const closeBtn = $('brandDrawerClose');
  if (!btn || !menu) return;
  // v1.9.119 — ย้าย drawer ออกนอก ancestor ที่มี backdrop-filter/transform (กัน fixed ถูก clip)
  if (backdrop) document.body.appendChild(backdrop);
  document.body.appendChild(menu);
  const open = () => { menu.classList.add('is-open'); if (backdrop) backdrop.classList.add('is-open'); };
  const close = () => { menu.classList.remove('is-open'); if (backdrop) backdrop.classList.remove('is-open'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.contains('is-open') ? close() : open();
  });
  if (backdrop) backdrop.addEventListener('click', close);
  if (closeBtn) closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  // ปิด drawer เมื่อคลิกลิงก์ในเมนู
  menu.querySelectorAll('.brand-menu-item').forEach(a => a.addEventListener('click', close));
  document.querySelectorAll('.brand-menu-item[data-host]').forEach(a => {
    if (a.dataset.host === location.hostname) a.classList.add('current');
  });
})();

// v1.9.78 — Mobile drawer (sidebar slide-in on ≤768px)
(() => {
  const toggle = $('mobile-menu-toggle');
  const backdrop = $('mobile-backdrop');
  const sidebar = document.querySelector('body > aside');
  const titleEl = $('mobile-topbar-title');
  if (!toggle || !backdrop || !sidebar) return;
  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
  const open  = () => { sidebar.classList.add('is-open'); backdrop.classList.add('is-open'); };
  const close = () => { sidebar.classList.remove('is-open'); backdrop.classList.remove('is-open'); };
  toggle.addEventListener('click', open);
  backdrop.addEventListener('click', close);
  // close เมื่อกด nav link (เพื่อให้ user เห็น content)
  document.querySelectorAll('aside .nav a, aside .nav-group-children a').forEach(a => {
    a.addEventListener('click', () => { if (isMobile()) close(); });
  });
  // resize → ถ้ากลับเป็น desktop ปิด drawer อัตโนมัติ
  window.addEventListener('resize', () => { if (!isMobile()) close(); });
  // อัพเดท title ตาม route (page-title ของ main)
  const updateTitle = () => {
    if (!titleEl) return;
    const pt = document.querySelector('main h2.page-title');
    titleEl.textContent = pt ? pt.textContent.trim() : 'FEFL Beat';
  };
  // observe DOM mutations ใน main เพื่ออัพเดท title อัตโนมัติ
  const main = document.getElementById('main');
  if (main && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => updateTitle()).observe(main, { childList: true, subtree: true });
  }
  setTimeout(updateTitle, 100);
})();

