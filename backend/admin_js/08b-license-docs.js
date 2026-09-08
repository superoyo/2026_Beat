// ============== v1.9.404 — เอกสารควบคุม license (Platform tab) ==============
// ชื่อไฟล์ 08b-* เพื่อให้ถูก concat ก่อน 10-profiles-boot.js (server ต่อไฟล์ตามลำดับชื่อ)
// อัพโหลดไฟล์/รูป → แสดงเป็นการ์ด (thumbnail) → คลิกเปิด preview → ⭐ ทับบนภาพเพื่อดึงขึ้นบนสุด

let _licDocs = [];
let _licLoading = false;

const _LIC_MAX_MB = 12;
function _licIsImg(d){ return String(d.file_mime||'').startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(d.file_name||''); }
function _licIsPdf(d){ return String(d.file_mime||'').includes('pdf') || /\.pdf$/i.test(d.file_name||''); }
function _licFileUrl(d){ return API + '/api/license-docs/' + d.id + '/file'; }
function _licSize(n){
  if(!n) return '';
  if(n < 1024) return n + ' B';
  if(n < 1024*1024) return (n/1024).toFixed(0) + ' KB';
  return (n/1024/1024).toFixed(1) + ' MB';
}
function _licDate(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(isNaN(d)) return '';
  return `${d.getDate()} ${_CC_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function _licFileToDataUrl(file){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(new Error('อ่านไฟล์ไม่ได้')); r.readAsDataURL(file); });
}

// ---- หน้าเมนู: dropzone + grid ----
async function renderLicenseDocs(){
  const root = $('license-docs-root');
  if(!root) return;
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="font-size:23px;font-weight:800;letter-spacing:-0.02em">📑 เอกสารควบคุม license</div>
        <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px">อัพโหลดไฟล์สัญญา / ใบอนุญาต / license key แล้วกด ⭐ บนภาพเพื่อปักไว้บนสุด</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
        <input id="lic-search" type="text" placeholder="🔍 ค้นหาเอกสาร…" autocomplete="off"
               style="padding:9px 13px;font-size:13px;border:1px solid var(--border);border-radius:10px;background:var(--bg-input);color:var(--text);width:220px" />
        <button type="button" class="btn primary" id="lic-up-btn" style="font-size:13px;padding:9px 16px">⬆️ อัพโหลด</button>
      </div>
    </div>
    <div id="lic-drop" title="คลิก หรือลากไฟล์มาวาง"
         style="border:2px dashed var(--border);border-radius:14px;padding:22px;text-align:center;color:var(--text-muted);font-size:13px;margin-bottom:16px;cursor:pointer;transition:border-color .12s,background .12s;line-height:1.7">
      <b style="font-size:14px">⬆️ ลากไฟล์มาวาง หรือคลิกเพื่อเลือก</b><br>
      <span style="font-size:12px">รูปภาพ / PDF / ไฟล์เอกสาร — ไม่เกิน ${_LIC_MAX_MB}MB ต่อไฟล์ · อัพโหลดทันที ไม่ถาม</span>
      <input id="lic-file" type="file" multiple style="display:none" />
    </div>
    <div id="lic-status" style="font-size:12.5px;margin-bottom:12px;min-height:0"></div>
    <div id="lic-grid"><div class="empty">กำลังโหลด…</div></div>`;

  const fileInp = $('lic-file'), dz = $('lic-drop'), st = $('lic-status');
  const pick = ()=>fileInp.click();
  dz.onclick = pick;
  $('lic-up-btn').onclick = pick;
  fileInp.onchange = ()=>{ if(fileInp.files && fileInp.files.length){ _licUpload(fileInp.files); fileInp.value=''; } };
  const dzOn = ()=>{ dz.style.borderColor='var(--primary)'; dz.style.background='var(--primary-soft)'; };
  const dzOff = ()=>{ dz.style.borderColor='var(--border)'; dz.style.background='transparent'; };
  dz.addEventListener('dragover', e=>{ e.preventDefault(); dzOn(); });
  dz.addEventListener('dragleave', e=>{ e.preventDefault(); dzOff(); });
  dz.addEventListener('drop', e=>{ e.preventDefault(); dzOff(); const fs=e.dataTransfer && e.dataTransfer.files; if(fs && fs.length) _licUpload(fs); });
  const si = $('lic-search');
  if(si) si.addEventListener('input', ()=>_licPaint());

  await _licLoad();
}

