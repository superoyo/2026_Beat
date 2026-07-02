// ====== Site form helpers (shared by add + edit) ======
const PAYMENT_TYPE_LABELS = {
  credit_card: 'บัตรเครดิต',
  debit_card: 'บัตรเดบิต',
  bank_transfer: 'โอนธนาคาร',
  promptpay: 'PromptPay',
  truemoney: 'TrueMoney Wallet',
  paypal: 'PayPal',
  crypto: 'Crypto',
  other: 'อื่นๆ',
};

let _cardOwnersCache = null;
async function getCardOwners() {
  if (_cardOwnersCache) return _cardOwnersCache;
  try {
    const r = await fetchJson('/api/admin/card-owners');
    _cardOwnersCache = r.card_owners || [];
  } catch { _cardOwnersCache = []; }
  return _cardOwnersCache;
}

function siteFormHTML(site) {
  // site อาจเป็น null (โหมด add) หรือ object (โหมด edit)
  // ข้อมูลการเงิน/billing ย้ายไปอยู่ที่ credential แล้ว — ฟอร์ม site เก็บ name + url_pattern + logo
  const s = site || {};
  const hasLogo = !!s.logo_data;
  return `
    <div class="field">
      <label>ชื่อเว็บ</label>
      <input id="m-name" type="text" value="${escapeHtml(s.name || '')}" placeholder="เช่น Behance, Adobe Stock" />
    </div>
    <div class="field">
      <label>URL pattern (ใช้ * เป็น wildcard)</label>
      <input id="m-pattern" type="text" value="${escapeHtml(s.url_pattern || '')}" placeholder="*.example.com/*" />
      <div class="hint">เช่น <code>*.freepik.com/*</code></div>
    </div>

    <!-- Logo section -->
    <div class="field">
      <label>โลโก้ (รูปสี่เหลี่ยมจัตุรัส)</label>
      <div style="display:flex;gap:14px;align-items:flex-start;margin-top:6px">
        <div id="m-logo-preview" style="width:96px;height:96px;border-radius:12px;border:1.5px dashed var(--border);background:${hasLogo ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
          ${hasLogo
            ? `<img src="${s.logo_data}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`
            : `<span style="color:var(--text-muted);font-size:11.5px;text-align:center;line-height:1.4">ยังไม่มี<br/>โลโก้</span>`
          }
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
          <button type="button" class="btn" id="m-logo-upload-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">📷 อัพโหลดไฟล์...</button>
          <button type="button" class="btn" id="m-logo-search-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">🔍 ค้นหาโลโก้จาก URL</button>
          <button type="button" class="btn danger" id="m-logo-remove-btn" style="font-size:12.5px;padding:7px 12px;text-align:left;${hasLogo ? '' : 'display:none'}">🗑 ลบโลโก้</button>
          <input type="file" id="m-logo-file-input" accept="image/*" style="display:none" />
        </div>
      </div>
      <input type="hidden" id="m-logo-data" value="${escapeHtml(s.logo_data || '')}" />
    </div>

    <div class="hint" style="background:var(--bg-soft);padding:10px 12px;border-radius:8px;color:var(--text-muted);font-size:12px;margin-top:8px">
      💡 ข้อมูลการเงิน (ค่าใช้จ่าย, รอบบิล, ใช้บัตรของ ฯลฯ) ตอนนี้กำหนดที่ <strong>แต่ละ credential</strong>
      เพราะ credential เดียวกันอาจจ่ายโดยคนละคน หรือคนละรอบ
    </div>
  `;
}

function siteFormCollect() {
  const data = {
    name: $('m-name').value.trim(),
    url_pattern: $('m-pattern').value.trim(),
  };
  // Logo — ส่งเฉพาะถ้าผู้ใช้มีการเปลี่ยนแปลง
  // - hidden input value ที่ต่างจาก initial → ส่ง
  // - empty string → ลบ logo (PATCH set NULL)
  const logoEl = $('m-logo-data');
  if (logoEl) {
    const cur = logoEl.value;
    const initial = logoEl.dataset.initial || '';
    if (cur !== initial) {
      data.logo_data = cur;   // empty string = clear
    }
  }
  return data;
}

async function bindSiteFormDynamic() {
  // เก็บค่าเริ่มต้นของ logo เพื่อ diff ตอน save
  const logoEl = $('m-logo-data');
  if (logoEl) logoEl.dataset.initial = logoEl.value;

  // อัพโหลดไฟล์
  const fileInput = $('m-logo-file-input');
  $('m-logo-upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => openCropModal(ev.target.result);
    reader.readAsDataURL(file);
    fileInput.value = '';   // reset เผื่อเลือกไฟล์เดิมซ้ำได้
  });

  // ค้นหาโลโก้จาก URL pattern
  $('m-logo-search-btn').addEventListener('click', () => {
    const pattern = $('m-pattern').value.trim();
    if (!pattern) {
      alert('กรอก URL pattern ก่อน (เช่น *.freepik.com/*)');
      return;
    }
    openLogoSearchModal(pattern);
  });

  // ลบโลโก้
  $('m-logo-remove-btn').addEventListener('click', () => {
    if (!confirm('ลบโลโก้ของเว็บนี้?')) return;
    setSiteLogoInForm('');   // empty = clear
  });
}

// ตั้งค่า logo (ทั้ง hidden input + preview + show/hide remove btn)
function setSiteLogoInForm(dataUrl) {
  const logoEl = $('m-logo-data');
  const preview = $('m-logo-preview');
  const removeBtn = $('m-logo-remove-btn');
  if (!logoEl || !preview) return;
  logoEl.value = dataUrl;
  if (dataUrl) {
    preview.style.background = 'var(--bg-card)';
    preview.innerHTML = `<img src="${dataUrl}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`;
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.style.background = 'var(--bg-soft)';
    preview.innerHTML = `<span style="color:var(--text-muted);font-size:11.5px;text-align:center;line-height:1.4">ยังไม่มี<br/>โลโก้</span>`;
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

// === Crop modal — Cropper.js ===
let _cropper = null;

function openCropModal(srcDataUrl, onSave, options) {
  // onSave: (dataUrl) => void — callback เมื่อ user crop สำเร็จ
  // options: {aspectRatio, outputWidth, outputHeight, outputType, outputQuality, title}
  //   defaults = square logo (1:1, 256x256, PNG)
  options = options || {};
  const aspectRatio = (options.aspectRatio != null) ? options.aspectRatio : 1;
  const outputWidth = options.outputWidth || 256;
  const outputHeight = options.outputHeight || 256;
  const outputType = options.outputType || 'image/png';
  const outputQuality = (options.outputQuality != null) ? options.outputQuality : 0.92;
  const title = options.title || '✂️ Crop โลโก้ (สี่เหลี่ยมจัตุรัส)';
  if (!onSave) onSave = setSiteLogoInForm;   // default: เขียนลง form (สำหรับ Add site modal)
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.style.zIndex = '1100';   // เหนือ site form modal
  bg.innerHTML = `
    <div class="modal modal-wide">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:700">${escapeHtml(title)}</h3>
      <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px">
        ลากเพื่อเลือกพื้นที่ • ใช้ scroll wheel เพื่อ zoom • ปุ่ม +/- สำหรับ zoom
      </div>
      <div style="background:#0f172a;border-radius:10px;overflow:hidden;max-height:400px">
        <img id="m-crop-img" src="${srcDataUrl}" style="display:block;max-width:100%" alt="crop" crossorigin="anonymous" />
      </div>
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="m-crop-zoom-out" type="button" style="font-size:14px;padding:6px 12px">−</button>
        <button class="btn" id="m-crop-zoom-in" type="button" style="font-size:14px;padding:6px 12px">+</button>
        <button class="btn" id="m-crop-reset" type="button" style="font-size:12.5px;padding:6px 12px">↺ Reset</button>
        <div style="flex:1"></div>
        <button class="btn" id="m-crop-cancel" type="button" style="font-size:13px;padding:7px 14px">ยกเลิก</button>
        <button class="btn primary" id="m-crop-save" type="button" style="font-size:13px;padding:7px 14px">✓ ใช้ภาพนี้</button>
      </div>
      <div class="hint" id="m-crop-err" style="color:var(--critical);margin-top:8px;display:none"></div>
    </div>
  `;
  document.body.appendChild(bg);

  const cleanup = () => {
    if (_cropper) { try { _cropper.destroy(); } catch {} _cropper = null; }
    bg.remove();
  };

  bg.querySelector('#m-crop-cancel').addEventListener('click', cleanup);
  bg.addEventListener('click', e => { if (e.target === bg) cleanup(); });

  const initCropper = () => {
    const img = bg.querySelector('#m-crop-img');
    _cropper = new Cropper(img, {
      aspectRatio: aspectRatio,       // 1 = square, 4/3 = landscape, NaN = free-form
      viewMode: 1,            // restrict crop box to canvas
      dragMode: 'move',
      autoCropArea: 0.8,
      background: false,
      responsive: true,
      modal: true,
      guides: true,
      center: true,
      highlight: true,
      cropBoxResizable: true,
      cropBoxMovable: true,
      toggleDragModeOnDblclick: false,
      minCropBoxWidth: 50,
      minCropBoxHeight: 50,
    });
    bg.querySelector('#m-crop-zoom-in').addEventListener('click', () => _cropper.zoom(0.15));
    bg.querySelector('#m-crop-zoom-out').addEventListener('click', () => _cropper.zoom(-0.15));
    bg.querySelector('#m-crop-reset').addEventListener('click', () => _cropper.reset());
  };

  // wait for image to load
  const img = bg.querySelector('#m-crop-img');
  if (img.complete && img.naturalWidth > 0) initCropper();
  else img.addEventListener('load', initCropper);
  img.addEventListener('error', () => {
    const err = bg.querySelector('#m-crop-err');
    err.textContent = '❌ โหลดภาพไม่สำเร็จ — อาจเป็นเพราะ CORS (โดเมน image search ไม่ allow). ลองอัพโหลดไฟล์โดยตรง';
    err.style.display = '';
  });

  bg.querySelector('#m-crop-save').addEventListener('click', () => {
    if (!_cropper) return;
    try {
      const canvas = _cropper.getCroppedCanvas({
        width: outputWidth, height: outputHeight,
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      });
      const dataUrl = (outputType === 'image/jpeg' || outputType === 'image/webp')
        ? canvas.toDataURL(outputType, outputQuality)
        : canvas.toDataURL(outputType);
      onSave(dataUrl);
      cleanup();
    } catch (e) {
      const err = bg.querySelector('#m-crop-err');
      err.textContent = '❌ Crop ไม่สำเร็จ: ' + e.message;
      err.style.display = '';
    }
  });
}

// v1.9.142 — ย่อรูป (center-square crop) เป็น data URL ขนาดเล็ก กันรูปใหญ่เกิน max_length ตอนเซฟ avatar
function _squareDownscaleDataUrl(dataUrl, size = 256, type = 'image/jpeg', quality = 0.9) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const s = Math.min(img.naturalWidth, img.naturalHeight) || 1;
        const sx = (img.naturalWidth - s) / 2, sy = (img.naturalHeight - s) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        resolve(canvas.toDataURL(type, quality));
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('โหลดรูปไม่สำเร็จ'));
    img.src = dataUrl;
  });
}