async function _licLoad(){
  if(_licLoading) return;
  _licLoading = true;
  try{ _licDocs = (await fetchJson('/api/license-docs')).docs || []; }
  catch(e){ const g=$('lic-grid'); if(g) g.innerHTML=`<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`; return; }
  finally{ _licLoading = false; }
  _licPaint();
}

// การ์ด 1 ใบ — รูปเต็มการ์ด + ⭐ ทับมุมขวาบนของภาพ
function _licCardHtml(d){
  const url = _licFileUrl(d);
  const thumb = _licIsImg(d)
    ? `<img src="${url}" alt="" loading="lazy" style="width:100%;height:150px;object-fit:cover;display:block;background:var(--bg-soft)" />`
    : `<div style="width:100%;height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:var(--bg-soft);color:var(--text-muted)">
         <span style="font-size:36px;line-height:1">${_licIsPdf(d)?'📕':'📄'}</span>
         <span style="font-size:11px;font-weight:700;letter-spacing:.5px">${_licIsPdf(d)?'PDF':escapeHtml((d.file_name||'').split('.').pop().slice(0,6).toUpperCase()||'FILE')}</span>
       </div>`;
  const star = d.is_starred;
  return `<div class="lic-card card" data-doc="${d.id}" style="display:block;padding:0;margin:0;overflow:hidden;cursor:pointer;border:1px solid ${star?'#f59e0b':'var(--border)'}">
    <div style="position:relative">
      ${thumb}
      <button type="button" class="lic-star" data-doc="${d.id}" title="${star?'เอาออกจากบนสุด':'ปักไว้บนสุด'}"
              style="position:absolute;top:8px;right:8px;width:32px;height:32px;border-radius:50%;border:1px solid ${star?'#f59e0b':'rgba(255,255,255,.7)'};background:${star?'#fbbf24':'rgba(15,23,42,.55)'};color:${star?'#7c2d12':'#fff'};font-size:15px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);box-shadow:0 2px 6px rgba(15,23,42,.25)">${star?'★':'☆'}</button>
      ${star?`<span style="position:absolute;top:8px;left:8px;padding:2px 9px;border-radius:999px;background:#fbbf24;color:#7c2d12;font-size:10.5px;font-weight:800;box-shadow:0 2px 6px rgba(15,23,42,.2)">★ บนสุด</span>`:''}
    </div>
    <div style="padding:10px 12px 11px">
      <div class="lic-title" style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(d.title||d.file_name||'')}">${escapeHtml(d.title||d.file_name||'—')}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px">
        <span style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.uploaded_by||'—')} · ${_licDate(d.created_at)}</span>
        <span style="font-size:11px;color:var(--text-soft);flex-shrink:0">${_licSize(d.file_size)}</span>
      </div>
    </div>
  </div>`;
}

function _licPaint(){
  const g = $('lic-grid'); if(!g) return;
  const si = $('lic-search');
  const q = ((si && si.value) || '').trim().toLowerCase();
  const list = q
    ? _licDocs.filter(d=>((d.title||'')+' '+(d.file_name||'')+' '+(d.note||'')+' '+(d.uploaded_by||'')).toLowerCase().includes(q))
    : _licDocs;
  if(!list.length){
    g.innerHTML = `<div class="empty" style="padding:34px;text-align:center;color:var(--text-muted)">${_licDocs.length?'— ไม่พบเอกสารที่ค้นหา —':'— ยังไม่มีเอกสาร — ลากไฟล์มาวางที่กล่องด้านบน —'}</div>`;
    return;
  }
  const starred = list.filter(d=>d.is_starred), rest = list.filter(d=>!d.is_starred);
  const grid = (arr)=>`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px">${arr.map(_licCardHtml).join('')}</div>`;
  const head = (t,n)=>`<div style="font-size:11.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin:0 2px 8px">${t} <span style="color:var(--text-soft)">(${n})</span></div>`;
  g.innerHTML = (starred.length ? head('★ ปักไว้บนสุด', starred.length) + grid(starred) + '<div style="height:20px"></div>' : '')
              + (rest.length ? (starred.length ? head('เอกสารทั้งหมด', rest.length) : '') + grid(rest) : '');
  g.querySelectorAll('.lic-star').forEach(b=>b.addEventListener('click', (e)=>{ e.stopPropagation(); _licToggleStar(parseInt(b.dataset.doc,10)); }));
  g.querySelectorAll('.lic-card').forEach(c=>c.addEventListener('click', ()=>{
    const d = _licDocs.find(x=>x.id===parseInt(c.dataset.doc,10));
    if(d) _licPreview(d);
  }));
}