// === Logo search modal — fetch suggestions and let user pick ===
// === Camera modal — ถ่ายรูปจากกล้อง → crop modal ===
function openCameraModal(onSave, cropOpts) {
  // cropOpts: ส่งต่อให้ openCropModal (เช่น aspectRatio, outputType, outputWidth/Height)
  // v1.9.81 — cropOpts.skipCrop = true → bypass crop, save JPEG q=0.95 ตรง ๆ (สำหรับเอกสารที่ไม่ต้องการ crop)
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.style.zIndex = '1100';
  bg.innerHTML = `
    <div class="modal modal-wide">
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:700">📸 ถ่ายรูปจากกล้อง</h3>
      <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px">
        Browser อาจขอสิทธิ์เข้าถึงกล้อง — กด Allow
      </div>
      <div id="cam-status" style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">⏳ เปิดกล้อง...</div>
      <video id="cam-video" autoplay playsinline muted style="display:none;width:100%;max-height:420px;background:#0f172a;border-radius:10px;object-fit:cover"></video>
      <canvas id="cam-canvas" style="display:none"></canvas>
      <div style="display:flex;gap:8px;margin-top:14px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="cam-flip" type="button" style="font-size:13px;padding:7px 14px;display:none">🔄 สลับกล้อง</button>
        <div style="flex:1"></div>
        <button class="btn" id="cam-cancel" type="button" style="font-size:13px;padding:7px 14px">ยกเลิก</button>
        <button class="btn primary" id="cam-snap" type="button" style="font-size:13px;padding:7px 18px;display:none">📸 ถ่ายรูป</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);

  let stream = null;
  let facingMode = 'user';   // 'user' = หน้า, 'environment' = หลัง

  const cleanup = () => {
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; }
    bg.remove();
  };
  bg.querySelector('#cam-cancel').addEventListener('click', cleanup);
  bg.addEventListener('click', e => { if (e.target === bg) cleanup(); });

  const video = bg.querySelector('#cam-video');
  const status = bg.querySelector('#cam-status');
  const snapBtn = bg.querySelector('#cam-snap');
  const flipBtn = bg.querySelector('#cam-flip');

  const startCamera = async () => {
    status.textContent = '⏳ เปิดกล้อง...';
    status.style.color = 'var(--text-muted)';
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch {} stream = null; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status.textContent = '❌ Browser นี้ไม่รองรับกล้อง — ลอง Chrome/Edge หรือ HTTPS';
      status.style.color = 'var(--critical)';
      return;
    }
    try {
      // v1.9.81 — ถ้า skipCrop = true (โหมดเอกสาร) → ขอ resolution สูงสุดที่กล้องรองรับ
      const ideal = (cropOpts && cropOpts.skipCrop) ? 2560 : 1280;
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal }, height: { ideal } },
        audio: false,
      });
      video.srcObject = stream;
      status.style.display = 'none';
      video.style.display = 'block';
      snapBtn.style.display = '';
      // ตรวจว่ามีหลายกล้อง → แสดงปุ่ม flip
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter(d => d.kind === 'videoinput');
        if (cams.length > 1) flipBtn.style.display = '';
      } catch {}
    } catch (e) {
      status.textContent = '❌ เปิดกล้องไม่สำเร็จ: ' + (e.message || e.name) + '\n(ตรวจ permissions ในเบราว์เซอร์ + ต้องใช้ HTTPS)';
      status.style.color = 'var(--critical)';
      status.style.whiteSpace = 'pre-wrap';
    }
  };

  flipBtn.addEventListener('click', () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    startCamera();
  });

  snapBtn.addEventListener('click', () => {
    if (!stream) return;
    const canvas = bg.querySelector('#cam-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    // mirror image ถ้าเป็นกล้องหน้า (เหมือนที่ user เห็น)
    if (facingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0);
    // v1.9.81 — skipCrop = save JPEG q=0.95 ตรง ๆ ; default = PNG → openCropModal
    if (cropOpts && cropOpts.skipCrop) {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
      cleanup();
      onSave(dataUrl);
    } else {
      const dataUrl = canvas.toDataURL('image/png');
      cleanup();
      openCropModal(dataUrl, onSave, cropOpts);
    }
  });

  startCamera();
}

function openLogoSearchModal(domain, onSave) {
  // onSave: callback ที่ส่งต่อให้ openCropModal — ถ้าไม่กำหนด ใช้ default (form)
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.style.zIndex = '1100';
  bg.innerHTML = `
    <div class="modal" style="width:560px;max-width:92vw">
      <h3 style="margin:0 0 8px;font-size:17px;font-weight:700">🔍 ค้นหาโลโก้</h3>
      <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px">
        ระบบดึงโลโก้จาก public sources — คลิกที่ภาพที่ใช่ แล้วจะไปหน้า crop
      </div>
      <div class="field" style="margin-bottom:12px">
        <label>โดเมนที่จะค้น</label>
        <input id="m-logo-domain" type="text" value="${escapeHtml(domain)}" placeholder="freepik.com" />
      </div>
      <button class="btn primary" id="m-logo-search-go" type="button" style="font-size:13px;padding:7px 14px;margin-bottom:14px">🔍 ค้นหา</button>
      <div id="m-logo-results" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(110px, 1fr));gap:10px;min-height:120px"></div>
      <div style="text-align:right;margin-top:14px">
        <button class="btn" id="m-logo-cancel" type="button" style="font-size:13px;padding:7px 14px">ยกเลิก</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#m-logo-cancel').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  const doSearch = async () => {
    const d = bg.querySelector('#m-logo-domain').value.trim();
    const results = bg.querySelector('#m-logo-results');
    if (!d) { results.innerHTML = '<div class="empty" style="grid-column:1/-1">กรอก domain</div>'; return; }
    results.innerHTML = '<div class="empty" style="grid-column:1/-1">กำลังค้นหา…</div>';
    let data;
    try {
      data = await fetchJson('/api/admin/site-logo-suggestions?domain=' + encodeURIComponent(d));
    } catch (e) {
      results.innerHTML = `<div class="empty" style="grid-column:1/-1;color:var(--critical)">ผิดพลาด: ${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!data.suggestions || data.suggestions.length === 0) {
      results.innerHTML = '<div class="empty" style="grid-column:1/-1">ไม่เจอ suggestion</div>';
      return;
    }
    results.innerHTML = data.suggestions.map((s, i) => `
      <div class="m-logo-thumb" data-url="${escapeHtml(s.url)}" data-name="${escapeHtml(s.name)}"
           style="aspect-ratio:1;border:1.5px solid var(--border);border-radius:10px;background:var(--bg-soft);cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px;transition:all .15s;overflow:hidden;position:relative">
        <img src="${escapeHtml(s.url)}" alt="${escapeHtml(s.name)}" referrerpolicy="no-referrer"
             style="max-width:100%;max-height:70%;object-fit:contain"
             onerror="this.parentElement.style.display='none'" />
        <div style="font-size:9.5px;color:var(--text-muted);text-align:center;margin-top:4px;line-height:1.2">${escapeHtml(s.name)}</div>
      </div>
    `).join('');
    // wire click on thumbs
    results.querySelectorAll('.m-logo-thumb').forEach(thumb => {
      thumb.addEventListener('mouseenter', () => { thumb.style.borderColor = 'var(--primary)'; thumb.style.background = 'var(--primary-soft)'; });
      thumb.addEventListener('mouseleave', () => { thumb.style.borderColor = 'var(--border)'; thumb.style.background = 'var(--bg-soft)'; });
      thumb.addEventListener('click', async () => {
        const url = thumb.dataset.url;
        // Show loading state
        const orig = thumb.innerHTML;
        thumb.style.pointerEvents = 'none';
        thumb.style.opacity = '0.5';
        thumb.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center">⏳ กำลังโหลด...</div>';
        // Use backend proxy to fetch image — bypass CORS
        try {
          const resp = await fetchJson('/api/admin/proxy-image?url=' + encodeURIComponent(url));
          close();
          openCropModal(resp.data_url, onSave);
        } catch (e) {
          thumb.style.pointerEvents = '';
          thumb.style.opacity = '';
          thumb.innerHTML = orig;
          alert('โหลดภาพไม่สำเร็จ: ' + e.message + '\nลอง suggestion อื่น หรือดาวน์โหลดภาพแล้วอัพโหลดเอง');
        }
      });
    });
  };

  bg.querySelector('#m-logo-search-go').addEventListener('click', doSearch);
  // auto-search ทันทีถ้ามี domain
  if (domain) doSearch();
}

function showAddSiteModal() {
  showModal({
    title: 'เพิ่มเว็บใหม่',
    body: siteFormHTML(null),
    onSubmit: async () => {
      const data = siteFormCollect();
      if (!data.name || !data.url_pattern) throw new Error('กรอกชื่อและ URL pattern');
      await fetchJson('/api/admin/sites', { method: 'POST', body: JSON.stringify(data) });
      _cardOwnersCache = null;  // invalidate cache (อาจมี owner ใหม่)
      await loadSites();
    },
  });
  setTimeout(bindSiteFormDynamic, 0);
}

let _currentSite = null;

async function renderSiteDetail(siteId) {
  _subMain().innerHTML = `
    <div class="crumb"><a href="#/sites">← Websites</a></div>

    <!-- Inline-editable site header (Notion style) -->
    <div id="site-header" style="display:flex;gap:18px;align-items:flex-start;margin-bottom:14px;padding:18px 20px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-sm)">
      <!-- Logo + actions -->
      <div style="position:relative;flex-shrink:0">
        <div id="sd-logo" style="width:80px;height:80px;border-radius:14px;border:1.5px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;transition:border-color .15s"
             title="คลิกเพื่อเปลี่ยนโลโก้">
          <span style="color:var(--text-muted);font-size:11px">โลโก้</span>
        </div>
        <div id="sd-logo-actions" style="position:absolute;top:84px;left:0;display:none;gap:4px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,.08);z-index:10">
          <button class="btn" id="sd-logo-upload" title="อัพโหลดไฟล์" style="font-size:11px;padding:5px 8px;line-height:1">📷</button>
          <button class="btn" id="sd-logo-search" title="ค้นหาจาก domain" style="font-size:11px;padding:5px 8px;line-height:1">🔍</button>
          <button class="btn danger" id="sd-logo-remove" title="ลบโลโก้" style="font-size:11px;padding:5px 8px;line-height:1;display:none">🗑</button>
        </div>
        <input type="file" id="sd-logo-file" accept="image/*" style="display:none" />
      </div>

      <!-- Inline-editable text fields -->
      <div style="flex:1;min-width:0;overflow:hidden">
        <div style="font-size:10.5px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">ชื่อเว็บ</div>
        <h2 id="sd-name" class="inline-edit"
            contenteditable="true" spellcheck="false"
            data-empty-msg="ใส่ชื่อเว็บ..."
            style="margin:0 0 12px;font-size:24px;font-weight:700;letter-spacing:-0.01em;line-height:1.25;outline:none;border-radius:6px;padding:2px 6px;margin-left:-6px;transition:background .12s;min-height:1.4em">…</h2>

        <div style="font-size:10.5px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">URL pattern</div>
        <code id="sd-url" class="inline-edit"
              contenteditable="true" spellcheck="false"
              data-empty-msg="ใส่ URL pattern..."
              style="display:inline-block;min-width:220px;font-size:13px;padding:4px 8px;background:var(--bg-soft);border-radius:6px;outline:none;line-height:1.5;transition:background .12s;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">…</code>
      </div>

      <!-- v1.9.303 — รูป screenshot/อ้างอิง (อัพโหลด + กด preview) -->
      <div style="flex-shrink:0;display:flex;flex-direction:column;gap:5px;align-items:center">
        <div id="sd-image" title="อัพโหลด / กดดูรูป" style="width:128px;height:84px;border-radius:10px;border:1.5px dashed var(--border);background:var(--bg-soft);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:pointer;transition:border-color .15s">
          <span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.5">📷<br>อัพโหลดรูป</span>
        </div>
        <div id="sd-image-actions" style="display:none;gap:5px">
          <button class="btn" id="sd-image-replace" title="เปลี่ยนรูป" style="font-size:10.5px;padding:3px 8px;line-height:1">📷 เปลี่ยน</button>
          <button class="btn danger" id="sd-image-remove" title="ลบรูป" style="font-size:10.5px;padding:3px 8px;line-height:1">🗑</button>
        </div>
        <input type="file" id="sd-image-file" accept="image/*" style="display:none" />
      </div>

      <!-- Action buttons (top right) -->
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        <button class="btn primary" id="add-cred-btn" style="font-size:12.5px;padding:7px 12px;white-space:nowrap">+ เพิ่ม Credential</button>
        <button class="btn danger" id="delete-site-btn" style="font-size:12.5px;padding:7px 12px;white-space:nowrap">🗑 ลบเว็บ</button>
      </div>
    </div>

    <!-- v1.9.304 — หมายเหตุระดับ platform (กด edit ได้ + ปุ่ม ✓ บันทึก) -->
    <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px">
      <span style="font-size:14px;flex-shrink:0;margin-top:6px">📝</span>
      <textarea id="sd-note" rows="1" placeholder="หมายเหตุเกี่ยวกับ platform นี้ (วิธี login / ข้อควรระวัง / ฯลฯ) — กด ✓ เพื่อบันทึก"
        style="flex:1;min-width:0;resize:none;border:1px solid transparent;border-radius:8px;background:transparent;padding:6px 8px;font-family:inherit;font-size:13px;color:var(--text);line-height:1.55;outline:none;transition:border-color .12s,background .12s;box-sizing:border-box"></textarea>
      <button type="button" id="sd-note-save" title="บันทึกหมายเหตุ (⌘/Ctrl + Enter)" style="flex-shrink:0;width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--bg-soft);color:var(--text-muted);cursor:pointer;font-size:15px;font-family:inherit;margin-top:2px">✓</button>
    </div>

    <div class="warning-box">
      ⚠️ <strong>หมายเหตุ:</strong> Password ถูกเก็บแบบ plaintext ใน SQLite (จำเป็นเพื่อ prefill) —
      ใครเข้าถึงไฟล์ DB ในเครื่องนี้ก็เห็นได้ทั้งหมด
    </div>

    <h3 style="margin-top:22px;font-size:14px;color:var(--text-muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Credentials</h3>
    <div id="creds-list"></div>
  `;
  await loadSite(siteId);

  $('add-cred-btn').addEventListener('click', () => showAddCredModal(siteId));
  $('delete-site-btn').addEventListener('click', async () => {
    if (!confirm('ลบเว็บนี้และ credentials ทั้งหมด?')) return;
    await fetchJson('/api/admin/sites/' + siteId, { method: 'DELETE' });
    location.hash = '#/sites';
  });

  // === Inline edit wiring ===
  wireInlineEdit($('sd-name'), 'name', siteId);
  wireInlineEdit($('sd-url'), 'url_pattern', siteId);

  // === Logo wiring ===
  wireSiteLogoActions(siteId);
  // === v1.9.303 — รูป screenshot wiring ===
  _wireSiteImage(siteId);
  // === v1.9.304 — หมายเหตุ platform ===
  _wireSiteNote(siteId);
}

// v1.9.304 — หมายเหตุระดับ platform: edit + ปุ่ม ✓ save
function _sdNoteGrow() {
  const ta = $('sd-note'); if (!ta) return;
  ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}
function _wireSiteNote(siteId) {
  const ta = $('sd-note'), btn = $('sd-note-save');
  if (!ta || !btn) return;
  ta.addEventListener('input', () => { _sdNoteGrow(); btn.style.borderColor = 'var(--primary)'; btn.style.color = 'var(--primary)'; });
  ta.addEventListener('focus', () => { ta.style.borderColor = 'var(--border)'; ta.style.background = 'var(--bg-soft)'; });
  ta.addEventListener('blur', () => { ta.style.borderColor = 'transparent'; ta.style.background = 'transparent'; });
  const save = async () => {
    const v = ta.value.trim();
    btn.disabled = true; btn.textContent = '…';
    try {
      await fetchJson('/api/admin/sites/' + siteId, { method: 'PATCH', body: JSON.stringify({ note: v }) });
      if (_currentSite) _currentSite.note = v || null;
      btn.style.borderColor = 'var(--green)'; btn.style.color = 'var(--green)';
      if (typeof showSavedToast === 'function') showSavedToast('✓ บันทึกหมายเหตุแล้ว');
      setTimeout(() => { btn.style.borderColor = 'var(--border)'; btn.style.color = 'var(--text-muted)'; }, 1200);
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + (e.message || e)); }
    btn.textContent = '✓'; btn.disabled = false;
  };
  btn.addEventListener('click', save);
  ta.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
}

// v1.9.303 — lightbox preview รูป (เต็มจอ คลิกปิด) — reusable
function _showImageLightbox(src) {
  if (!src) return;
  const bg = document.createElement('div');
  bg.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out;padding:30px';
  bg.innerHTML = `<img src="${src}" alt="preview" style="max-width:96%;max-height:96%;object-fit:contain;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,.5)" />`;
  bg.addEventListener('click', () => bg.remove());
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { bg.remove(); document.removeEventListener('keydown', esc); } });
  document.body.appendChild(bg);
}
function _updateSdImage(src) {
  const box = $('sd-image'), actions = $('sd-image-actions');
  if (!box) return;
  if (src) {
    box.innerHTML = `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover;display:block" />`;
    box.style.borderStyle = 'solid';
    if (actions) actions.style.display = 'flex';
  } else {
    box.innerHTML = '<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.5">📷<br>อัพโหลดรูป</span>';
    box.style.borderStyle = 'dashed';
    if (actions) actions.style.display = 'none';
  }
}
async function _setSiteImage(siteId, dataUrl) {
  try { await fetchJson('/api/admin/sites/' + siteId, { method: 'PATCH', body: JSON.stringify({ image_data: dataUrl }) }); }
  catch (e) { alert('บันทึกรูปไม่สำเร็จ: ' + (e.message || e)); return; }
  if (_currentSite) _currentSite.image_data = dataUrl || null;
  _updateSdImage(dataUrl);
}
function _wireSiteImage(siteId) {
  const box = $('sd-image'), fileInp = $('sd-image-file');
  if (!box || !fileInp) return;
  box.addEventListener('click', () => {
    const img = box.querySelector('img');
    if (img) _showImageLightbox(img.src); else fileInp.click();
  });
  const rep = $('sd-image-replace'); if (rep) rep.addEventListener('click', (e) => { e.stopPropagation(); fileInp.click(); });
  const rm = $('sd-image-remove'); if (rm) rm.addEventListener('click', async (e) => { e.stopPropagation(); if (confirm('ลบรูปนี้?')) await _setSiteImage(siteId, ''); });
  fileInp.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    fileInp.value = '';
    try {
      const dataUrl = await compressImageToJpeg(f, 2000, 0.9);   // ย่อก่อนเก็บ
      await _setSiteImage(siteId, dataUrl);
    } catch (err) { alert('อ่านรูปไม่สำเร็จ: ' + (err.message || err)); }
  });
}

// === Inline editable field helper ===
// On blur or Enter → PATCH ฟิลด์ของ site, แสดง toast
function wireInlineEdit(el, field, siteId) {
  if (!el) return;
  const saveAndShow = async () => {
    const val = el.textContent.trim();
    const original = el.dataset.original || '';
    if (val === original) return;
    if (!val) {
      el.textContent = original;
      showSavedToast('⚠ ห้ามเว้นว่าง', 'warning');
      return;
    }
    try {
      await fetchJson('/api/admin/sites/' + siteId, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: val }),
      });
      el.dataset.original = val;
      showSavedToast('✓ บันทึกแล้ว');
    } catch (e) {
      el.textContent = original;
      showSavedToast('❌ ' + e.message, 'error');
    }
  };
  el.addEventListener('blur', saveAndShow);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      el.textContent = el.dataset.original || '';
      el.blur();
    }
  });
  el.addEventListener('focus', () => { el.style.background = 'var(--primary-soft)'; });
  el.addEventListener('blur', () => { el.style.background = ''; });
}

// === Site logo actions (inline on site detail page) ===
function wireSiteLogoActions(siteId) {
  const logoBox = $('sd-logo');
  const actionsBox = $('sd-logo-actions');
  const fileInput = $('sd-logo-file');

  // toggle action menu on logo click
  logoBox.addEventListener('click', () => {
    actionsBox.style.display = actionsBox.style.display === 'flex' ? 'none' : 'flex';
  });
  // close menu on click outside
  document.addEventListener('click', (e) => {
    if (!logoBox.contains(e.target) && !actionsBox.contains(e.target)) {
      actionsBox.style.display = 'none';
    }
  });

  // Save callback — PATCH to backend + update logo preview
  const saveLogoToBackend = async (dataUrl) => {
    try {
      await fetchJson('/api/admin/sites/' + siteId, {
        method: 'PATCH',
        body: JSON.stringify({ logo_data: dataUrl }),   // empty string = clear
      });
      updateSdLogoPreview(dataUrl);
      showSavedToast(dataUrl ? '✓ บันทึกโลโก้แล้ว' : '✓ ลบโลโก้แล้ว');
    } catch (e) {
      showSavedToast('❌ ' + e.message, 'error');
    }
  };

  $('sd-logo-upload').addEventListener('click', (e) => {
    e.stopPropagation();
    actionsBox.style.display = 'none';
    fileInput.click();
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => openCropModal(ev.target.result, saveLogoToBackend);
    reader.readAsDataURL(file);
    fileInput.value = '';
  });

  $('sd-logo-search').addEventListener('click', (e) => {
    e.stopPropagation();
    actionsBox.style.display = 'none';
    const pattern = (_currentSite && _currentSite.url_pattern) || '';
    if (!pattern) { alert('ใส่ URL pattern ก่อน'); return; }
    openLogoSearchModal(pattern, saveLogoToBackend);
  });

  $('sd-logo-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    actionsBox.style.display = 'none';
    if (!confirm('ลบโลโก้ของเว็บนี้?')) return;
    saveLogoToBackend('');
  });
}