async function _licToggleStar(id){
  const d = _licDocs.find(x=>x.id===id); if(!d) return;
  const next = !d.is_starred;
  try{ await fetchJson('/api/license-docs/'+id+'/star',{method:'PATCH',body:JSON.stringify({starred:next})}); }
  catch(e){ alert(e.message); return; }
  await _licLoad();          // โหลดใหม่เพื่อให้ลำดับ (ดาวขึ้นบนสุด) ตรงกับ server
}

async function _licUpload(files){
  const st = $('lic-status');
  const setSt = (t,color)=>{ if(st){ st.textContent=t; st.style.color=color||'var(--text-muted)'; } };
  files = Array.from(files||[]);
  if(!files.length) return;
  let ok=0, fail=0;
  for(let i=0;i<files.length;i++){
    const f = files[i];
    if(f.size > _LIC_MAX_MB*1024*1024){ setSt(`⚠️ ข้าม ${f.name} (เกิน ${_LIC_MAX_MB}MB)`,'var(--critical)'); fail++; continue; }
    setSt(`⬆️ กำลังอัพโหลด ${i+1}/${files.length}: ${f.name}…`,'var(--primary)');
    let fileData;
    try{ fileData = await _licFileToDataUrl(f); }catch(e){ fail++; continue; }
    try{
      await fetchJson('/api/license-docs',{method:'POST',body:JSON.stringify({
        title:f.name, file_data:fileData, file_name:f.name, file_mime:f.type||'application/octet-stream' })});
      ok++;
    }catch(e){ fail++; setSt(`⚠️ ${f.name}: ${e.message}`,'var(--critical)'); }
  }
  setSt(`✓ อัพโหลดแล้ว ${ok} ไฟล์${fail?` · ข้าม ${fail}`:''}`, ok?'var(--green)':'var(--critical)');
  await _licLoad();
}