function updateSdLogoPreview(dataUrl) {
  const logoBox = $('sd-logo');
  const removeBtn = $('sd-logo-remove');
  if (!logoBox) return;
  if (dataUrl) {
    logoBox.style.background = '#fff';
    logoBox.style.borderStyle = 'solid';
    logoBox.innerHTML = `<img src="${dataUrl}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`;
    if (removeBtn) removeBtn.style.display = '';
  } else {
    logoBox.style.background = 'var(--bg-soft)';
    logoBox.style.borderStyle = 'dashed';
    logoBox.innerHTML = '<span style="color:var(--text-muted);font-size:11px">+ โลโก้</span>';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

// === Toast helper for inline-edit feedback ===
let _savedToastTimer = null;
function showSavedToast(message, kind) {
  // kind: undefined (success/green) | 'warning' (orange) | 'error' (red)
  let toast = document.getElementById('saved-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'saved-toast';
    toast.style.cssText = `
      position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(20px);
      padding: 10px 18px; border-radius: 999px;
      font-family: inherit; font-size: 13px; font-weight: 600;
      background: var(--ok); color: #fff;
      box-shadow: 0 6px 20px rgba(0,0,0,.18);
      z-index: 1200;
      opacity: 0; transition: opacity .25s, transform .25s;
      pointer-events: none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = kind === 'error' ? 'var(--critical)'
                          : kind === 'warning' ? 'var(--warning)' : 'var(--ok)';
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  if (_savedToastTimer) clearTimeout(_savedToastTimer);
  _savedToastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 1800);
}

function fmtPaymentTypeTh(v) {
  return PAYMENT_TYPE_LABELS[v] || (v || '—');
}

// === Billing fields HTML — ใช้ใน credential add/edit modal ===
// (ฟิลด์เหล่านี้ย้ายมาจาก site form ใน v1.10)
// ใช้ field-grid-2 = 2-column layout (responsive: 1 col บน mobile)
function billingFieldsHTML(obj) {
  const o = obj || {};
  const paymentOptions = Object.entries(PAYMENT_TYPE_LABELS).map(
    ([v, label]) => `<option value="${v}" ${o.payment_type === v ? 'selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');
  return `
    <div class="field-section-label">ข้อมูลการเงิน (ของ credential นี้)</div>

    <!-- Row 1: รอบการจ่าย (dropdown) | Renew วันที่ -->
    <div class="field">
      <label>รอบการจ่าย</label>
      <select id="m-billing-cycle" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
        <option value="" ${!o.billing_cycle ? 'selected' : ''}>— ไม่ระบุ —</option>
        <option value="monthly" ${o.billing_cycle === 'monthly' ? 'selected' : ''}>📅 รายเดือน</option>
        <option value="yearly" ${o.billing_cycle === 'yearly' ? 'selected' : ''}>🗓️ รายปี</option>
      </select>
    </div>
    <div class="field" id="m-renew-wrap" style="${o.billing_cycle === 'monthly' ? '' : 'display:none'}">
      <label>Renew วันที่ของเดือน (1-31)</label>
      <input id="m-renew" type="number" min="1" max="31" value="${o.renew_day != null ? o.renew_day : ''}" placeholder="เช่น 5" />
    </div>

    <!-- Row 2: ค่าใช้จ่าย | สกุลเงิน | ประเภทการจ่าย (3 cols on one line) -->
    <div class="field-span-2" style="display:grid;grid-template-columns:1.6fr 1fr 1.4fr;gap:14px">
      <div class="field" style="margin-bottom:0">
        <label>ค่าใช้จ่าย (ต่อรอบ)</label>
        <input id="m-cost" type="number" min="0" step="0.01" value="${o.cost_amount != null ? o.cost_amount : ''}" placeholder="เช่น 590.00" />
      </div>
      <div class="field" style="margin-bottom:0">
        <label>สกุลเงิน</label>
        <select id="m-currency" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          ${['THB','USD','EUR','GBP','JPY','CNY'].map(c =>
            `<option value="${c}" ${(o.cost_currency || 'THB') === c ? 'selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>ประเภทการจ่าย</label>
        <select id="m-payment" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          <option value="">— เลือก —</option>
          ${paymentOptions}
        </select>
      </div>
    </div>

    <!-- Row 3: วันเริ่ม | วันสิ้นสุด (already same line via field-grid-2) -->
    <div class="field">
      <label>วันเริ่มต้น</label>
      <input id="m-start-date" type="date" value="${escapeHtml((o.start_date || '').slice(0, 10))}" />
    </div>
    <div class="field">
      <label>วันสิ้นสุด <span style="color:var(--text-muted);font-weight:400">(ถ้ามี)</span></label>
      <input id="m-end-date" type="date" value="${escapeHtml((o.end_date || '').slice(0, 10))}" />
    </div>

    <div class="field field-span-2">
      <label>ใช้บัตรของ (พิมพ์ใหม่ได้ ระบบจะเพิ่มให้)</label>
      <input id="m-card-owner" type="text" list="card-owners-list" value="${escapeHtml(o.card_owner_name || '')}" placeholder="เช่น Anan, Tao, สมชาย" />
      <datalist id="card-owners-list"></datalist>
    </div>

    <div class="field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px">
        <input id="m-cancelled" type="checkbox" ${o.cancelled ? 'checked' : ''}>
        <span>ยกเลิกแล้ว</span>
      </label>
    </div>
    <div class="field" id="m-cancelled-at-wrap" style="${o.cancelled ? '' : 'display:none'}">
      <label>ยกเลิกเมื่อวันที่</label>
      <input id="m-cancelled-at" type="date" value="${escapeHtml((o.cancelled_at || '').slice(0, 10))}" />
    </div>

    <div class="field field-span-2">
      <label>เหตุผลในการใช้งาน</label>
      <textarea id="m-reason" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical">${escapeHtml(o.usage_reason || '')}</textarea>
    </div>
  `;
}

function billingFieldsCollect() {
  const billingCycle = $('m-billing-cycle') ? ($('m-billing-cycle').value || '') : '';
  return {
    renew_day: ($('m-renew') && $('m-renew').value) ? parseInt($('m-renew').value, 10) : null,
    card_owner: $('m-card-owner') ? ($('m-card-owner').value.trim() || null) : null,
    payment_type: $('m-payment') ? ($('m-payment').value || null) : null,
    cancelled: $('m-cancelled') ? $('m-cancelled').checked : false,
    cancelled_at: ($('m-cancelled') && $('m-cancelled').checked) ? ($('m-cancelled-at').value || null) : null,
    usage_reason: $('m-reason') ? ($('m-reason').value.trim() || null) : null,
    billing_cycle: billingCycle,
    cost_amount: ($('m-cost') && $('m-cost').value !== '') ? parseFloat($('m-cost').value) : null,
    cost_currency: $('m-currency') ? ($('m-currency').value || 'THB') : 'THB',
    start_date: $('m-start-date') ? ($('m-start-date').value || null) : null,
    end_date: $('m-end-date') ? ($('m-end-date').value || null) : null,
  };
}

async function bindBillingFieldsDynamic() {
  // populate card-owners datalist
  const owners = await getCardOwners();
  const list = document.getElementById('card-owners-list');
  if (list) list.innerHTML = owners.map(o => `<option value="${escapeHtml(o.name)}">`).join('');

  // toggle cancelled-at visibility
  const cb = $('m-cancelled');
  const wrap = $('m-cancelled-at-wrap');
  if (cb && wrap) {
    cb.addEventListener('change', () => { wrap.style.display = cb.checked ? '' : 'none'; });
  }

  // toggle Renew วันที่ visibility ตาม billing_cycle (dropdown)
  const bc = $('m-billing-cycle');
  if (bc) {
    bc.addEventListener('change', () => {
      const renewWrap = $('m-renew-wrap');
      if (renewWrap) {
        renewWrap.style.display = bc.value === 'monthly' ? '' : 'none';
      }
    });
  }
}

// (siteInfoCard ลบแล้ว — ใช้ inline-editable fields ใน renderSiteDetail แทน)

// แสดงสรุปข้อมูลการเงินของ credential แบบ chip ใต้แถว credential
// (เฉพาะข้อมูลที่กรอกแล้ว — ไม่กรอก = ไม่โชว์)
function credBillingSummary(c, compact) {
  const chips = [];
  // รอบบิล + cost
  if (c.billing_cycle === 'monthly') {
    const renewTxt = c.renew_day ? ` วันที่ ${c.renew_day}` : '';
    chips.push(`<span class="cred-chip">📅 รายเดือน${renewTxt}</span>`);
  } else if (c.billing_cycle === 'yearly') {
    chips.push(`<span class="cred-chip">🗓️ รายปี</span>`);
  } else if (c.renew_day) {
    chips.push(`<span class="cred-chip">📅 Renew วันที่ ${c.renew_day}</span>`);
  }
  if (c.cost_amount != null) {
    const cur = c.cost_currency || 'THB';
    const formatted = new Intl.NumberFormat('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.cost_amount);
    chips.push(`<span class="cred-chip">💵 ${formatted} ${escapeHtml(cur)}</span>`);
  }
  if (c.payment_type) {
    chips.push(`<span class="cred-chip">💳 ${escapeHtml(fmtPaymentTypeTh(c.payment_type))}</span>`);
  }
  if (c.card_owner_name) {
    chips.push(`<span class="cred-chip">👤 ${escapeHtml(c.card_owner_name)}</span>`);
  }
  if (c.start_date || c.end_date) {
    const fmt = (d) => d ? new Date(d).toLocaleDateString('th-TH', { year: '2-digit', month: 'short', day: 'numeric' }) : '?';
    const range = `${fmt(c.start_date)} → ${c.end_date ? fmt(c.end_date) : 'ต่อเนื่อง'}`;
    chips.push(`<span class="cred-chip">⏱ ${escapeHtml(range)}</span>`);
  }
  if (c.cancelled) {
    const at = c.cancelled_at ? new Date(c.cancelled_at).toLocaleDateString('th-TH') : '';
    chips.push(`<span class="cred-chip cred-chip-cancelled">⛔ ยกเลิก${at ? ' ' + escapeHtml(at) : ''}</span>`);
  }
  if (c.usage_reason) {
    chips.push(`<span class="cred-chip" title="${escapeHtml(c.usage_reason)}">📝 ${escapeHtml(c.usage_reason.slice(0, 40))}${c.usage_reason.length > 40 ? '…' : ''}</span>`);
  }
  if (chips.length === 0) return '';
  if (compact) return `<div style="display:flex;gap:5px;flex-wrap:wrap">${chips.join('')}</div>`;
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border);display:flex;gap:6px;flex-wrap:wrap">${chips.join('')}</div>`;
}

async function loadSite(siteId) {
  const { site, credentials } = await fetchJson('/api/admin/sites/' + siteId);
  _currentSite = site;
  // populate inline-editable fields
  const nameEl = $('sd-name');
  const urlEl = $('sd-url');
  if (nameEl) {
    nameEl.textContent = site.name;
    nameEl.dataset.original = site.name;
  }
  if (urlEl) {
    urlEl.textContent = site.url_pattern;
    urlEl.dataset.original = site.url_pattern;
  }
  // populate logo preview
  updateSdLogoPreview(site.logo_data || '');
  _updateSdImage(site.image_data || '');   // v1.9.303
  const noteTa = $('sd-note'); if (noteTa) { noteTa.value = site.note || ''; _sdNoteGrow(); }   // v1.9.304

  const list = $('creds-list');
  if (credentials.length === 0) {
    list.innerHTML = '<div class="empty">ยังไม่มี credential — กด <strong>+ เพิ่ม Credential</strong> ด้านบน</div>';
    return;
  }
  // v1.9.303 — ตารางเรียบ ๆ เหมือนหน้า domain (Services Config)
  list.innerHTML = `
    <div class="cfg-table-wrap"><div class="cfg-table-scroll">
    <table class="cfg-table">
      <thead><tr>
        <th>ชื่อ / Account</th><th>User</th><th>Password</th><th>ค่าใช้จ่าย / รอบบิล</th><th style="text-align:right">จัดการ</th>
      </tr></thead>
      <tbody>
      ${credentials.map(c => `
        <tr style="cursor:default">
          <td style="font-weight:700">${escapeHtml(c.label || '(ไม่มีชื่อ)')}${c.cancelled ? ' <span style="font-size:10px;color:var(--critical);font-weight:700">⛔</span>' : ''}</td>
          <td><span style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(c.username || '—')}</span>${c.username ? ` <button class="copy-btn" data-copy="${escapeHtml(c.username)}" title="คัดลอก">📋</button>` : ''}</td>
          <td style="white-space:nowrap"><span class="pw-mask" data-pw="${escapeHtml(c.password || '')}" data-shown="false" style="font-family:ui-monospace,Menlo,monospace">••••••••</span> <button class="copy-btn pw-toggle" title="show/hide">👁</button>${c.password ? ` <button class="copy-btn" data-copy="${escapeHtml(c.password)}" title="คัดลอก">📋</button>` : ''}</td>
          <td>${credBillingSummary(c, true) || '<span style="color:var(--text-muted)">—</span>'}</td>
          <td style="text-align:right;white-space:nowrap"><button type="button" class="kebab-btn" data-cred-kebab="${c.id}" title="เมนู">⋮</button></td>
        </tr>
      `).join('')}
      </tbody>
    </table>
    </div></div>`;

  list.querySelectorAll('button[data-cred-kebab]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cid = parseInt(b.dataset.credKebab, 10);
      const cred = credentials.find(x => x.id === cid);
      if (!cred) return;
      _kebabMenu(b, [
        { icon: '✏️', label: 'แก้ไข', onClick: () => showEditCredModal(cred, siteId) },
        { icon: '🗑', label: 'ลบ', danger: true, onClick: async () => {
            if (!confirm('ลบ credential นี้?')) return;
            await fetchJson('/api/admin/credentials/' + cid, { method: 'DELETE' });
            await loadSite(siteId);
          } },
      ]);
    });
  });

  list.querySelectorAll('.copy-btn[data-copy]').forEach(b => {
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy);
      const orig = b.textContent; b.textContent = '✓';
      setTimeout(() => { b.textContent = orig; }, 800);
    });
  });
  list.querySelectorAll('.pw-toggle').forEach(b => {
    b.addEventListener('click', () => {
      const span = b.parentElement.querySelector('.pw-mask');
      const shown = span.dataset.shown === 'true';
      if (shown) {
        span.textContent = '••••••••';
        span.classList.remove('pw-show'); span.classList.add('pw-mask');
        span.dataset.shown = 'false';
      } else {
        span.textContent = span.dataset.pw;
        span.classList.add('pw-show'); span.classList.remove('pw-mask');
        span.dataset.shown = 'true';
      }
    });
  });
  list.querySelectorAll('button[data-del]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('ลบ credential นี้?')) return;
      await fetchJson('/api/admin/credentials/' + b.dataset.del, { method: 'DELETE' });
      await loadSite(siteId);
    });
  });
  list.querySelectorAll('button[data-edit]').forEach(b => {
    b.addEventListener('click', () => {
      const cid = parseInt(b.dataset.edit, 10);
      const cred = credentials.find(x => x.id === cid);
      if (cred) showEditCredModal(cred, siteId);
    });
  });
}

function credFormHTML(cred) {
  const c = cred || {};
  const isEdit = !!c.id;
  return `
    <div class="field-grid-2">
      <div class="field-section-label">ข้อมูลบัญชี (Login credential)</div>

      <div class="field field-span-2">
        <label>ชื่อย่อ (ไม่บังคับ)</label>
        <input id="m-label" type="text" value="${escapeHtml(c.label || '')}" placeholder="เช่น account หลัก, สำรอง 1" />
      </div>
      <div class="field">
        <label>Username / Email</label>
        <input id="m-username" type="text" value="${escapeHtml(c.username || '')}" autocomplete="off" />
      </div>
      <div class="field">
        <label>Password</label>
        <div style="display:flex;gap:6px">
          <input id="m-password" type="password" value="${escapeHtml(c.password || '')}" autocomplete="off" style="flex:1" />
          <button type="button" class="btn" id="m-pw-toggle" style="white-space:nowrap;font-size:12px;padding:5px 10px">👁</button>
        </div>
      </div>

      ${billingFieldsHTML(c)}

      <div class="field-section-label">ใครเข้าถึง credential นี้ได้บ้าง</div>
      <div class="field field-span-2">
        <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px;line-height:1.5">
          เลือกได้ทั้ง <strong>ทีม</strong> (ทุกคนในทีมจะเห็น) และ/หรือ <strong>บุคคล</strong> (เฉพาะคนที่เลือก)
        </div>
        <div id="m-access-loading" style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;background:var(--bg-soft);border-radius:10px">
          ${isEdit ? '⏳ กำลังโหลดข้อมูล access...' : '💡 บันทึก credential ก่อน แล้วระบบจะเปิดให้ตั้ง access ได้'}
        </div>
        <div id="m-access-content" style="display:none">

          <!-- Section: ทีม -->
          <div style="margin-bottom:20px">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <span style="font-size:16px">🏷</span>
              <div style="font-size:14px;font-weight:600;color:var(--text)">อนุญาตให้ทีม</div>
              <span id="m-access-teams-count" style="font-size:11.5px;color:var(--text-muted);font-weight:500"></span>
            </div>
            <div id="m-access-teams" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;padding:2px"></div>
          </div>

          <!-- Section: Direct member grants -->
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <span style="font-size:16px">👤</span>
              <div style="font-size:14px;font-weight:600;color:var(--text)">อนุญาตเป็นรายบุคคล <span style="color:var(--text-muted);font-weight:400;font-size:12px">(direct grant)</span></div>
              <span id="m-access-members-count" style="font-size:11.5px;color:var(--text-muted);font-weight:500"></span>
            </div>
            <input type="text" id="m-access-member-search" placeholder="🔍 ค้นหา member (ชื่อ/email/เบอร์)..." autocomplete="off"
                   style="width:100%;padding:8px 12px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);margin-bottom:8px" />
            <div id="m-access-members" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto;padding:2px"></div>
          </div>

        </div>
      </div>
    </div>
  `;
}