// ---- preview: แสดงภาพ/ไฟล์ + ⭐ ทับบนภาพ + ดาวน์โหลด ----
function _licPreview(d){
  const url = _licFileUrl(d);
  const inner = _licIsImg(d)
    ? `<img id="lic-prev-img" src="${url}" alt="" style="width:100%;max-height:76vh;object-fit:contain;display:block;background:#0f172a" />`
    : `<iframe src="${url}" style="width:100%;height:76vh;border:0;background:#fff;display:block" title="preview"></iframe>`;
  const bg = document.createElement('div'); bg.className='modal-bg'; bg.style.zIndex='1200';
  bg.innerHTML = `<div class="modal modal-xwide" style="max-width:960px;padding:16px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <div id="lic-prev-title" style="font-size:15px;font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.title||d.file_name||'—')}</div>
          <button type="button" id="lic-prev-edit" title="แก้ชื่อเอกสาร" style="border:none;background:none;cursor:pointer;font-size:13px;opacity:.55;padding:0;flex-shrink:0">✏️</button>
        </div>
        <div id="lic-prev-editrow" style="display:none;align-items:center;gap:6px;margin-top:4px">
          <input id="lic-prev-inp" type="text" value="${escapeHtml(d.title||'')}" maxlength="300" placeholder="ชื่อเอกสาร"
                 style="font-size:13px;padding:5px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text);width:340px;max-width:60vw" />
          <button type="button" class="btn" id="lic-prev-save" style="font-size:13px;padding:4px 10px;color:var(--green)">✓ บันทึก</button>
          <button type="button" class="btn" id="lic-prev-cancel" style="font-size:13px;padding:4px 9px">✕</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">${escapeHtml(d.file_name||'')} · ${_licSize(d.file_size)} · ${escapeHtml(d.uploaded_by||'—')} · ${_licDate(d.created_at)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <a href="${url}" download="${escapeHtml(d.file_name||'document')}" class="btn" style="font-size:12px">⬇️ ดาวน์โหลด</a>
        <a href="${url}" target="_blank" rel="noopener" class="btn" style="font-size:12px">↗ แท็บใหม่</a>
        <button class="btn danger" id="lic-prev-del" style="font-size:12px">🗑 ลบ</button>
        <button class="btn" id="lic-prev-close" style="font-size:12px">ปิด</button>
      </div>
    </div>
    <div style="position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--border)">
      ${inner}
      <button type="button" id="lic-prev-star" title="${d.is_starred?'เอาออกจากบนสุด':'ปักไว้บนสุด'}"
              style="position:absolute;top:12px;right:12px;width:40px;height:40px;border-radius:50%;border:1px solid ${d.is_starred?'#f59e0b':'rgba(255,255,255,.7)'};background:${d.is_starred?'#fbbf24':'rgba(15,23,42,.55)'};color:${d.is_starred?'#7c2d12':'#fff'};font-size:19px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);box-shadow:0 2px 8px rgba(15,23,42,.3)">${d.is_starred?'★':'☆'}</button>
    </div>
  </div>`;
  document.body.appendChild(bg);
  const close = ()=>bg.remove();
  bg.querySelector('#lic-prev-close').onclick = close;
  bg.addEventListener('click', e=>{ if(e.target===bg) close(); });

  // ⭐ ทับบนภาพ — กดแล้วดึงขึ้นบนสุด (อัพเดตปุ่มในที่ทันที ไม่ต้องปิด modal)
  const starBtn = bg.querySelector('#lic-prev-star');
  starBtn.onclick = async ()=>{
    const next = !d.is_starred;
    starBtn.disabled = true;
    try{ await fetchJson('/api/license-docs/'+d.id+'/star',{method:'PATCH',body:JSON.stringify({starred:next})}); }
    catch(e){ alert(e.message); starBtn.disabled=false; return; }
    d.is_starred = next;
    starBtn.textContent = next ? '★' : '☆';
    starBtn.title = next ? 'เอาออกจากบนสุด' : 'ปักไว้บนสุด';
    starBtn.style.background = next ? '#fbbf24' : 'rgba(15,23,42,.55)';
    starBtn.style.color = next ? '#7c2d12' : '#fff';
    starBtn.style.borderColor = next ? '#f59e0b' : 'rgba(255,255,255,.7)';
    starBtn.disabled = false;
    await _licLoad();
  };

  // ลบเอกสาร
  bg.querySelector('#lic-prev-del').onclick = async ()=>{
    if(!confirm(`ลบเอกสาร "${d.title||d.file_name||''}"?`)) return;
    try{ await fetchJson('/api/license-docs/'+d.id,{method:'DELETE'}); }
    catch(e){ alert(e.message); return; }
    close();
    await _licLoad();
  };

  // แก้ชื่อเอกสาร inline
  const titleEl = bg.querySelector('#lic-prev-title'), editBtn = bg.querySelector('#lic-prev-edit');
  const editRow = bg.querySelector('#lic-prev-editrow'), inp = bg.querySelector('#lic-prev-inp');
  const openEdit = ()=>{ titleEl.style.display='none'; editBtn.style.display='none'; editRow.style.display='flex'; inp.focus(); inp.select(); };
  const closeEdit = ()=>{ editRow.style.display='none'; titleEl.style.display=''; editBtn.style.display=''; };
  const save = async ()=>{
    const val = inp.value.trim();
    if(!val){ closeEdit(); return; }
    try{ const r = await fetchJson('/api/license-docs/'+d.id,{method:'PATCH',body:JSON.stringify({title:val,note:d.note||null})}); d.title = r.title || val; }
    catch(e){ alert(e.message); return; }
    titleEl.textContent = d.title;
    closeEdit();
    await _licLoad();
  };
  editBtn.onclick = openEdit;
  bg.querySelector('#lic-prev-save').onclick = save;
  bg.querySelector('#lic-prev-cancel').onclick = ()=>{ inp.value = d.title || ''; closeEdit(); };
  inp.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); save(); } else if(e.key==='Escape'){ e.preventDefault(); closeEdit(); } });
}