function credFormCollect() {
  return {
    label: $('m-label').value.trim() || null,
    username: $('m-username').value.trim(),
    password: $('m-password').value,
    ...billingFieldsCollect(),
  };
}

async function bindCredFormDynamic() {
  // password show/hide toggle
  const tgl = document.getElementById('m-pw-toggle');
  const pw = document.getElementById('m-password');
  if (tgl && pw) {
    tgl.addEventListener('click', () => {
      if (pw.type === 'password') { pw.type = 'text'; tgl.textContent = '🙈 ซ่อน'; }
      else { pw.type = 'password'; tgl.textContent = '👁 แสดง'; }
    });
  }
  await bindBillingFieldsDynamic();
}

// === Credential access controls — load/render in modal ===
let _credAccessState = { team_ids: [], member_ids: [], auto_team_ids: [] };

async function loadCredAccessIntoModal(credId) {
  const loadingEl = document.getElementById('m-access-loading');
  const contentEl = document.getElementById('m-access-content');
  if (!loadingEl || !contentEl) return;

  if (!credId) {
    // ADD mode — แสดง message แต่ไม่โหลด
    loadingEl.innerHTML = '💡 บันทึก credential ก่อน แล้ว <strong>กดแก้ไข</strong> เพื่อตั้ง access';
    return;
  }

  try {
    const [accessData, teamsData, membersData] = await Promise.all([
      fetchJson(`/api/admin/credentials/${credId}/access`),
      fetchJson('/api/admin/teams'),
      fetchJson('/api/admin/members'),
    ]);

    const grantedTeamIds = new Set(accessData.teams.map(t => t.id));
    const autoTeamIds = new Set(accessData.auto_teams.map(t => t.id));
    const grantedMemberIds = new Set(accessData.members.map(m => m.id));

    _credAccessState.team_ids = Array.from(grantedTeamIds);
    _credAccessState.member_ids = Array.from(grantedMemberIds);
    _credAccessState.auto_team_ids = Array.from(autoTeamIds);

    // === Render TEAMS rows (full width, big & clear) ===
    const teamsList = teamsData.teams || [];
    document.getElementById('m-access-teams-count').textContent =
      teamsList.length === 0 ? '' : `(${teamsList.length} ทีม)`;
    const teamsHtml = teamsList.length === 0
      ? '<div class="empty" style="padding:18px;font-size:13px;background:var(--bg-soft);border-radius:8px">ยังไม่มี team — สร้างที่ <a href="#/teams" style="color:var(--primary)">หน้า Teams</a></div>'
      : teamsList.map(t => {
          const isAuto = autoTeamIds.has(t.id);
          const isChecked = grantedTeamIds.has(t.id);
          const isOn = isChecked || isAuto;
          const tooltip = isAuto ? 'ทีมนี้มี access_type=all สำหรับ site → เห็นทุก credential อัตโนมัติ' : '';
          const tInitial = (t.name || '?').trim().charAt(0).toUpperCase();
          return `
            <label class="m-access-row ${isOn ? 'm-access-on' : ''}"
                   ${tooltip ? `title="${escapeHtml(tooltip)}"` : ''}>
              <input type="checkbox" class="m-team-cb m-access-cb" value="${t.id}"
                     ${isOn ? 'checked' : ''}
                     ${isAuto ? 'disabled' : ''}>
              <div class="m-access-avatar" style="background:linear-gradient(135deg,#7c3aed,#2563eb)">${escapeHtml(tInitial)}</div>
              <div class="m-access-text">
                <div class="m-access-name">${escapeHtml(t.name)}${isAuto ? ' <span style="margin-left:6px;display:inline-block;padding:1px 7px;border-radius:6px;font-size:10.5px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">🟢 auto (all)</span>' : ''}</div>
                <div class="m-access-sub">${t.member_count} member · ${t.site_count} site${t.description ? ' · ' + escapeHtml(t.description) : ''}</div>
              </div>
            </label>
          `;
        }).join('');
    document.getElementById('m-access-teams').innerHTML = teamsHtml;

    // === Render MEMBERS rows ===
    const membersList = membersData.members || [];
    document.getElementById('m-access-members-count').textContent =
      membersList.length === 0 ? '' : `(${membersList.length} คน)`;
    const renderMember = (m) => {
      const isChecked = grantedMemberIds.has(m.id);
      const display = m.display_name || m.email || m.phone || '?';
      const initial = display.trim().charAt(0).toUpperCase();
      const subParts = [];
      if (m.email) subParts.push(m.email);
      if (m.phone && m.phone !== display) subParts.push(m.phone);
      const sub = subParts.join(' · ') || '—';
      const searchKey = (display + ' ' + (m.email || '') + ' ' + (m.phone || '')).toLowerCase();
      return `
        <label class="m-access-row ${isChecked ? 'm-access-on' : ''}" data-search="${escapeHtml(searchKey)}">
          <input type="checkbox" class="m-member-cb m-access-cb" value="${m.id}" ${isChecked ? 'checked' : ''}>
          <div class="m-access-avatar" style="background:linear-gradient(135deg,#2563eb,#7c3aed)">${escapeHtml(initial)}</div>
          <div class="m-access-text">
            <div class="m-access-name">${escapeHtml(display)}</div>
            <div class="m-access-sub">${escapeHtml(sub)}</div>
          </div>
        </label>
      `;
    };
    const membersHtml = membersList.length === 0
      ? '<div class="empty" style="padding:18px;font-size:13px;background:var(--bg-soft);border-radius:8px">ยังไม่มี member ในระบบ</div>'
      : membersList.map(renderMember).join('');
    document.getElementById('m-access-members').innerHTML = membersHtml;

    // Wire visual toggle for checkboxes
    document.querySelectorAll('.m-team-cb, .m-member-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const lbl = cb.closest('label');
        if (lbl) lbl.classList.toggle('m-access-on', cb.checked);
      });
    });

    // Wire member search filter
    const searchInput = document.getElementById('m-access-member-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase().trim();
        document.querySelectorAll('#m-access-members .m-access-row').forEach(row => {
          const key = row.dataset.search || '';
          row.style.display = (!q || key.includes(q)) ? '' : 'none';
        });
      });
    }

    loadingEl.style.display = 'none';
    contentEl.style.display = '';
  } catch (e) {
    loadingEl.innerHTML = `<span style="color:var(--critical)">⚠ โหลด access ไม่สำเร็จ: ${escapeHtml(e.message)}</span>`;
  }
}

function credAccessCollect() {
  // เก็บค่า — เฉพาะ checkbox ที่ user เปลี่ยนได้ (ไม่รวม disabled ของ auto-team)
  const team_ids = Array.from(document.querySelectorAll('.m-team-cb:not(:disabled):checked'))
    .map(cb => parseInt(cb.value, 10));
  const member_ids = Array.from(document.querySelectorAll('.m-member-cb:checked'))
    .map(cb => parseInt(cb.value, 10));
  return { team_ids, member_ids };
}

async function saveCredAccess(credId) {
  const access = credAccessCollect();
  await fetchJson(`/api/admin/credentials/${credId}/access`, {
    method: 'PUT',
    body: JSON.stringify(access),
  });
}

function showEditCredModal(cred, siteId) {
  showModal({
    title: 'แก้ไข Credential',
    size: 'wide',
    body: credFormHTML(cred),
    onSubmit: async () => {
      const data = credFormCollect();
      if (!data.username || !data.password) throw new Error('กรอก username และ password');
      // 1. PATCH credential fields
      await fetchJson('/api/admin/credentials/' + cred.id, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      // 2. PUT access (ทีม + บุคคล)
      try { await saveCredAccess(cred.id); } catch (e) {
        console.warn('saveCredAccess failed:', e);
      }
      _cardOwnersCache = null;
      await loadSite(siteId);
    },
  });
  setTimeout(async () => {
    await bindCredFormDynamic();
    await loadCredAccessIntoModal(cred.id);
  }, 0);
}

function showAddCredModal(siteId) {
  showModal({
    title: 'เพิ่ม Credential',
    size: 'wide',
    body: credFormHTML(null),
    onSubmit: async () => {
      const data = credFormCollect();
      if (!data.username || !data.password) throw new Error('กรอก username และ password');
      // ADD mode: access fields ยังไม่ active — user ต้องเปิดแก้ไขทีหลัง
      await fetchJson('/api/admin/sites/' + siteId + '/credentials', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      _cardOwnersCache = null;
      await loadSite(siteId);
    },
  });
  setTimeout(async () => {
    await bindCredFormDynamic();
    await loadCredAccessIntoModal(null);   // ADD = no cred yet
  }, 0);
}

