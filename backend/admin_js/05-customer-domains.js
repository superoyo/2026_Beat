// ============== Calendar (general) — domain + service expirations ==============
const _DAYS_TH = ['อา','จ','อ','พ','พฤ','ศ','ส'];
const _MONTHS_TH = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

// Cache: websites (domain + linked services) → ใช้สำหรับสร้าง events ในปฏิทิน
let _domainsCache = [];           // (legacy) — domains ตรง ๆ ไม่ผ่าน websites
let _websitesCache = [];          // websites endpoint — มี services ผูกอยู่
let _calMonth = 0;   // 0-11 — เดือนซ้ายสุดถ้า 3-month, หรือเดือนที่แสดงถ้า 1-month
let _calYear = 2026;
let _calView = '3month';   // '3month' | '1month'
let _calAnimating = false;
// วันที่ user คลิกใน calendar — null = ไม่เลือก (แสดงทั้ง view)
// รูปแบบ: { day, month, year } หรือ null
let _calSelectedDay = null;

async function renderDomainsPage() {
  // init calendar to current month
  const now = new Date();
  _calMonth = now.getMonth();
  _calYear = now.getFullYear();

  // reset selection on page enter
  _calSelectedDay = null;
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">📅 Calendar</h2>
      <span class="card-sub" id="d-count">—</span>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      ปฏิทินรวมวันหมดอายุ — Domain · Hosting · SSL · Others — คลิกวันใดวันหนึ่งเพื่อดูเฉพาะวันนั้น
    </div>

    <!-- Calendar -->
    <div class="card" style="display:block;margin-bottom:18px;padding:18px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px;flex-wrap:wrap">
        <button class="btn" id="cal-prev" style="font-size:13px;padding:6px 12px">← ก่อนหน้า</button>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center">
          <select id="cal-month" style="padding:7px 10px;font-size:13.5px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);font-weight:600">
            ${_MONTHS_TH.map((m, i) => `<option value="${i}">${m}</option>`).join('')}
          </select>
          <select id="cal-year" style="padding:7px 10px;font-size:13.5px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);font-weight:600"></select>
          <button class="btn" id="cal-today" style="font-size:11.5px;padding:6px 10px">วันนี้</button>
          <!-- View toggle -->
          <div style="display:inline-flex;background:var(--bg-soft);border:1px solid var(--border);border-radius:7px;padding:2px;margin-left:4px">
            <button id="cal-view-1" class="cal-view-btn" style="background:transparent;border:none;padding:5px 11px;font-size:12px;color:var(--text-muted);cursor:pointer;border-radius:5px;font-family:inherit">1 เดือน</button>
            <button id="cal-view-3" class="cal-view-btn" style="background:transparent;border:none;padding:5px 11px;font-size:12px;color:var(--text-muted);cursor:pointer;border-radius:5px;font-family:inherit">3 เดือน</button>
          </div>
        </div>
        <button class="btn" id="cal-next" style="font-size:13px;padding:6px 12px">ถัดไป →</button>
      </div>
      <div id="cal-viewport" style="overflow:hidden;position:relative">
        <div id="cal-grid" style="will-change:transform,opacity"></div>
      </div>
    </div>

    <!-- Detail panel — แสดงรายการที่หมดอายุ ตาม calendar view (1m/3m) หรือ day ที่คลิก -->
    <div id="d-list">
      <div class="empty">กำลังโหลด…</div>
    </div>
  `;

  // populate year dropdown
  const ySel = $('cal-year');
  const curY = now.getFullYear();
  for (let y = curY - 2; y <= curY + 5; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = (y + 543);   // พ.ศ.
    ySel.appendChild(opt);
  }
  $('cal-month').value = _calMonth;
  $('cal-year').value = _calYear;

  // helper: animate month change with slide
  const slideAndRender = (dir) => {
    if (_calAnimating) return;
    _calAnimating = true;
    // clear day selection เมื่อเปลี่ยนเดือน/view เพื่อให้ panel แสดง range ใหม่
    _calSelectedDay = null;
    const grid = $('cal-grid');
    const distance = 60;   // px
    const outX = dir === 0 ? 0 : (dir > 0 ? -distance : distance);
    const inFromX = dir === 0 ? 0 : (dir > 0 ? distance : -distance);
    grid.style.transition = 'transform .22s ease, opacity .22s ease';
    grid.style.transform = `translateX(${outX}px)`;
    grid.style.opacity = '0';
    setTimeout(() => {
      $('cal-month').value = _calMonth;
      $('cal-year').value = _calYear;
      // update content (no transition)
      grid.style.transition = 'none';
      grid.style.transform = `translateX(${inFromX}px)`;
      grid.style.opacity = '0';
      renderCalendar();
      // re-render detail panel ตาม view/range ใหม่ (เก็บ selection เดิมไว้)
      renderCalendarDetailPanel();
      // force reflow
      void grid.offsetHeight;
      // animate in
      grid.style.transition = 'transform .25s ease, opacity .25s ease';
      grid.style.transform = 'translateX(0)';
      grid.style.opacity = '1';
      setTimeout(() => { _calAnimating = false; }, 260);
    }, 230);
  };

  const stepMonth = (offset) => {
    _calMonth += offset;
    while (_calMonth < 0) { _calMonth += 12; _calYear--; }
    while (_calMonth > 11) { _calMonth -= 12; _calYear++; }
    slideAndRender(offset);
  };

  // wire calendar nav
  $('cal-prev').addEventListener('click', () => stepMonth(-1));
  $('cal-next').addEventListener('click', () => stepMonth(1));
  $('cal-today').addEventListener('click', () => {
    const t = new Date();
    const newM = t.getMonth(), newY = t.getFullYear();
    const dir = (newY > _calYear || (newY === _calYear && newM > _calMonth)) ? 1 : -1;
    _calMonth = newM; _calYear = newY;
    slideAndRender(dir);
  });
  $('cal-month').addEventListener('change', (e) => {
    const newM = parseInt(e.target.value, 10);
    const dir = newM > _calMonth ? 1 : -1;
    _calMonth = newM;
    slideAndRender(dir);
  });
  $('cal-year').addEventListener('change', (e) => {
    const newY = parseInt(e.target.value, 10);
    const dir = newY > _calYear ? 1 : -1;
    _calYear = newY;
    slideAndRender(dir);
  });

  // View toggle
  const setView = (view) => {
    if (_calView === view) return;
    _calView = view;
    updateViewToggle();
    slideAndRender(0);   // dir=0 → fade in place
  };
  $('cal-view-1').addEventListener('click', () => setView('1month'));
  $('cal-view-3').addEventListener('click', () => setView('3month'));
  updateViewToggle();

  await loadDomainsList();
}

function updateViewToggle() {
  const b1 = $('cal-view-1');
  const b3 = $('cal-view-3');
  if (!b1 || !b3) return;
  const active = (btn) => {
    btn.style.background = 'var(--bg-card)';
    btn.style.color = 'var(--primary)';
    btn.style.fontWeight = '700';
    btn.style.boxShadow = 'var(--shadow-sm)';
  };
  const inactive = (btn) => {
    btn.style.background = 'transparent';
    btn.style.color = 'var(--text-muted)';
    btn.style.fontWeight = '500';
    btn.style.boxShadow = 'none';
  };
  if (_calView === '1month') { active(b1); inactive(b3); }
  else { inactive(b1); active(b3); }
}

async function loadDomainsList() {
  // โหลดทั้ง domains (สำหรับ calendar legacy) + websites (มี services ผูกครบ)
  // /api/websites คืน { websites: [{domain, services, by_type, ...}] } — ใช้ field 'services'
  let websitesData;
  try {
    websitesData = await fetchJson('/api/websites');
  } catch (e) {
    $('d-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _websitesCache = websitesData.websites || [];
  // _domainsCache: array of domain objects (with logo etc.) — ใช้ใน renderMonthPanel เดิม
  _domainsCache = _websitesCache.map(w => w.domain);
  // นับ events ทั้งหมดใน calendar (domain register + expire + service expire)
  const totalEvents = _calCollectAllEvents().length;
  $('d-count').textContent = `${_websitesCache.length} domain · ${totalEvents} event`;
  renderCalendar();
  renderCalendarDetailPanel();
}

// Helper: รวม events ทั้งหมดจาก _websitesCache (domains + services)
// คืน array ของ event object: {date, domain, type, source_type, service?, label}
function _calCollectAllEvents() {
  const events = [];
  for (const w of _websitesCache) {
    const d = w.domain;
    if (d.register_date) {
      events.push({ date: d.register_date, domain: d, type: 'register', source_type: 'domain' });
    }
    if (d.expire_date) {
      events.push({ date: d.expire_date, domain: d, type: 'expire', source_type: 'domain' });
    }
    for (const s of (w.services || [])) {
      if (s.expire_date) {
        events.push({
          date: s.expire_date,
          domain: d,
          type: 'expire',
          source_type: s.service_type,   // 'hosting' | 'ssl' | 'others'
          service: s,
        });
      }
    }
  }
  return events;
}

// Color + label สำหรับแต่ละ source type — ใช้ทั้ง dots ใน calendar + chips ใน detail panel
const _CAL_SOURCE_META = {
  domain:   { color: '#2563eb', icon: '🌐', label: 'Domain' },
  hosting:  { color: '#0891b2', icon: '🖥️', label: 'Hosting' },
  ssl:      { color: '#7c3aed', icon: '🔒', label: 'SSL' },
  others:   { color: '#db2777', icon: '📦', label: 'Others' },
};

// คืน range [start, end] ของ calendar view ปัจจุบัน
function _calCurrentRange() {
  const start = new Date(_calYear, _calMonth, 1);
  start.setHours(0,0,0,0);
  const monthsToShow = (_calView === '3month') ? 3 : 1;
  const end = new Date(_calYear, _calMonth + monthsToShow, 0);   // last day ของ month สุดท้าย
  end.setHours(23,59,59,999);
  return { start, end };
}

// Detail panel — แสดง events ตาม selection state:
//   - _calSelectedDay = null → แสดง events ใน range ของ calendar view (1m/3m)
//   - _calSelectedDay = {day,month,year} → แสดง events เฉพาะวันนั้น
function renderCalendarDetailPanel() {
  const wrap = $('d-list');
  if (!wrap) return;
  if (_websitesCache.length === 0) {
    wrap.innerHTML = `<div class="empty">ยังไม่มี domain — ${currentRole === 'admin' ? 'เพิ่มได้ที่ <strong>🛠️ Services Config</strong> (Domain tab)' : 'แจ้ง admin ให้เพิ่ม'}</div>`;
    return;
  }

  const today = new Date(); today.setHours(0,0,0,0);
  const allEvents = _calCollectAllEvents();

  // Filter: select day OR view range
  let scope, scopeLabel;
  if (_calSelectedDay) {
    const sd = _calSelectedDay;
    scope = (e) => {
      const d = new Date(e.date);
      return !isNaN(d.getTime())
        && d.getDate() === sd.day && d.getMonth() === sd.month && d.getFullYear() === sd.year;
    };
    scopeLabel = `📅 ${sd.day} ${_MONTHS_TH[sd.month]} ${sd.year + 543}`;
  } else {
    const { start, end } = _calCurrentRange();
    scope = (e) => {
      const d = new Date(e.date);
      return !isNaN(d.getTime()) && d >= start && d <= end;
    };
    if (_calView === '1month') {
      scopeLabel = `📅 ${_MONTHS_TH[_calMonth]} ${_calYear + 543}`;
    } else {
      const lastM = (_calMonth + 2) % 12;
      const lastY = _calYear + (_calMonth + 2 >= 12 ? 1 : 0);
      scopeLabel = `📅 ${_MONTHS_TH[_calMonth]} ${_calYear + 543} – ${_MONTHS_TH[lastM]} ${lastY + 543}`;
    }
  }

  // เน้นเฉพาะ expire events (register แสดงด้วยถ้าเลือก single day)
  const filtered = allEvents.filter(e => {
    if (!scope(e)) return false;
    if (_calSelectedDay) return true;       // single day = แสดงทั้งหมด (register + expire)
    return e.type === 'expire';             // range view = เฉพาะ expire (โฟกัสที่หมดอายุ)
  });

  // Sort: by date asc, then domain name
  filtered.sort((a, b) => {
    const da = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (da !== 0) return da;
    return (a.domain.name || '').localeCompare(b.domain.name || '', 'th');
  });

  // Top header — scope label + clear-selection button
  const clearBtn = _calSelectedDay
    ? `<button class="btn" id="d-clear-day" style="font-size:11.5px;padding:5px 10px">✕ แสดงทั้ง ${_calView === '1month' ? '1 เดือน' : '3 เดือน'}</button>`
    : '';

  if (filtered.length === 0) {
    wrap.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
        <h3 style="margin:0;font-size:14.5px;font-weight:700">${escapeHtml(scopeLabel)}</h3>
        ${clearBtn}
      </div>
      <div class="empty">ไม่มีรายการหมดอายุในช่วงนี้</div>
    `;
    if (_calSelectedDay && $('d-clear-day')) {
      $('d-clear-day').addEventListener('click', () => { _calSelectedDay = null; renderCalendarDetailPanel(); refreshCalSelectionHighlight(); });
    }
    return;
  }

  wrap.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <h3 style="margin:0;font-size:14.5px;font-weight:700">${escapeHtml(scopeLabel)} <span style="color:var(--text-muted);font-weight:500;font-size:12.5px;margin-left:6px">${filtered.length} รายการ</span></h3>
      ${clearBtn}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${filtered.map(e => _renderCalEventRow(e, today)).join('')}
    </div>
  `;
  _wireCalEventRows(wrap);   // v1.9.270 — คลิก event → แก้ไข
  if (_calSelectedDay && $('d-clear-day')) {
    $('d-clear-day').addEventListener('click', () => { _calSelectedDay = null; renderCalendarDetailPanel(); refreshCalSelectionHighlight(); });
  }
}

function _renderCalEventRow(e, today) {
  const meta = _CAL_SOURCE_META[e.source_type] || _CAL_SOURCE_META.others;
  const dt = new Date(e.date);
  dt.setHours(0,0,0,0);
  const days = Math.floor((dt - today) / 86400000);
  let statusBadge;
  if (e.type === 'register') {
    statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(37,99,235,.10);color:var(--primary-dark)">🟢 จดทะเบียน</span>`;
  } else if (days < 0) {
    statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(220,38,38,.10);color:var(--critical)">⛔ หมด ${-days} วันแล้ว</span>`;
  } else if (days <= 30) {
    statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.12);color:#92400e">⚠ เหลือ ${days} วัน</span>`;
  } else {
    statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">✓ เหลือ ${days} วัน</span>`;
  }

  // Title หลัก: domain (สำหรับ source=domain) หรือ service-name (สำหรับ hosting/ssl/others)
  const titleMain = e.service ? escapeHtml(e.service.name) : escapeHtml(e.domain.name);
  // Sub-line: แสดง domain name + provider/host info
  let subParts = [];
  if (e.service) {
    // Service event: แสดง domain ที่ผูก + provider ของ service
    subParts.push(`🌐 ${escapeHtml(e.domain.name)}`);
    if (e.service.provider) subParts.push(`🏢 ${escapeHtml(e.service.provider)}`);
  } else {
    // Domain event: แสดง provider/registrar ของ domain
    if (e.domain.provider) subParts.push(`🏢 ${escapeHtml(e.domain.provider)}`);
  }

  // Type pill (ซ้ายสุด)
  const typePill = `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:${meta.color}1a;color:${meta.color};white-space:nowrap">${meta.icon} ${escapeHtml(meta.label)}</span>`;

  return `
    <div class="card hw-card" data-cal-domain="${e.domain.id}"${e.service ? ` data-cal-service="${e.service.id}"` : ''} title="คลิกเพื่อแก้ไข" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;cursor:pointer">
      ${domainLogoHTML(e.domain, 36)}
      <div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:3px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${typePill}
          <span style="font-weight:700;font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${titleMain}</span>
          ${statusBadge}
        </div>
        ${subParts.length ? `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.4">${subParts.join(' <span style="color:var(--border)">·</span> ')}</div>` : ''}
      </div>
      <div style="font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap">${escapeHtml(fmtDateThai(e.date))}</div>
      <span class="hw-chev" style="flex-shrink:0;font-size:20px;line-height:1;color:var(--text-muted)">›</span>
    </div>
  `;
}

// v1.9.270 — wire คลิก event row → แก้ไข domain/service (slide)
function _wireCalEventRows(container) {
  if (!container) return;
  container.querySelectorAll('[data-cal-domain]').forEach(row => {
    row.addEventListener('click', () => {
      const did = parseInt(row.dataset.calDomain, 10);
      const sid = row.dataset.calService ? parseInt(row.dataset.calService, 10) : null;
      const w = _websitesCache.find(x => x.domain && x.domain.id === did);
      if (!w) return;
      if (sid) {
        const s = (w.services || []).find(x => x.id === sid);
        if (s) showServiceModal(s, s.service_type);
      } else {
        showDomainModal(w.domain);
      }
    });
  });
}

// Highlight ของ cell ที่ user คลิก — รอบ ๆ cell มี ring สีน้ำเงิน
function refreshCalSelectionHighlight() {
  document.querySelectorAll('.cal-day-clickable').forEach(el => {
    const day = parseInt(el.dataset.calDay, 10);
    const month = parseInt(el.dataset.calMonth, 10);
    const year = parseInt(el.dataset.calYear, 10);
    const isSelected = _calSelectedDay
      && day === _calSelectedDay.day
      && month === _calSelectedDay.month
      && year === _calSelectedDay.year;
    el.style.boxShadow = isSelected ? '0 0 0 3px var(--primary)' : '';
    el.style.transform = isSelected ? 'translateY(-1px)' : '';
  });
}

// แสดง YYYY-MM เป็น "มี.ค. 68" (เดือน + ปี พ.ศ. 2 หลัก) — ใช้กับ purchased_at ของ PC
function fmtMonthYearThai(s) {
  if (!s) return '—';
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) {
    const year = parseInt(m[1], 10);
    const monthIdx = parseInt(m[2], 10) - 1;
    const monthShort = (typeof _MONTHS_TH !== 'undefined' && _MONTHS_TH[monthIdx])
      ? _MONTHS_TH[monthIdx].slice(0, 4) : (monthIdx + 1);
    return `${monthShort} ${(year + 543) % 100}`;
  }
  // fallback for full date strings
  return fmtDateThai(s);
}

function fmtDateThai(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const monthShort = d.toLocaleDateString('th-TH', { month: 'short' });
  return `${d.getDate()} ${monthShort} ${(d.getFullYear() + 543) % 100}`;
}

// Calendar — รองรับ 1-month (full size) และ 3-month (compact dots)
function renderCalendar() {
  const grid = $('cal-grid');
  if (!grid) return;
  const today = new Date();
  today.setHours(0,0,0,0);

  let html;
  if (_calView === '1month') {
    // 1-month view: full size (1 panel, 1fr)
    html = `<div style="display:grid;grid-template-columns:1fr;gap:14px">${renderMonthPanel(_calMonth, _calYear, today, 'full')}</div>`;
  } else {
    // 3-month view: dots-only compact
    html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px">';
    for (let offset = 0; offset < 3; offset++) {
      let m = _calMonth + offset;
      let y = _calYear;
      while (m > 11) { m -= 12; y++; }
      html += renderMonthPanel(m, y, today, 'dots');
    }
    html += '</div>';
  }

  // Legend — dot colors แสดง source type ของแต่ละ event
  const dotSwatch = (color) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};vertical-align:middle;margin-right:4px"></span>`;
  html += `
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:11.5px;color:var(--text-muted);align-items:center">
      <span style="font-style:italic;color:var(--primary)">💡 คลิกที่วันที่มีจุด เพื่อ filter รายการด้านล่าง — คลิกซ้ำเพื่อยกเลิก</span>
      <span style="border-left:1px solid var(--border);padding-left:14px">${dotSwatch(_CAL_SOURCE_META.domain.color)}🌐 Domain</span>
      <span>${dotSwatch(_CAL_SOURCE_META.hosting.color)}🖥️ Hosting</span>
      <span>${dotSwatch(_CAL_SOURCE_META.ssl.color)}🔒 SSL</span>
      <span>${dotSwatch(_CAL_SOURCE_META.others.color)}📦 Others</span>
      <span style="border-left:1px solid var(--border);padding-left:14px">
        <span style="display:inline-block;width:10px;height:10px;background:rgba(220,38,38,.20);border:1.5px solid var(--critical);border-radius:3px;vertical-align:middle;margin-right:3px"></span>หมดแล้ว
      </span>
      <span>
        <span style="display:inline-block;width:10px;height:10px;background:rgba(245,158,11,.15);border:1.5px solid #f59e0b;border-radius:3px;vertical-align:middle;margin-right:3px"></span>≤30 วัน
      </span>
      <span style="border-left:1px solid var(--border);padding-left:14px">
        <span style="display:inline-block;width:10px;height:10px;background:var(--bg-card);border:2px solid var(--primary);border-radius:3px;vertical-align:middle;margin-right:3px"></span>วันนี้
      </span>
    </div>
  `;

  // Add responsive CSS once (only affects 3-month view)
  if (!document.getElementById('cal-responsive-css')) {
    const css = document.createElement('style');
    css.id = 'cal-responsive-css';
    css.textContent = `
      @media (max-width: 1100px) {
        #cal-grid.cal-3month > div:first-child { grid-template-columns: 1fr 1fr !important; }
      }
      @media (max-width: 720px) {
        #cal-grid.cal-3month > div:first-child { grid-template-columns: 1fr !important; }
      }
    `;
    document.head.appendChild(css);
  }
  grid.classList.toggle('cal-3month', _calView === '3month');
  grid.classList.toggle('cal-1month', _calView === '1month');
  grid.innerHTML = html;
  wireCalHeaderClicks();
  wireCalDayClicks();
}

// renderMonthPanel(month, year, today, mode='full'|'dots')
//   - 'full': 1-month view (cells bigger, day font bigger, but still dots-only)
//   - 'dots': 3-month view (compact)
// Both modes use dots-only rendering — clicking a cell opens a popup with the domain list.
function renderMonthPanel(month, year, today, mode) {
  mode = mode || 'full';
  const isDots = mode === 'dots';
  const isFullDots = mode === 'full';   // 1-month, but still dots-style

  // หา events ของเดือนนี้ — รวม domain register/expire + service expire (hosting/ssl/others)
  const eventsByDay = {};
  const addEvent = (dateStr, domain, type, source_type, service) => {
    if (!dateStr) return;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    if (d.getMonth() === month && d.getFullYear() === year) {
      const day = d.getDate();
      (eventsByDay[day] = eventsByDay[day] || []).push({ domain, type, source_type, service });
    }
  };
  for (const w of _websitesCache) {
    const dom = w.domain;
    addEvent(dom.register_date, dom, 'register', 'domain');
    addEvent(dom.expire_date, dom, 'expire', 'domain');
    for (const s of (w.services || [])) {
      addEvent(s.expire_date, dom, 'expire', s.service_type, s);
    }
  }

  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthLabel = `${_MONTHS_TH[month]} ${year + 543}`;

  // Header เดือน — กดได้เพื่อ switch ไป 1-month view (เฉพาะใน 3-month mode)
  const headerStyle = isDots
    ? 'cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px;transition:text-decoration-color .15s'
    : '';
  const headerData = isDots ? `data-cal-zoom-month="${month}" data-cal-zoom-year="${year}" title="คลิกเพื่อขยายเป็น 1 เดือน"` : '';
  const headerSize = isDots ? '13px' : '17px';
  const headerMargin = isDots ? '6px' : '12px';

  // Sizing per mode (both dots-style — no chips with full names)
  const cellMin = isDots ? 38 : 60;
  const cellPad = isDots ? '2px 3px' : '5px 7px';
  const dayFont = isDots ? '10px' : '14px';
  const dotSize = isDots ? 6 : 9;            // bigger dots in 1-month view
  const headerDowFont = isDots ? '9px' : '11.5px';
  const headerDowPad = isDots ? '3px 1px' : '8px 4px';

  let html = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:${isDots ? '10px' : '14px'}">
      <div ${headerData} class="cal-month-header" style="text-align:center;font-weight:700;font-size:${headerSize};color:var(--text);margin-bottom:${headerMargin};${headerStyle}">${escapeHtml(monthLabel)}</div>
      <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:${isDots ? '2px' : '4px'}">
  `;

  // header DOW
  for (const dow of _DAYS_TH) {
    html += `<div style="text-align:center;padding:${headerDowPad};font-size:${headerDowFont};font-weight:700;color:var(--text-muted);text-transform:uppercase">${dow}</div>`;
  }
  for (let i = 0; i < startDow; i++) html += '<div></div>';

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    const isToday = date.getTime() === today.getTime();
    const events = eventsByDay[day] || [];
    const hasEvent = events.length > 0;
    const hasExpire = events.some(e => e.type === 'expire');
    const hasRegister = events.some(e => e.type === 'register');

    let bg = 'var(--bg-card)';
    let border = '1px solid var(--border)';
    let dayColor = 'var(--text)';
    let expireDays = null;   // ใช้คำนวณสีของ dot

    if (hasExpire) {
      // ใช้ days-until-expire ของ event แรก (priority)
      const expEvent = events.find(e => e.type === 'expire');
      expireDays = Math.floor((date - today) / 86400000);
      if (expireDays < 0) {
        bg = 'rgba(220,38,38,.12)';
        border = '1.5px solid var(--critical)';
        dayColor = 'var(--critical)';
      } else if (expireDays <= 30) {
        bg = 'rgba(245,158,11,.15)';
        border = '1.5px solid #f59e0b';
        dayColor = '#92400e';
      } else {
        bg = 'rgba(16,185,129,.10)';
        border = '1.5px solid #10b981';
        dayColor = '#15803d';
      }
    } else if (hasRegister) {
      bg = 'rgba(37,99,235,.08)';
      border = '1.5px solid rgba(37,99,235,.4)';
      dayColor = 'var(--primary-dark)';
    }
    if (isToday) border = '2px solid var(--primary)';

    // Tooltip
    const titleParts = events.map(e =>
      (e.type === 'expire' ? 'หมดอายุ: ' : 'จดทะเบียน: ') + e.domain.name
    );
    const titleAttr = titleParts.length ? `title="${escapeHtml(titleParts.join('\n'))}"` : '';

    // === Dots-only rendering (both modes) — chips with full names removed ===
    // Click on a cell with events → toggle selection + update detail panel below
    // Dot color = source type (domain/hosting/ssl/others) — เพื่อแยกประเภทได้ในตา
    const dotColor = (e) => {
      // Register event ของ domain → blue (เหมือนเดิม)
      if (e.type === 'register') return _CAL_SOURCE_META.domain.color;
      // Expire — สีตาม source type
      const meta = _CAL_SOURCE_META[e.source_type] || _CAL_SOURCE_META.others;
      return meta.color;
    };
    const maxDots = isDots ? 4 : 6;     // 1-month can show a few more dots
    const dots = events.slice(0, maxDots).map(e =>
      `<span style="display:inline-block;width:${dotSize}px;height:${dotSize}px;border-radius:50%;background:${dotColor(e)}"></span>`
    ).join('');
    const extraCount = events.length - maxDots;
    const moreNum = extraCount > 0
      ? `<span style="font-size:${isDots ? 8 : 10}px;font-weight:700;color:var(--text-muted);margin-left:2px">+${extraCount}</span>`
      : '';
    const cellContent = `
      <div style="font-size:${dayFont};font-weight:${isToday || hasEvent ? '700' : '500'};color:${dayColor};line-height:1">${day}${isToday ? ' •' : ''}</div>
      ${hasEvent ? `<div style="display:flex;flex-wrap:wrap;gap:${isDots ? 2 : 3}px;align-items:center;margin-top:${isDots ? 2 : 4}px">${dots}${moreNum}</div>` : ''}
    `;

    // Cells with events get a clickable class + data attrs for the popup wiring
    const cellClass = hasEvent ? 'cal-day-clickable' : '';
    const dataAttrs = hasEvent ? `data-cal-day="${day}" data-cal-month="${month}" data-cal-year="${year}"` : '';
    const cursor = hasEvent ? 'pointer' : 'default';
    const hoverStyle = hasEvent ? 'transition:transform .12s ease, box-shadow .12s ease' : '';
    html += `
      <div ${titleAttr} ${dataAttrs} class="${cellClass}" style="min-height:${cellMin}px;padding:${cellPad};background:${bg};border:${border};border-radius:${isDots ? '5px' : '8px'};display:flex;flex-direction:column;gap:${isDots ? '0' : '3px'};overflow:hidden;cursor:${cursor};${hoverStyle}">
        ${cellContent}
      </div>
    `;
  }
  html += '</div></div>';
  return html;
}

// Wire clickable month headers (called after renderCalendar updates DOM)
function wireCalHeaderClicks() {
  document.querySelectorAll('.cal-month-header[data-cal-zoom-month]').forEach(el => {
    el.addEventListener('click', () => {
      const m = parseInt(el.dataset.calZoomMonth, 10);
      const y = parseInt(el.dataset.calZoomYear, 10);
      _calMonth = m;
      _calYear = y;
      _calView = '1month';
      const monthSel = $('cal-month'), yearSel = $('cal-year');
      if (monthSel) monthSel.value = m;
      if (yearSel) yearSel.value = y;
      updateViewToggle();
      // animate
      const grid = $('cal-grid');
      if (grid && !_calAnimating) {
        _calAnimating = true;
        grid.style.transition = 'transform .22s ease, opacity .22s ease';
        grid.style.transform = 'scale(1.05)';
        grid.style.opacity = '0';
        setTimeout(() => {
          grid.style.transition = 'none';
          grid.style.transform = 'scale(0.95)';
          renderCalendar();
          void grid.offsetHeight;
          grid.style.transition = 'transform .25s ease, opacity .25s ease';
          grid.style.transform = 'scale(1)';
          grid.style.opacity = '1';
          setTimeout(() => { _calAnimating = false; }, 260);
        }, 230);
      } else {
        renderCalendar();
      }
    });
    el.addEventListener('mouseenter', () => { el.style.textDecorationColor = 'var(--primary)'; });
    el.addEventListener('mouseleave', () => { el.style.textDecorationColor = 'transparent'; });
  });
}

// Wire clickable day cells — each cell with events updates detail panel below (toggle selection)
function wireCalDayClicks() {
  document.querySelectorAll('.cal-day-clickable').forEach(el => {
    const day = parseInt(el.dataset.calDay, 10);
    const month = parseInt(el.dataset.calMonth, 10);
    const year = parseInt(el.dataset.calYear, 10);
    const isSelected = () => _calSelectedDay
      && day === _calSelectedDay.day
      && month === _calSelectedDay.month
      && year === _calSelectedDay.year;

    // initial highlight (กรณี selection ค้างจากครั้งก่อน)
    if (isSelected()) {
      el.style.boxShadow = '0 0 0 3px var(--primary)';
      el.style.transform = 'translateY(-1px)';
    }

    el.addEventListener('mouseenter', () => {
      if (!isSelected()) {
        el.style.boxShadow = '0 0 0 2px var(--primary)';
        el.style.transform = 'translateY(-1px)';
      }
    });
    el.addEventListener('mouseleave', () => {
      if (!isSelected()) {
        el.style.boxShadow = '';
        el.style.transform = '';
      }
    });
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      // Toggle: คลิกซ้ำที่วันเดิม → ยกเลิก selection
      if (isSelected()) {
        _calSelectedDay = null;
      } else {
        _calSelectedDay = { day, month, year };
      }
      refreshCalSelectionHighlight();
      renderCalendarDetailPanel();
    });
  });
}

// Compute events for a given (day, month, year) — รวม domain register/expire + service expire
function _calEventsOnDay(day, month, year) {
  const events = [];
  const matchDay = (iso) => {
    if (!iso) return false;
    const t = new Date(iso);
    return !isNaN(t.getTime()) && t.getDate() === day && t.getMonth() === month && t.getFullYear() === year;
  };
  for (const w of _websitesCache) {
    const d = w.domain;
    if (matchDay(d.register_date)) {
      events.push({ type: 'register', source_type: 'domain', domain: d, date: d.register_date });
    }
    if (matchDay(d.expire_date)) {
      events.push({ type: 'expire', source_type: 'domain', domain: d, date: d.expire_date });
    }
    for (const s of (w.services || [])) {
      if (matchDay(s.expire_date)) {
        events.push({ type: 'expire', source_type: s.service_type, domain: d, service: s, date: s.expire_date });
      }
    }
  }
  // Sort: expire first (more urgent), then register; แล้ว by source_type → name
  events.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'expire' ? -1 : 1;
    if (a.source_type !== b.source_type) {
      const order = { domain: 0, hosting: 1, ssl: 2, others: 3 };
      return (order[a.source_type] ?? 9) - (order[b.source_type] ?? 9);
    }
    return (a.domain.name || '').localeCompare(b.domain.name || '', 'th');
  });
  return events;
}

function showCalDayPopup(day, month, year, anchor) {
  // Close any existing popup first
  const existing = document.getElementById('cal-day-pop');
  if (existing) existing.remove();

  const events = _calEventsOnDay(day, month, year);
  if (events.length === 0) return;

  const today = new Date(); today.setHours(0,0,0,0);
  const cellDate = new Date(year, month, day);
  const dateLabel = `${day} ${_MONTHS_TH[month]} ${year + 543}`;

  // Status badge per event type
  const eventCard = (e) => {
    const isExp = e.type === 'expire';
    const icon = isExp ? '⏰' : '🟢';
    const label = isExp ? 'หมดอายุ' : 'จดทะเบียน';
    let badge = '';
    let labelColor = isExp ? 'var(--critical)' : 'var(--primary-dark)';
    if (isExp && e.domain.expire_date) {
      const days = Math.floor((new Date(e.domain.expire_date) - today) / 86400000);
      if (days < 0) {
        badge = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;background:rgba(220,38,38,.10);color:var(--critical);font-size:10.5px;font-weight:700">⛔ หมด ${-days} วันแล้ว</span>`;
      } else if (days <= 30) {
        badge = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;background:rgba(245,158,11,.12);color:#92400e;font-size:10.5px;font-weight:700">⚠ เหลือ ${days} วัน</span>`;
      } else {
        badge = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;background:rgba(16,185,129,.12);color:var(--green);font-size:10.5px;font-weight:700">✓ เหลือ ${days} วัน</span>`;
      }
    }
    const provider = e.domain.provider ? ` · 🏢 ${escapeHtml(e.domain.provider)}` : '';
    return `
      <div class="cal-pop-row" data-d-name="${escapeHtml(e.domain.name)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:background .12s">
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(e.domain.name)}</div>
          <div style="font-size:11.5px;color:${labelColor};font-weight:600;margin-top:1px">${icon} ${label}${provider}</div>
        </div>
        ${badge}
      </div>
    `;
  };

  const pop = document.createElement('div');
  pop.id = 'cal-day-pop';
  pop.style.cssText = `
    position:fixed; z-index:9999; background:var(--bg-card); border:1px solid var(--border);
    border-radius:12px; box-shadow:0 12px 36px rgba(0,0,0,.18);
    padding:12px 14px; min-width:260px; max-width:340px; max-height:60vh; overflow-y:auto;
    animation: calPopIn .14s ease-out;
  `;
  pop.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px">
      <div style="font-weight:700;font-size:13.5px;color:var(--text)">📅 ${escapeHtml(dateLabel)}</div>
      <div style="font-size:11px;color:var(--text-muted);font-weight:600;white-space:nowrap">${events.length} รายการ</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${events.map(eventCard).join('')}
    </div>
  `;

  // One-time CSS for the slide-in animation
  if (!document.getElementById('cal-pop-css')) {
    const css = document.createElement('style');
    css.id = 'cal-pop-css';
    css.textContent = `
      @keyframes calPopIn {
        from { opacity: 0; transform: translateY(-4px) scale(.97); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .cal-pop-row:hover { background: var(--bg-soft) !important; }
    `;
    document.head.appendChild(css);
  }

  document.body.appendChild(pop);

  // Smart positioning — try to place below the cell; flip above if it'd overflow
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  const margin = 10;
  let top = rect.bottom + 8;
  let left = rect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  if (left < margin) left = margin;
  if (top + popRect.height > window.innerHeight - margin) {
    top = rect.top - popRect.height - 8;
    if (top < margin) top = margin;
  }
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';

  // Click on a row → switch to Domain Config page (admin) or just info
  pop.querySelectorAll('.cal-pop-row').forEach(row => {
    row.addEventListener('click', () => {
      const name = row.dataset.dName;
      // For now, just close the popup. Future: could navigate to Domain Config + filter.
      // Keep this as no-op or copy name to clipboard for quick reference.
      try {
        if (navigator.clipboard) navigator.clipboard.writeText(name);
      } catch (_) {}
    });
  });

  // Close handlers — outside click + ESC
  const close = () => {
    pop.remove();
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onKey);
  };
  const onOutside = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onKey);
  }, 0);
}


// ============== Domain Config (admin only) ==============

// Domain Config — state for search + sort (persists across refreshes within session)
let _dcCache = [];
let _dcSearch = '';
let _dcSort = 'expire-asc';   // expire-asc | name-asc | name-desc | created-desc
let _dcCustomerFilter = '';   // v1.9.272 '' (ทั้งหมด) | 'current' | 'former'

// Domain Config — เดิมเคยเป็นหน้าแยก ตอนนี้ถูกรวมเข้า Services Config เป็น tab แรก
// renderDomainsConfigPage = legacy alias → ส่งต่อไป Services Config (Domain tab)
async function renderDomainsConfigPage() {
  _scActiveTab = 'domain';
  await renderServicesConfigPage();
}

// HTML body ของ Domain tab (toolbar + list) — ใช้ใน Services Config
function _buildDomainTabBodyHTML() {
  return `
    <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <div style="flex:1;min-width:240px;position:relative">
        <input id="dc-search" type="text" placeholder="🔍 ค้นหาชื่อ domain / provider / note..." autocomplete="off"
          style="width:100%;padding:8px 32px 8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
        <button id="dc-search-clear" type="button" title="ล้างการค้นหา"
          style="display:none;position:absolute;right:6px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:4px 8px">✕</button>
      </div>
      <select id="dc-sort" style="padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--bg-card);color:var(--text);font-family:inherit;cursor:pointer">
        <option value="expire-asc">⏰ ใกล้หมดอายุก่อน</option>
        <option value="name-asc">🔤 ชื่อ A → Z</option>
        <option value="name-desc">🔤 ชื่อ Z → A</option>
        <option value="created-desc">📅 จดทะเบียนล่าสุด</option>
      </select>
      <span id="dc-count" style="color:var(--text-muted);font-size:12.5px;font-weight:600;white-space:nowrap">— รายการ</span>
    </div>
    <div id="dc-list"><div class="empty">กำลังโหลด…</div></div>
  `;
}

// Wire events ของ Domain tab — ใช้ค่าจาก _dcSearch / _dcSort ที่จำไว้
function _wireDomainTab() {
  $('dc-search').value = _dcSearch;
  $('dc-sort').value = _dcSort;
  $('dc-search-clear').style.display = _dcSearch ? '' : 'none';
  $('dc-search').addEventListener('input', (e) => {
    _dcSearch = e.target.value;
    $('dc-search-clear').style.display = _dcSearch ? '' : 'none';
    renderDomainsConfigRows();
  });
  $('dc-search-clear').addEventListener('click', () => {
    _dcSearch = '';
    $('dc-search').value = '';
    $('dc-search-clear').style.display = 'none';
    $('dc-search').focus();
    renderDomainsConfigRows();
  });
  $('dc-sort').addEventListener('change', (e) => {
    _dcSort = e.target.value;
    renderDomainsConfigRows();
  });
}

async function loadDomainsConfigList() {
  let data;
  try {
    data = await fetchJson('/api/admin/domains');
  } catch (e) {
    if ($('dc-list')) $('dc-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _dcCache = data.domains || [];
  renderDomainsConfigRows();
}

// v1.9.271 — kebab dropdown menu (⋮) — reusable
function _kebabMenu(btn, items) {
  document.querySelectorAll('.kebab-pop').forEach(e => e.remove());
  const r = btn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'kebab-pop';
  pop.style.top = (r.bottom + 4) + 'px';
  pop.style.left = Math.max(8, Math.min(r.right - 178, window.innerWidth - 186)) + 'px';
  pop.innerHTML = items.map((it, i) => `<button type="button" data-ki="${i}" style="color:${it.danger ? 'var(--critical)' : 'var(--text)'}"><span style="width:18px;text-align:center">${it.icon || ''}</span> ${escapeHtml(it.label)}</button>`).join('');
  document.body.appendChild(pop);
  pop.querySelectorAll('button[data-ki]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation(); pop.remove(); document.removeEventListener('click', closer, true);
    items[parseInt(b.dataset.ki, 10)].onClick();
  }));
  const closer = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', closer, true); } };
  setTimeout(() => document.addEventListener('click', closer, true), 0);
}
function _domainAct(d, act) {
  handleDomainAction({ dataset: { dId: String(d.id), dAct: act, dName: d.name, dExpire: d.expire_date || '' } }, _dcCache);
}
// v1.9.283 — เพิ่ม Hosting/SSL/Others ให้ domain จาก Services Config (โหลด cache ตรง ๆ ไม่กระทบ render)
async function _dcAddService(d, typeId) {
  try {
    const sd = await fetchJson('/api/admin/services');
    _svcCache = { hosting: [], ssl: [], others: [] };
    (sd.services || []).forEach(s => { if (_svcCache[s.service_type]) _svcCache[s.service_type].push(s); });
  } catch (e) { alert('โหลด services ไม่ได้: ' + e.message); return; }
  try { _wsCache = (await fetchJson('/api/admin/websites')).websites || []; } catch (_) { /* linkedIds จะว่าง — candidates ครบ */ }
  showLinkServiceModal(d.id, typeId);
}

function renderDomainsConfigRows() {
  const listEl = $('dc-list');
  if (!listEl) return;
  const countEl = $('dc-count');

  // empty (no domains at all)
  if (_dcCache.length === 0) {
    listEl.innerHTML = `<div class="empty">ยังไม่มี domain — กด <strong>+ เพิ่ม Domain</strong></div>`;
    if (countEl) countEl.textContent = '0 รายการ';
    return;
  }

  // filter (search ก่อน → ใช้คำนวณ count ของ toggle ลูกค้า)
  const q = _dcSearch.trim().toLowerCase();
  const baseList = !q ? _dcCache.slice() : _dcCache.filter(d => {
    return (d.name || '').toLowerCase().includes(q)
        || (d.provider || '').toLowerCase().includes(q)
        || (d.notes || '').toLowerCase().includes(q);
  });
  // v1.9.272 — count + filter สถานะลูกค้า (default 'current' ถ้าไม่มีค่า)
  const _isFormer = d => d.customer_status === 'former';
  const _curN = baseList.filter(d => !_isFormer(d)).length;
  const _formerN = baseList.filter(_isFormer).length;
  let list = baseList;
  if (_dcCustomerFilter === 'current') list = baseList.filter(d => !_isFormer(d));
  else if (_dcCustomerFilter === 'former') list = baseList.filter(_isFormer);

  // sort
  const FAR = 9e15;
  list.sort((a, b) => {
    if (_dcSort === 'name-asc')   return (a.name || '').localeCompare(b.name || '', 'th');
    if (_dcSort === 'name-desc')  return (b.name || '').localeCompare(a.name || '', 'th');
    if (_dcSort === 'created-desc') {
      const ad = a.register_date ? new Date(a.register_date).getTime() : -FAR;
      const bd = b.register_date ? new Date(b.register_date).getTime() : -FAR;
      if (bd !== ad) return bd - ad;
      return (a.name || '').localeCompare(b.name || '', 'th');
    }
    // default: expire-asc — earliest expire first; null expire goes last
    const ae = a.expire_date ? new Date(a.expire_date).getTime() : FAR;
    const be = b.expire_date ? new Date(b.expire_date).getTime() : FAR;
    if (ae !== be) return ae - be;
    return (a.name || '').localeCompare(b.name || '', 'th');
  });

  // count
  if (countEl) {
    countEl.textContent = q
      ? `${list.length} / ${_dcCache.length} รายการ`
      : `${_dcCache.length} รายการ`;
  }

  // v1.9.272/275 — toggle filter ลูกค้าปัจจุบัน / อดีตลูกค้า (เด่นชัด + label)
  const _tgl = (key, label, n) => {
    const active = _dcCustomerFilter === key;
    return `<button type="button" data-dc-cust="${key}" style="border:1px solid ${active ? 'var(--primary)' : 'transparent'};background:${active ? 'var(--primary)' : 'transparent'};color:${active ? '#fff' : 'var(--text-muted)'};font-weight:${active ? 700 : 600};font-size:12.5px;padding:7px 15px;border-radius:8px;cursor:pointer;font-family:inherit;transition:.12s;white-space:nowrap">${label} <span style="opacity:.85">${n}</span></button>`;
  };
  const toggleHtml = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
    <span style="font-size:12.5px;font-weight:600;color:var(--text-muted)">กรองตามสถานะลูกค้า:</span>
    <div style="display:inline-flex;gap:3px;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;padding:3px">${_tgl('', '📋 ทั้งหมด', baseList.length)}${_tgl('current', '🟢 ลูกค้าปัจจุบัน', _curN)}${_tgl('former', '⚪ อดีตลูกค้า', _formerN)}</div>
  </div>`;
  const _wireToggle = () => listEl.querySelectorAll('[data-dc-cust]').forEach(b => b.addEventListener('click', () => { _dcCustomerFilter = b.dataset.dcCust; renderDomainsConfigRows(); }));

  // empty after filter
  if (list.length === 0) {
    listEl.innerHTML = toggleHtml + `<div class="empty">${q ? `ไม่พบ domain ที่ตรงกับ "<strong>${escapeHtml(_dcSearch)}</strong>"` : '— ไม่มี domain ในกลุ่มนี้ —'}</div>`;
    _wireToggle();
    return;
  }

  // v1.9.271 — table layout
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  listEl.innerHTML = toggleHtml + `<div class="cfg-table-wrap"><div class="cfg-table-scroll"><table class="cfg-table">
    <thead><tr>
      <th>Domain</th><th>ลูกค้า</th><th>สถานะ</th><th>วันจดทะเบียน</th><th>วันหมดอายุ</th><th style="text-align:right">จัดการ</th>
    </tr></thead>
    <tbody>${list.map(d => renderDomainConfigRow(d, today)).join('')}</tbody>
  </table></div></div>`;
  _wireToggle();
  // คลิกทั้งแถว = แก้ไข · ⋮ kebab = เมนูแอ็กชัน (Lookup/Renew/ประวัติ/ลบ)
  listEl.querySelectorAll('tr[data-d-row]').forEach(row => {
    row.addEventListener('click', () => {
      const d = _dcCache.find(x => x.id === parseInt(row.dataset.dRow, 10));
      if (d) showDomainModal(d);
    });
  });
  listEl.querySelectorAll('[data-d-kebab]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = _dcCache.find(x => x.id === parseInt(btn.dataset.dKebab, 10));
    if (!d) return;
    _kebabMenu(btn, [
      { icon: '↗', label: 'เปิดเว็บไซต์', onClick: () => window.open('https://' + d.name, '_blank', 'noopener') },
      { icon: '✏️', label: 'แก้ไข', onClick: () => showDomainModal(d) },
      { icon: '🖥', label: 'เพิ่ม Hosting', onClick: () => _dcAddService(d, 'hosting') },
      { icon: '🔒', label: 'เพิ่ม SSL', onClick: () => _dcAddService(d, 'ssl') },
      { icon: '📦', label: 'เพิ่ม Others', onClick: () => _dcAddService(d, 'others') },
      { icon: '🔍', label: 'Lookup (WHOIS)', onClick: () => _domainAct(d, 'lookup') },
      { icon: '🔄', label: 'Renew', onClick: () => _domainAct(d, 'renew') },
      { icon: '📜', label: 'ประวัติ', onClick: () => _domainAct(d, 'history') },
      { icon: '🗑', label: 'ลบ', danger: true, onClick: () => _domainAct(d, 'delete') },
    ]);
  }));
}

// Render circular logo (or initial fallback) for a domain object
function domainLogoHTML(d, size) {
  size = size || 36;
  const half = Math.round(size / 2);
  if (d && d.logo_data) {
    return `<img src="${d.logo_data}" alt="${escapeHtml(d.name || '')}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;background:#fff;flex-shrink:0;border:1px solid var(--border)" />`;
  }
  const initial = (d && d.name ? d.name.trim().charAt(0).toUpperCase() : '?');
  // Generate a deterministic background color from the domain name
  let hue = 0;
  if (d && d.name) {
    for (let i = 0; i < d.name.length; i++) hue = (hue + d.name.charCodeAt(i) * 7) % 360;
  }
  const bg = `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 40) % 360} 65% 45%))`;
  return `<span style="width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-weight:700;font-size:${Math.round(size * 0.42)}px;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0">${escapeHtml(initial)}</span>`;
}

function renderDomainConfigRow(d, today) {
  // status badge + สีของช่องวันหมดอายุ
  let statusBadge = '<span style="color:var(--text-muted);font-size:11px">— ไม่มีวันหมดอายุ</span>';
  let expStyle = 'color:var(--text-muted)';
  if (d.expire_date) {
    const exp = new Date(d.expire_date);
    const days = Math.floor((exp - today) / 86400000);
    if (days < 0) {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(220,38,38,.10);color:var(--critical)">⛔ หมด ${-days} วันแล้ว</span>`;
      expStyle = 'color:var(--critical);font-weight:700';
    } else if (days <= 30) {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.12);color:#92400e">⚠ เหลือ ${days} วัน</span>`;
      expStyle = 'color:#b45309;font-weight:600';
    } else {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">✓ เหลือ ${days} วัน</span>`;
      expStyle = 'color:var(--text)';
    }
  }

  // meta line — เอามารวมเป็นบรรทัดเดียว ขั้นด้วย ·
  // Tiny WHOIS-source badge: 🌐 with tooltip showing when WHOIS was applied.
  // Renders as inline icon next to the date, hoverable for the timestamp.
  const whoisBadge = (syncedAtIso) => {
    if (!syncedAtIso) return '';
    const t = new Date(syncedAtIso);
    const tooltip = isNaN(t.getTime())
      ? `ดึงจาก WHOIS เมื่อ ${escapeHtml(syncedAtIso)}`
      : `ดึงจาก WHOIS เมื่อ ${t.toLocaleString('th-TH', {dateStyle:'medium', timeStyle:'short'})}`;
    return `<span title="${escapeHtml(tooltip)}" style="display:inline-block;margin-left:3px;font-size:10px;color:#2563eb;cursor:help;vertical-align:baseline" aria-label="from WHOIS">🌐</span>`;
  };

  // sub-line ใต้ชื่อ domain: provider หรือ notes
  let subLine = '';
  if (d.provider) subLine = `🏢 ${escapeHtml(d.provider)}`;
  else if (d.notes) subLine = `<span title="${escapeHtml(d.notes)}">📝 ${escapeHtml(d.notes.length > 40 ? d.notes.slice(0, 37) + '…' : d.notes)}</span>`;
  // v1.9.272 — badge สถานะลูกค้า
  const custBadge = d.customer_status === 'former'
    ? '<span style="display:inline-flex;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:var(--bg-soft);color:var(--text-muted);white-space:nowrap">⚪ อดีตลูกค้า</span>'
    : '<span style="display:inline-flex;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(37,99,235,.10);color:var(--primary);white-space:nowrap">🟢 ลูกค้าปัจจุบัน</span>';
  const regCell = d.register_date ? `${escapeHtml(fmtDateThai(d.register_date))}${whoisBadge(d.register_whois_synced_at)}` : '—';
  const expCell = d.expire_date ? `${escapeHtml(fmtDateThai(d.expire_date))}${whoisBadge(d.expire_whois_synced_at)}${d.renewal_count > 0 ? ` <span style="font-size:10px;color:var(--text-muted)" title="renew ${d.renewal_count} ครั้ง">🔄${d.renewal_count}</span>` : ''}` : '—';

  return `
    <tr data-d-row="${d.id}" title="คลิกเพื่อแก้ไข">
      <td>
        <div style="display:flex;align-items:center;gap:11px;min-width:200px">
          ${domainLogoHTML(d, 34)}
          <div style="min-width:0">
            <div style="display:flex;align-items:center;gap:6px;min-width:0">
              <span style="font-weight:700;font-size:13.5px;font-family:ui-monospace,Menlo,monospace;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(d.name)}</span>
              <a href="https://${escapeHtml(d.name)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="เปิดเว็บไซต์ ${escapeHtml(d.name)}" style="flex-shrink:0;color:var(--primary);text-decoration:none;font-size:13px;font-weight:700;padding:0 4px;border-radius:5px;line-height:1.2">↗</a>
            </div>
            ${subLine ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${subLine}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${custBadge}</td>
      <td>${statusBadge}</td>
      <td style="white-space:nowrap;color:var(--text-muted)">${regCell}</td>
      <td style="white-space:nowrap;${expStyle}">${expCell}</td>
      <td style="text-align:right;white-space:nowrap"><button type="button" class="kebab-btn" data-d-kebab="${d.id}" title="เมนู">⋮</button></td>
    </tr>
  `;
}

async function handleDomainAction(btn, list) {
  const id = parseInt(btn.dataset.dId, 10);
  const act = btn.dataset.dAct;
  const name = btn.dataset.dName;

  if (act === 'edit') {
    const d = list.find(x => x.id === id);
    if (d) showDomainModal(d);
  } else if (act === 'delete') {
    if (!confirm(`ลบ domain "${name}"?\n\n(ประวัติการ renew ทั้งหมดจะถูกลบด้วย)`)) return;
    try {
      await fetchJson('/api/admin/domains/' + id, { method: 'DELETE' });
      await loadDomainsConfigList();
    } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  } else if (act === 'renew') {
    const expire = btn.dataset.dExpire || '';
    showRenewModal(id, name, expire);
  } else if (act === 'history') {
    showRenewalHistoryModal(id, name);
  } else if (act === 'lookup') {
    showLookupModal(name, 'whois');
  }
}

// ============== Lookup modal (WHOIS + nslookup + DNS, tabbed) ==============

function showLookupModal(domainName, initialTab) {
  // initialTab: 'whois' | 'nslookup' | 'dns'  (default 'whois')
  initialTab = initialTab || 'whois';
  // Inject the once-only CSS for cleaning trailing row borders + tab styles
  if (!document.getElementById('lookup-css')) {
    const css = document.createElement('style');
    css.id = 'lookup-css';
    css.textContent = `
      .lookup-rows > .lookup-row:last-child { border-bottom: 0 !important; }
      .lookup-tab {
        background: transparent;
        border: none;
        border-bottom: 2px solid transparent;
        padding: 9px 16px;
        font-size: 13px;
        font-weight: 600;
        color: var(--text-muted);
        cursor: pointer;
        font-family: inherit;
        transition: color .15s, border-color .15s;
      }
      .lookup-tab:hover { color: var(--text); }
      .lookup-tab.active {
        color: var(--primary);
        border-bottom-color: var(--primary);
      }
    `;
    document.head.appendChild(css);
  }

  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide">
      <h3 style="margin-bottom:8px">🔍 Lookup: <span style="font-family:ui-monospace,Menlo,monospace;color:var(--primary-dark)">${escapeHtml(domainName)}</span></h3>
      <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px">
        <button class="lookup-tab" data-lk-tab="whois">📋 WHOIS</button>
        <button class="lookup-tab" data-lk-tab="nslookup">🔍 nslookup</button>
        <button class="lookup-tab" data-lk-tab="dns">🌐 DNS records</button>
      </div>
      <div id="lookup-body" style="font-size:13px;min-height:160px;max-height:60vh;overflow-y:auto">
        <div style="text-align:center;padding:30px;color:var(--text-muted)">
          <div style="font-size:24px;margin-bottom:8px">⏳</div>
          กำลังค้นหา…
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="lk-refresh" title="ค้นหาแท็บปัจจุบันใหม่">🔄 ค้นหาใหม่</button>
        <button class="btn" id="lk-copy" title="คัดลอกผลลัพธ์เป็น text">📋 คัดลอก</button>
        <button class="btn primary" id="lk-close">ปิด</button>
      </div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#lk-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  // Cache results per tab so switching tabs doesn't re-query
  const _cache = {};       // { whois: {html, text}, nslookup: ..., dns: ... }
  let _currentTab = initialTab;

  const setActiveTabUI = (tab) => {
    bg.querySelectorAll('.lookup-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.lkTab === tab);
    });
  };

  const fetchAndRender = async (tab, force) => {
    _currentTab = tab;
    setActiveTabUI(tab);
    const body = bg.querySelector('#lookup-body');
    if (!force && _cache[tab]) {
      body.innerHTML = _cache[tab].html;
      return;
    }
    body.innerHTML = `
      <div style="text-align:center;padding:30px;color:var(--text-muted)">
        <div style="font-size:24px;margin-bottom:8px">⏳</div>
        กำลังค้นหา ${tab === 'whois' ? 'WHOIS' : tab} ของ ${escapeHtml(domainName)}…
        ${tab === 'whois' ? '<div style="font-size:11px;margin-top:6px">(WHOIS อาจช้า 3-10 วินาที)</div>' : ''}
      </div>
    `;
    try {
      const url = '/api/admin/domains/lookup/' + tab + '?name=' + encodeURIComponent(domainName);
      const data = await fetchJson(url);
      let rendered;
      if (tab === 'whois')         rendered = renderWhoisResult(data);
      else if (tab === 'nslookup') rendered = renderNslookupResult(data);
      else                          rendered = renderDnsResult(data);
      _cache[tab] = rendered;
      // Only render if user hasn't switched tabs while we waited
      if (_currentTab === tab) body.innerHTML = rendered.html;
    } catch (e) {
      const html = `<div class="empty" style="color:var(--critical)">ค้นหาไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
      _cache[tab] = { html, text: 'Error: ' + e.message };
      if (_currentTab === tab) body.innerHTML = html;
    }
  };

  bg.querySelectorAll('.lookup-tab').forEach(b => {
    b.addEventListener('click', () => fetchAndRender(b.dataset.lkTab, false));
  });
  bg.querySelector('#lk-refresh').addEventListener('click', () => fetchAndRender(_currentTab, true));
  bg.querySelector('#lk-copy').addEventListener('click', async () => {
    const cached = _cache[_currentTab];
    if (!cached || !cached.text) return;
    try {
      await navigator.clipboard.writeText(cached.text);
      const btn = bg.querySelector('#lk-copy');
      const old = btn.textContent;
      btn.textContent = '✓ คัดลอกแล้ว';
      setTimeout(() => { btn.textContent = old; }, 1500);
    } catch (e) {
      alert('คัดลอกไม่สำเร็จ: ' + e.message);
    }
  });

  fetchAndRender(initialTab, false);
}

function renderWhoisResult(data) {
  const lines = [];
  lines.push('Domain: ' + data.domain);
  if (data.error) {
    lines.push('Error: ' + data.error);
    let html = `
      <div style="background:rgba(220,38,38,.08);border:1px solid var(--critical);border-radius:8px;padding:14px;color:var(--critical);font-weight:600;margin-bottom:10px">
        ⛔ ${escapeHtml(data.error)}
      </div>
    `;
    if (data.raw) {
      html += renderWhoisRawSection(data.raw);
      lines.push('');
      lines.push('--- Raw WHOIS ---');
      lines.push(data.raw);
    }
    return { html, text: lines.join('\n') };
  }

  const today = new Date(); today.setHours(0,0,0,0);
  // pickDate: ถ้าเป็น array ของ datetimes (เช่นมาจาก WHOIS หลาย source) ให้เลือกตัวที่ "เกี่ยวข้องที่สุด"
  //   updated_date     → เอาวันที่ใหม่ที่สุด (latest)
  //   creation_date    → เอาวันเก่าที่สุด (earliest = original registration)
  //   expiration_date  → เอาวันใหม่ที่สุด (latest = หลัง renew)
  const pickDate = (v, prefer) => {
    if (v == null) return null;
    if (!Array.isArray(v)) return v;
    if (v.length === 0) return null;
    const valids = v.filter(x => x && !isNaN(new Date(x).getTime()));
    if (valids.length === 0) return v[0];
    valids.sort((a, b) => new Date(a) - new Date(b));
    return prefer === 'earliest' ? valids[0] : valids[valids.length - 1];
  };
  const fmtDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toISOString().slice(0,10) + ' (' + d.toLocaleString('th-TH', {hour12:false}).replace(',','') + ')';
  };
  const daysFromToday = (v) => {
    if (!v) return null;
    const d = new Date(v); d.setHours(0,0,0,0);
    if (isNaN(d.getTime())) return null;
    return Math.floor((d - today) / 86400000);
  };
  const asArray = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);

  let html = '';

  // ---- Registrar ----
  if (data.registrar || data.registrar_url || data.whois_server) {
    lines.push('');
    lines.push('=== Registrar ===');
    let registrarHtml = '';
    if (data.registrar) {
      registrarHtml += `<div style="font-weight:700;font-size:14px;color:var(--text);margin-bottom:4px">${escapeHtml(asArray(data.registrar)[0])}</div>`;
      lines.push('Registrar: ' + asArray(data.registrar)[0]);
    }
    if (data.registrar_url) {
      const url = asArray(data.registrar_url)[0];
      registrarHtml += `<div style="font-size:12px;color:var(--text-muted)">🔗 <a href="${escapeHtml(url.startsWith('http') ? url : 'http://' + url)}" target="_blank" rel="noopener" style="color:var(--primary);text-decoration:none">${escapeHtml(url)}</a></div>`;
      lines.push('Registrar URL: ' + url);
    }
    if (data.whois_server) {
      const ws = asArray(data.whois_server)[0];
      registrarHtml += `<div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">WHOIS server: <code style="font-family:ui-monospace,Menlo,monospace">${escapeHtml(ws)}</code></div>`;
      lines.push('WHOIS server: ' + ws);
    }
    html += renderWhoisSection('🏢 Registrar', registrarHtml);
  }

  // ---- Important dates ----
  const dates = [];
  if (data.creation_date)   dates.push({ label: 'จดทะเบียน', icon: '🟢', value: pickDate(data.creation_date, 'earliest'), key: 'created' });
  if (data.updated_date)    dates.push({ label: 'อัพเดตล่าสุด', icon: '🔄', value: pickDate(data.updated_date, 'latest'),    key: 'updated' });
  if (data.expiration_date) dates.push({ label: 'หมดอายุ',    icon: '⏰', value: pickDate(data.expiration_date, 'latest'), key: 'expires' });
  if (dates.length) {
    lines.push('');
    lines.push('=== Dates ===');
    let dateRows = '';
    for (const d of dates) {
      const formatted = fmtDate(d.value);
      const days = daysFromToday(d.value);
      let extra = '';
      if (d.key === 'expires' && days != null) {
        if (days < 0) extra = `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(220,38,38,.10);color:var(--critical);font-size:11px;font-weight:700;margin-left:8px">⛔ หมด ${-days} วันแล้ว</span>`;
        else if (days <= 30) extra = `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,.12);color:#92400e;font-size:11px;font-weight:700;margin-left:8px">⚠ เหลือ ${days} วัน</span>`;
        else extra = `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:rgba(16,185,129,.12);color:var(--green);font-size:11px;font-weight:700;margin-left:8px">เหลือ ${days} วัน</span>`;
      } else if (days != null && days < 0) {
        const ageYears = Math.abs(days) / 365;
        extra = `<span style="font-size:11px;color:var(--text-muted);margin-left:8px">${ageYears >= 1 ? ageYears.toFixed(1) + ' ปีที่แล้ว' : Math.abs(days) + ' วันที่แล้ว'}</span>`;
      }
      dateRows += `
        <div class="lookup-row" style="display:flex;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);font-size:13px">
          <span style="display:inline-block;width:130px;color:var(--text-muted);font-weight:600">${d.icon} ${escapeHtml(d.label)}</span>
          <span style="font-family:ui-monospace,Menlo,monospace;color:var(--text)">${escapeHtml(formatted || '—')}</span>
          ${extra}
        </div>
      `;
      lines.push(`  ${d.label.padEnd(15)}: ${formatted || '—'}`);
    }
    html += renderWhoisSection('📅 Important dates', `<div class="lookup-rows">${dateRows}</div>`, /*pad=*/false);
  }

  // ---- Name servers ----
  const nsList = asArray(data.name_servers).filter(Boolean);
  if (nsList.length) {
    lines.push('');
    lines.push('=== Name Servers ===');
    nsList.forEach(ns => lines.push('  ' + ns));
    const nsHtml = `
      <div class="lookup-rows" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px">
        ${nsList.map(ns => `<div class="lookup-row" style="padding:6px 12px;border-bottom:1px solid var(--border)">${escapeHtml(String(ns).toLowerCase())}</div>`).join('')}
      </div>
    `;
    html += renderWhoisSection(`🌐 Name servers (${nsList.length})`, nsHtml, /*pad=*/false);
  }

  // ---- Status ----
  const statusList = asArray(data.status).filter(Boolean);
  if (statusList.length) {
    lines.push('');
    lines.push('=== Status ===');
    statusList.forEach(s => lines.push('  ' + s));
    const statusHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${statusList.map(s => `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:var(--bg);border:1px solid var(--border);font-size:11.5px;font-family:ui-monospace,Menlo,monospace;color:var(--text)">🔒 ${escapeHtml(String(s).split(' ')[0])}</span>`).join('')}
      </div>
    `;
    html += renderWhoisSection('🔒 Status', statusHtml);
  }

  // ---- Other (org, country, dnssec, emails) ----
  const otherRows = [];
  if (data.org) otherRows.push({ label: 'Organization', value: asArray(data.org)[0], icon: '🏛' });
  if (data.country) otherRows.push({ label: 'Country', value: asArray(data.country)[0], icon: '🌍' });
  if (data.dnssec) otherRows.push({ label: 'DNSSEC', value: asArray(data.dnssec).join(', '), icon: '🛡' });
  if (data.emails) {
    const emails = asArray(data.emails).filter(Boolean);
    if (emails.length) otherRows.push({ label: 'Contact emails', value: emails.join(', '), icon: '📧' });
  }
  if (otherRows.length) {
    lines.push('');
    lines.push('=== Other ===');
    let other = '<div class="lookup-rows">';
    for (const r of otherRows) {
      lines.push(`  ${r.label}: ${r.value}`);
      other += `
        <div class="lookup-row" style="display:flex;align-items:flex-start;padding:7px 12px;border-bottom:1px solid var(--border);font-size:12.5px">
          <span style="display:inline-block;width:130px;color:var(--text-muted);font-weight:600;flex-shrink:0">${r.icon} ${escapeHtml(r.label)}</span>
          <span style="word-break:break-all">${escapeHtml(String(r.value))}</span>
        </div>
      `;
    }
    other += '</div>';
    html += renderWhoisSection('ℹ️ Other', other, /*pad=*/false);
  }

  // ---- Raw WHOIS (collapsible) ----
  if (data.raw) {
    html += renderWhoisRawSection(data.raw);
    lines.push('');
    lines.push('--- Raw WHOIS ---');
    lines.push(data.raw);
  }

  if (!html) {
    html = `<div class="empty">ไม่พบข้อมูล WHOIS</div>`;
  }
  return { html, text: lines.join('\n') };
}

function renderWhoisSection(title, innerHtml, pad) {
  const padInner = pad === false ? '0' : '12px 14px';
  return `
    <div style="margin-bottom:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:8px 14px;background:var(--bg);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px">${title}</div>
      <div style="padding:${padInner}">${innerHtml}</div>
    </div>
  `;
}

function renderWhoisRawSection(rawText) {
  return `
    <details style="margin-top:8px">
      <summary style="cursor:pointer;font-size:11.5px;font-weight:600;color:var(--text-muted);padding:8px 0">📜 Raw WHOIS output (กดเพื่อดู)</summary>
      <pre style="font-family:ui-monospace,Menlo,monospace;font-size:11px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--text-muted)">${escapeHtml(rawText)}</pre>
    </details>
  `;
}

function renderNslookupResult(data) {
  const lines = [];   // for copy
  lines.push('Domain: ' + data.domain);
  if (data.error) {
    lines.push('Error: ' + data.error);
    return {
      html: `
        <div style="background:rgba(220,38,38,.08);border:1px solid var(--critical);border-radius:8px;padding:14px;color:var(--critical);font-weight:600">
          ⛔ ${escapeHtml(data.error)}
        </div>
      `,
      text: lines.join('\n'),
    };
  }
  let html = '';
  // Hostname / aliases
  if (data.hostname) {
    lines.push('Hostname: ' + data.hostname);
    html += `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Hostname</div>
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;color:var(--text)">${escapeHtml(data.hostname)}</div>
      </div>
    `;
  }
  if (data.aliases && data.aliases.length) {
    lines.push('Aliases: ' + data.aliases.join(', '));
    html += `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Aliases (CNAME chain)</div>
        <div style="font-family:ui-monospace,Menlo,monospace;font-size:13px">
          ${data.aliases.map(a => `<div>${escapeHtml(a)}</div>`).join('')}
        </div>
      </div>
    `;
  }
  // IPv4 + reverse DNS
  if (data.ips && data.ips.length) {
    lines.push('');
    lines.push('IPv4 addresses:');
    html += `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">IPv4 + reverse DNS (PTR)</div>
        <div class="lookup-rows" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          ${data.ips.map(ip => {
            const rev = (data.reverse || []).find(r => r.ip === ip);
            const ptr = rev && rev.ptr ? rev.ptr : '— ไม่มี PTR';
            lines.push('  ' + ip + (rev && rev.ptr ? '   →  ' + rev.ptr : ''));
            return `
              <div class="lookup-row" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--border);font-family:ui-monospace,Menlo,monospace;font-size:13px">
                <span style="font-weight:600;color:var(--primary-dark)">${escapeHtml(ip)}</span>
                <span style="color:${rev && rev.ptr ? 'var(--text)' : 'var(--text-muted)'};font-size:12px">${escapeHtml(ptr)}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  } else {
    html += `<div class="empty" style="margin-bottom:14px">— ไม่มี IPv4</div>`;
  }
  // IPv6
  if (data.ipv6 && data.ipv6.length) {
    lines.push('');
    lines.push('IPv6 addresses:');
    html += `
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">IPv6</div>
        <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px">
          ${data.ipv6.map(ip => { lines.push('  ' + ip); return `<div>${escapeHtml(ip)}</div>`; }).join('')}
        </div>
      </div>
    `;
  }
  return { html, text: lines.join('\n') };
}

function renderDnsResult(data) {
  const lines = [];
  lines.push('Domain: ' + data.domain);
  lines.push('');
  const recs = data.records || {};
  const labels = {
    A: 'A (IPv4)',
    AAAA: 'AAAA (IPv6)',
    CNAME: 'CNAME (alias)',
    MX: 'MX (mail server)',
    NS: 'NS (name server)',
    TXT: 'TXT (text)',
    SOA: 'SOA (zone authority)',
  };
  const colors = {
    A: '#2563eb',
    AAAA: '#7c3aed',
    CNAME: '#0891b2',
    MX: '#db2777',
    NS: '#16a34a',
    TXT: '#ca8a04',
    SOA: '#64748b',
  };
  let html = '<div style="display:flex;flex-direction:column;gap:10px">';
  let totalRecords = 0;
  for (const [type, info] of Object.entries(recs)) {
    const records = info.records || [];
    const err = info.error;
    totalRecords += records.length;
    lines.push(`${type}:`);
    if (err) {
      lines.push('  (' + err + ')');
    } else if (records.length === 0) {
      lines.push('  (none)');
    } else {
      records.forEach(r => lines.push('  ' + r));
    }
    lines.push('');

    const color = colors[type] || '#64748b';
    const isEmpty = records.length === 0 && !err;
    html += `
      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg);border-bottom:${isEmpty ? '0' : '1px solid var(--border)'}">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color}"></span>
            <span style="font-weight:700;font-size:12.5px;color:var(--text)">${escapeHtml(type)}</span>
            <span style="font-size:11.5px;color:var(--text-muted)">${escapeHtml(labels[type] || type)}</span>
          </div>
          <span style="font-size:11px;color:var(--text-muted);font-weight:600">
            ${err ? '<span style="color:var(--critical)">⚠ ' + escapeHtml(err) + '</span>' : (records.length + ' record' + (records.length !== 1 ? 's' : ''))}
          </span>
        </div>
        ${records.length > 0 ? `
          <div class="lookup-rows" style="font-family:ui-monospace,Menlo,monospace;font-size:12.5px">
            ${records.map(r => `
              <div class="lookup-row" style="padding:6px 12px;border-bottom:1px solid var(--border);word-break:break-all">${escapeHtml(r)}</div>
            `).join('')}
          </div>
        ` : (err ? '' : `
          <div style="padding:8px 12px;font-size:11.5px;color:var(--text-muted);font-style:italic">— ไม่มี record</div>
        `)}
      </div>
    `;
  }
  html += '</div>';
  if (totalRecords === 0) {
    html += `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(245,158,11,.10);border:1px solid #f59e0b;border-radius:8px;font-size:12.5px;color:#92400e">
        ⚠ ไม่พบ DNS record ใด ๆ — domain อาจไม่ resolve / DNS server ไม่ตอบ / firewall block
      </div>
    `;
  }
  return { html, text: lines.join('\n') };
}

// State that persists across the lifetime of one open Domain edit modal.
// - whoisApplied{Register,Expire}: the date string set by clicking "ยืนยันใส่ค่านี้"
//   (null if WHOIS apply was never used in this session)
// - initial{Register,Expire}: value when modal opened (used to detect manual edits)
let _domainModalWhois = {
  initialRegister: '',
  initialExpire:   '',
  whoisAppliedRegister: null,
  whoisAppliedExpire:   null,
};

// v1.9.270 — reload หน้า Customer ที่เปิดอยู่ (Calendar / Websites / Services Config) หลังแก้/ลบ
async function _reloadCustomerAfterEdit() {
  if ($('cal-grid')) { if (typeof loadDomainsList === 'function') await loadDomainsList(); }
  else if ($('ws-list')) { if (typeof loadWebsites === 'function') await loadWebsites(); }
  else if ($('sc-content')) { if (typeof renderActiveScContent === 'function') await renderActiveScContent(); }
}

function showDomainModal(domain) {
  const isEdit = !!domain;
  // Reset modal state — record initial values to detect manual edits later
  _domainModalWhois = {
    initialRegister: isEdit ? (domain.register_date || '').slice(0, 10) : '',
    initialExpire:   isEdit ? (domain.expire_date || '').slice(0, 10) : '',
    whoisAppliedRegister: null,
    whoisAppliedExpire:   null,
  };
  showModal({
    slide: true,
    title: isEdit ? `แก้ไข Domain: ${domain.name}` : 'เพิ่ม Domain ใหม่',
    body: `
      <div class="field">
        <label>Domain name *</label>
        <input id="dm-name" type="text" value="${isEdit ? escapeHtml(domain.name) : ''}" placeholder="เช่น example.com" />
      </div>
      <div class="field">
        <label>จดทะเบียนกับ (Registrar / Provider)</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select id="dm-provider-select" style="flex:1;min-width:160px;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit"></select>
          <input id="dm-provider-other" type="text" placeholder="ชื่อผู้ให้บริการ..."
            style="flex:2;min-width:200px;display:none;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit" />
        </div>
        <div class="hint" style="font-size:11.5px;color:var(--text-muted);margin-top:4px">เลือกจาก dropdown หรือกด "อื่น ๆ" เพื่อกรอกชื่อเอง</div>
      </div>
      <!-- Logo / Profile image — วงกลม -->
      <div class="field">
        <label>โลโก้ (วงกลม)</label>
        <div style="display:flex;gap:14px;align-items:flex-start;margin-top:6px">
          <div id="dm-logo-preview" style="width:88px;height:88px;border-radius:50%;border:1.5px dashed var(--border);background:${(isEdit && domain.logo_data) ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
            ${(isEdit && domain.logo_data)
              ? `<img src="${domain.logo_data}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`
              : `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>โลโก้</span>`
            }
          </div>
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
            <button type="button" class="btn" id="dm-logo-upload-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">📷 อัพโหลดไฟล์...</button>
            <button type="button" class="btn" id="dm-logo-search-btn" style="font-size:12.5px;padding:7px 12px;text-align:left">🔍 ค้นหาโลโก้จาก domain</button>
            <button type="button" class="btn danger" id="dm-logo-remove-btn" style="font-size:12.5px;padding:7px 12px;text-align:left;${(isEdit && domain.logo_data) ? '' : 'display:none'}">🗑 ลบโลโก้</button>
            <input type="file" id="dm-logo-file-input" accept="image/*" style="display:none" />
          </div>
        </div>
        <input type="hidden" id="dm-logo-data" value="${escapeHtml((isEdit && domain.logo_data) || '')}" />
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:10px">
        <span style="font-size:12.5px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">📅 วันที่จดทะเบียน + วันหมดอายุ</span>
        <button type="button" id="dm-whois-btn" class="btn" style="font-size:11.5px;padding:4px 11px" title="ดึงวันจาก WHOIS">📥 ดึงจาก WHOIS</button>
      </div>
      <div id="dm-whois-result" style="display:none;margin-bottom:10px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="field">
          <label>วันที่จดทะเบียน</label>
          <input id="dm-register" type="date" value="${isEdit ? escapeHtml((domain.register_date || '').slice(0, 10)) : ''}" />
        </div>
        <div class="field">
          <label>วันหมดอายุ</label>
          <input id="dm-expire" type="date" value="${isEdit ? escapeHtml((domain.expire_date || '').slice(0, 10)) : ''}" />
        </div>
      </div>
      <div class="field">
        <label>สถานะลูกค้า</label>
        <select id="dm-customer-status" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          <option value="current" ${(!isEdit || domain.customer_status !== 'former') ? 'selected' : ''}>🟢 ลูกค้าปัจจุบัน</option>
          <option value="former" ${(isEdit && domain.customer_status === 'former') ? 'selected' : ''}>⚪ อดีตลูกค้า</option>
        </select>
      </div>
      <div class="field">
        <label>หมายเหตุ</label>
        <textarea id="dm-notes" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical">${isEdit ? escapeHtml(domain.notes || '') : ''}</textarea>
      </div>
      ${isEdit ? `<div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px"><button type="button" id="dm-delete" class="btn danger" style="font-size:12.5px;padding:7px 14px">🗑 ลบ domain นี้</button></div>` : ''}
    `,
    onSubmit: async () => {
      // Provider — เลือกจาก dropdown หรือกรอกเอง (โหมด '__other')
      let providerValue = '';
      const sel = $('dm-provider-select');
      const other = $('dm-provider-other');
      if (sel) {
        if (sel.value === '__other') {
          providerValue = (other ? other.value : '').trim();
        } else {
          providerValue = sel.value || '';
        }
      }

      const data = {
        name: $('dm-name').value.trim(),
        provider: providerValue || null,
        register_date: $('dm-register').value || null,
        expire_date: $('dm-expire').value || null,
        notes: $('dm-notes').value.trim() || null,
        customer_status: $('dm-customer-status') ? $('dm-customer-status').value : 'current',
      };
      if (!data.name) throw new Error('กรอก domain name');

      // Logo — ส่งเฉพาะถ้ามีการเปลี่ยนแปลงจาก initial
      const logoEl = $('dm-logo-data');
      if (logoEl) {
        const cur = logoEl.value;
        const initial = logoEl.dataset.initial || '';
        if (cur !== initial) {
          data.logo_data = cur;   // empty string = clear, otherwise = new
        }
      }

      // Resolve WHOIS sync flags by comparing current value to states tracked above:
      //   - field === whoisApplied (still has WHOIS value) → flag = true (set timestamp = now)
      //   - field !== initial (user manually changed)     → flag = false (clear timestamp)
      //   - field === initial (untouched)                 → omit flag (keep existing timestamp)
      const flagFor = (current, initial, whoisApplied) => {
        if (whoisApplied != null && current === whoisApplied) return true;
        if (current !== initial) return false;
        return undefined;   // untouched
      };
      const regFlag = flagFor(
        data.register_date || '',
        _domainModalWhois.initialRegister,
        _domainModalWhois.whoisAppliedRegister,
      );
      const expFlag = flagFor(
        data.expire_date || '',
        _domainModalWhois.initialExpire,
        _domainModalWhois.whoisAppliedExpire,
      );
      if (regFlag !== undefined) data.register_from_whois = regFlag;
      if (expFlag !== undefined) data.expire_from_whois = expFlag;

      const url = isEdit ? `/api/admin/domains/${domain.id}` : '/api/admin/domains';
      await fetchJson(url, {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      await _reloadCustomerAfterEdit();
    },
  });
  // wire the WHOIS-sync button (after modal is in DOM)
  $('dm-whois-btn').addEventListener('click', () => fetchWhoisAndPreview());
  // v1.9.270 — ปุ่มลบ domain (ย้ายจากแถวเข้ามาในแผง)
  const _dmDel = $('dm-delete');
  if (_dmDel) _dmDel.addEventListener('click', async () => {
    if (!confirm(`ลบ domain "${domain.name}"?\n\n(ประวัติการ renew ทั้งหมดจะถูกลบด้วย)`)) return;
    try {
      await fetchJson('/api/admin/domains/' + domain.id, { method: 'DELETE' });
      const bg = _dmDel.closest('.modal-bg'); if (bg) bg.querySelector('#m-cancel').click();
      await _reloadCustomerAfterEdit();
    } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  });

  // ---- Provider dropdown wiring ----
  // Populate options + เลือกค่าเดิม (ถ้าค่าเดิมไม่อยู่ในรายการ → switch เป็น "อื่น ๆ")
  const provSel = $('dm-provider-select');
  const provOther = $('dm-provider-other');
  if (provSel) {
    const initialProv = (isEdit ? (domain.provider || '') : '').trim();
    const allProviders = DOMAIN_PROVIDERS.slice();
    // กรณี value เดิมเป็น custom name → ถือเป็น "__other" + prefill text
    const isKnown = !initialProv || allProviders.some(p => p.toLowerCase() === initialProv.toLowerCase());
    let opts = `<option value="">— ไม่ระบุ —</option>`;
    for (const p of allProviders) {
      const sel = (p.toLowerCase() === initialProv.toLowerCase()) ? ' selected' : '';
      opts += `<option value="${escapeHtml(p)}"${sel}>${escapeHtml(p)}</option>`;
    }
    opts += `<option value="__other"${!isKnown && initialProv ? ' selected' : ''}>อื่น ๆ (กรอกชื่อ)</option>`;
    provSel.innerHTML = opts;

    if (provOther) {
      if (!isKnown && initialProv) {
        provOther.value = initialProv;
        provOther.style.display = '';
      } else {
        provOther.style.display = 'none';
      }
    }

    provSel.addEventListener('change', () => {
      if (!provOther) return;
      if (provSel.value === '__other') {
        provOther.style.display = '';
        provOther.focus();
      } else {
        provOther.style.display = 'none';
      }
    });
  }

  // ---- Logo wiring (mirror ของ Site logo modal) ----
  const dmLogoEl = $('dm-logo-data');
  if (dmLogoEl) dmLogoEl.dataset.initial = dmLogoEl.value;

  // Helper: เซ็ตค่า logo ในฟอร์ม (ใช้เป็น callback ให้ openCropModal/openLogoSearchModal)
  const setDmLogo = (dataUrl) => {
    const el = $('dm-logo-data');
    const preview = $('dm-logo-preview');
    const removeBtn = $('dm-logo-remove-btn');
    if (!el || !preview) return;
    el.value = dataUrl || '';
    if (dataUrl) {
      preview.style.background = 'var(--bg-card)';
      preview.innerHTML = `<img src="${dataUrl}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`;
      if (removeBtn) removeBtn.style.display = '';
    } else {
      preview.style.background = 'var(--bg-soft)';
      preview.innerHTML = `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>โลโก้</span>`;
      if (removeBtn) removeBtn.style.display = 'none';
    }
  };

  // Upload from file
  const dmFileInput = $('dm-logo-file-input');
  $('dm-logo-upload-btn').addEventListener('click', () => dmFileInput.click());
  dmFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => openCropModal(ev.target.result, setDmLogo);
    reader.readAsDataURL(file);
    dmFileInput.value = '';
  });

  // Search by domain (favicon services)
  $('dm-logo-search-btn').addEventListener('click', () => {
    const name = ($('dm-name').value || '').trim();
    if (!name) {
      alert('กรอก domain name ก่อน (เช่น example.com)');
      $('dm-name').focus();
      return;
    }
    openLogoSearchModal(name, setDmLogo);
  });

  // Remove
  $('dm-logo-remove-btn').addEventListener('click', () => {
    if (!confirm('ลบโลโก้ของ domain นี้?')) return;
    setDmLogo('');
  });
}

// Pull WHOIS for the name in dm-name and show a confirm preview that fills the date fields
async function fetchWhoisAndPreview() {
  const btn = $('dm-whois-btn');
  const result = $('dm-whois-result');
  const nameInput = $('dm-name');
  const name = (nameInput.value || '').trim();
  if (!name) {
    result.style.display = '';
    result.innerHTML = `<div style="background:rgba(245,158,11,.10);border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#92400e">⚠ กรอก <strong>Domain name</strong> ก่อนแล้วลองใหม่</div>`;
    nameInput.focus();
    return;
  }
  // loading
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '⏳ กำลังค้นหา…';
  result.style.display = '';
  result.innerHTML = `<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12.5px;color:var(--text-muted)">⏳ กำลังดึง WHOIS ของ <strong>${escapeHtml(name)}</strong>… (อาจใช้เวลา 3-10 วินาที)</div>`;
  try {
    const data = await fetchJson('/api/admin/domains/lookup/whois?name=' + encodeURIComponent(name));
    if (data.error) {
      const suggested = data.suggested_domain;
      const suggestBtn = suggested
        ? `<div style="margin-top:8px"><button type="button" id="dm-whois-retry" class="btn primary" style="font-size:12px;padding:5px 12px">↺ ลองค้นหาด้วย "${escapeHtml(suggested)}" แทน</button></div>`
        : '';
      result.innerHTML = `<div style="background:rgba(220,38,38,.08);border:1px solid var(--critical);border-radius:8px;padding:10px 12px;font-size:12.5px;color:var(--critical);white-space:pre-wrap">⛔ WHOIS ผิดพลาด: ${escapeHtml(data.error)}${suggestBtn}</div>`;
      if (suggested) {
        $('dm-whois-retry').addEventListener('click', () => {
          $('dm-name').value = suggested;
          fetchWhoisAndPreview();
        });
      }
      return;
    }
    // pick best date out of arrays — earliest creation, latest expiration
    const pickDate = (v, prefer) => {
      if (v == null) return null;
      if (!Array.isArray(v)) return v;
      const valids = v.filter(x => x && !isNaN(new Date(x).getTime()));
      if (valids.length === 0) return null;
      valids.sort((a, b) => new Date(a) - new Date(b));
      return prefer === 'earliest' ? valids[0] : valids[valids.length - 1];
    };
    const isoDay = (s) => {
      if (!s) return '';
      const d = new Date(s);
      if (isNaN(d.getTime())) return '';
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dy = String(d.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${dy}`;
    };
    const created = pickDate(data.creation_date, 'earliest');
    const expires = pickDate(data.expiration_date, 'latest');
    const createdDay = isoDay(created);
    const expiresDay = isoDay(expires);
    const registrar = Array.isArray(data.registrar) ? data.registrar[0] : data.registrar;

    if (!createdDay && !expiresDay) {
      result.innerHTML = `<div style="background:rgba(245,158,11,.10);border:1px solid #f59e0b;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#92400e">⚠ WHOIS ตอบ แต่ไม่พบ creation_date/expiration_date — TLD นี้อาจไม่ส่งวันที่ผ่าน WHOIS</div>`;
      return;
    }

    // diff against current values
    const currentReg = ($('dm-register').value || '').slice(0, 10);
    const currentExp = ($('dm-expire').value || '').slice(0, 10);
    const regChanged = createdDay && currentReg !== createdDay;
    const expChanged = expiresDay && currentExp !== expiresDay;

    const dateRow = (label, icon, currentVal, newVal, changed) => {
      if (!newVal) return `
        <tr><td style="padding:4px 8px;color:var(--text-muted);font-size:11.5px">${icon} ${label}</td>
        <td colspan="2" style="padding:4px 8px;color:var(--text-muted);font-style:italic;font-size:12px">— WHOIS ไม่มีค่านี้</td></tr>
      `;
      const arrow = currentVal && currentVal !== newVal ? `<span style="color:var(--text-muted);margin:0 6px">→</span><span style="color:var(--text-muted);text-decoration:line-through;font-family:ui-monospace,Menlo,monospace;font-size:11.5px">${escapeHtml(currentVal)}</span>` : '';
      const changeBadge = changed ? `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:rgba(245,158,11,.15);color:#92400e;font-size:10.5px;font-weight:700;margin-left:8px">เปลี่ยน</span>` : (currentVal === newVal ? `<span style="display:inline-block;padding:1px 7px;border-radius:999px;background:rgba(16,185,129,.10);color:var(--green);font-size:10.5px;font-weight:700;margin-left:8px">ตรงกัน</span>` : '');
      return `
        <tr>
          <td style="padding:5px 8px;color:var(--text-muted);font-size:11.5px;white-space:nowrap">${icon} ${label}</td>
          <td style="padding:5px 8px;font-family:ui-monospace,Menlo,monospace;font-size:13px;font-weight:700;color:var(--text)">${escapeHtml(newVal)}${changeBadge}</td>
          <td style="padding:5px 8px;font-size:11px;color:var(--text-muted);text-align:right;white-space:nowrap">${arrow ? 'เดิม:' + arrow : ''}</td>
        </tr>
      `;
    };

    const anyChange = regChanged || expChanged;
    const hint = anyChange
      ? `<div style="font-size:11.5px;color:#92400e;margin-bottom:6px">💡 มีค่าที่จะเปลี่ยน — ตรวจสอบแล้วกด <strong>ยืนยัน</strong> เพื่อใส่ค่านี้ลงในฟอร์ม</div>`
      : `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:6px">✓ ค่าตรงกับฟอร์มปัจจุบัน</div>`;

    result.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:12.5px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">📋 WHOIS ตอบ</strong>
          ${registrar ? `<span style="font-size:11.5px;color:var(--text-muted)">🏢 ${escapeHtml(String(registrar))}</span>` : ''}
        </div>
        ${hint}
        <table style="width:100%;border-collapse:collapse">
          ${dateRow('จดทะเบียน', '📅', currentReg, createdDay, regChanged)}
          ${dateRow('หมดอายุ',   '⏰', currentExp, expiresDay, expChanged)}
        </table>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">
          <button type="button" id="dm-whois-cancel" class="btn" style="font-size:12px;padding:5px 12px">✕ ยกเลิก</button>
          <button type="button" id="dm-whois-apply" class="btn primary" style="font-size:12px;padding:5px 14px"${(!createdDay && !expiresDay) ? ' disabled' : ''}>✅ ยืนยันใส่ค่านี้</button>
        </div>
      </div>
    `;
    $('dm-whois-cancel').addEventListener('click', () => {
      result.style.display = 'none';
      result.innerHTML = '';
    });
    $('dm-whois-apply').addEventListener('click', () => {
      if (createdDay) {
        $('dm-register').value = createdDay;
        _domainModalWhois.whoisAppliedRegister = createdDay;
      }
      if (expiresDay) {
        $('dm-expire').value = expiresDay;
        _domainModalWhois.whoisAppliedExpire = expiresDay;
      }
      // Auto-fill provider too if it was empty
      const providerInput = $('dm-provider');
      if (registrar && !providerInput.value.trim()) {
        providerInput.value = String(registrar);
      }
      result.innerHTML = `
        <div style="background:rgba(16,185,129,.10);border:1px solid var(--green);border-radius:8px;padding:10px 12px;font-size:12.5px;color:var(--green);font-weight:600">
          ✅ ใส่ค่าจาก WHOIS เรียบร้อย — กด <strong>บันทึก</strong> เพื่อ save
        </div>
      `;
    });
  } catch (e) {
    result.innerHTML = `<div style="background:rgba(220,38,38,.08);border:1px solid var(--critical);border-radius:8px;padding:10px 12px;font-size:12.5px;color:var(--critical)">⛔ ดึง WHOIS ไม่ได้: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function showRenewModal(domainId, domainName, currentExpire) {
  showModal({
    title: `🔄 Renew: ${domainName}`,
    size: 'wide',
    body: `
      <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:12.5px">
        บันทึกการ renew — กรอกวันหมดอายุใหม่ พร้อมแนบใบเสร็จ (PDF/รูปภาพ)
      </div>
      <div class="field-grid-2">
        <div class="field">
          <label>วันหมดอายุเดิม</label>
          <input type="text" value="${escapeHtml(currentExpire || '—')}" disabled style="background:var(--bg-soft);color:var(--text-muted)" />
        </div>
        <div class="field">
          <label>วันหมดอายุใหม่ *</label>
          <input id="rm-expire" type="date" required />
        </div>
        <div class="field">
          <label>ค่าใช้จ่าย</label>
          <input id="rm-cost" type="number" min="0" step="0.01" placeholder="เช่น 350" />
        </div>
        <div class="field">
          <label>สกุลเงิน</label>
          <select id="rm-currency" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
            ${['THB','USD','EUR','GBP'].map(c => `<option value="${c}" ${c === 'THB' ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field field-span-2">
          <label>ใบเสร็จ (PDF / รูป) <span style="color:var(--text-muted);font-weight:400">— ไม่บังคับ, สูงสุด 2 MB</span></label>
          <input id="rm-receipt" type="file" accept="image/*,application/pdf" style="width:100%;padding:8px;font-size:13px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input)" />
          <div id="rm-receipt-preview" class="hint" style="margin-top:6px;font-size:11.5px;color:var(--text-muted)"></div>
        </div>
        <div class="field field-span-2">
          <label>หมายเหตุ</label>
          <textarea id="rm-note" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical"></textarea>
        </div>
      </div>
    `,
    onSubmit: async () => {
      const newExpire = $('rm-expire').value;
      if (!newExpire) throw new Error('กรอกวันหมดอายุใหม่');
      const file = $('rm-receipt').files[0];
      let receiptData = null, receiptName = null, receiptType = null;
      if (file) {
        if (file.size > 2_000_000) throw new Error('ไฟล์ใหญ่เกิน 2 MB');
        receiptData = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        receiptName = file.name;
        receiptType = file.type;
      }
      const cost = $('rm-cost').value;
      await fetchJson(`/api/admin/domains/${domainId}/renew`, {
        method: 'POST',
        body: JSON.stringify({
          new_expire_date: newExpire,
          receipt_data: receiptData,
          receipt_name: receiptName,
          receipt_type: receiptType,
          cost_amount: cost ? parseFloat(cost) : null,
          cost_currency: $('rm-currency').value || 'THB',
          note: $('rm-note').value.trim() || null,
        }),
      });
      await loadDomainsConfigList();
    },
  });
  // file preview
  setTimeout(() => {
    const f = $('rm-receipt');
    const preview = $('rm-receipt-preview');
    if (f) f.addEventListener('change', () => {
      const file = f.files[0];
      if (file) {
        const sizeKB = Math.round(file.size / 1024);
        preview.innerHTML = `📎 ${escapeHtml(file.name)} (${sizeKB} KB)`;
        preview.style.color = file.size > 2_000_000 ? 'var(--critical)' : 'var(--green)';
      } else {
        preview.textContent = '';
      }
    });
  }, 0);
}

async function showRenewalHistoryModal(domainId, domainName) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `
    <div class="modal modal-wide">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h3 style="margin:0;font-size:17px;font-weight:700">📜 ประวัติการ Renew: ${escapeHtml(domainName)}</h3>
        <button class="btn" id="rh-close" style="font-size:13px;padding:6px 14px">✕ ปิด</button>
      </div>
      <div id="rh-list"><div class="empty">กำลังโหลด…</div></div>
    </div>
  `;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('#rh-close').addEventListener('click', close);
  bg.addEventListener('click', e => { if (e.target === bg) close(); });

  let data;
  try {
    data = await fetchJson(`/api/admin/domains/${domainId}/renewals`);
  } catch (e) {
    bg.querySelector('#rh-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  const renewals = data.renewals || [];
  if (renewals.length === 0) {
    bg.querySelector('#rh-list').innerHTML = `<div class="empty" style="padding:30px">ยังไม่มีประวัติการ renew</div>`;
    return;
  }
  bg.querySelector('#rh-list').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow-y:auto">
      ${renewals.map(r => {
        const renewedDate = new Date(r.renewed_at).toLocaleString('th-TH', {
          day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        return `
          <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
              <div style="flex:1;min-width:200px">
                <div style="font-weight:600;font-size:13.5px">🔄 ${escapeHtml(renewedDate)}</div>
                <div style="font-size:12.5px;color:var(--text-muted);margin-top:3px">
                  ${r.old_expire_date ? `จาก ${escapeHtml(fmtDateThai(r.old_expire_date))} → ` : ''}<strong>${escapeHtml(fmtDateThai(r.new_expire_date))}</strong>
                </div>
                ${r.cost_amount != null ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px">💵 ${r.cost_amount.toLocaleString('th-TH')} ${escapeHtml(r.cost_currency || 'THB')}</div>` : ''}
                ${r.note ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;font-style:italic">📝 ${escapeHtml(r.note)}</div>` : ''}
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                ${r.has_receipt ? `<button class="btn" data-r-receipt="${r.id}" data-r-name="${escapeHtml(r.receipt_name || 'receipt')}" style="font-size:11.5px;padding:5px 10px">📎 ${escapeHtml(r.receipt_name || 'ใบเสร็จ')}</button>` : ''}
                <button class="btn danger" data-r-delete="${r.id}" style="font-size:11.5px;padding:5px 10px">🗑</button>
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  // wire receipt + delete
  bg.querySelectorAll('button[data-r-receipt]').forEach(b => {
    b.addEventListener('click', async () => {
      const rid = parseInt(b.dataset.rReceipt, 10);
      try {
        const r = await fetchJson(`/api/admin/domains/renewals/${rid}/receipt`);
        // เปิด data URL ใน tab ใหม่
        const w = window.open('', '_blank');
        if (w) {
          if ((r.receipt_type || '').startsWith('image/')) {
            w.document.write(`<title>${escapeHtml(r.receipt_name || 'receipt')}</title><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="${r.receipt_data}" style="max-width:100%;max-height:100vh"/></body>`);
          } else {
            w.location.href = r.receipt_data;
          }
        }
      } catch (e) { alert('ดึงไม่สำเร็จ: ' + e.message); }
    });
  });
  bg.querySelectorAll('button[data-r-delete]').forEach(b => {
    b.addEventListener('click', async () => {
      if (!confirm('ลบ renewal record นี้?\n\n(หมายเหตุ: expire_date ของ domain จะไม่ถูก rollback ต้องไปแก้เอง)')) return;
      const rid = parseInt(b.dataset.rDelete, 10);
      try {
        await fetchJson(`/api/admin/domains/renewals/${rid}`, { method: 'DELETE' });
        showRenewalHistoryModal(domainId, domainName);   // reload modal
        bg.remove();
      } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
    });
  });
}


// ============== Services Config (Hosting / SSL / Others — admin only) ==============

// Tabs ของ Services Config — รวม Domain เป็น tab แรก
// Common domain registrars — แสดงใน Domain edit dropdown + filter ใน Websites
const DOMAIN_PROVIDERS = [
  'HostAtom',
  'DotArai',
  'GoDaddy',
  'Namecheap',
  'Cloudflare',
  'Google Domains',
  'Z.com',
];

const SERVICE_TYPES = [
  { id: 'domain',  label: 'Domain',   icon: '🌐',  isDomain: true,
    addLabel: '+ เพิ่ม Domain',  emptyText: 'ยังไม่มี Domain' },
  { id: 'hosting', label: 'Hosting',  icon: '🖥️',
    addLabel: '+ เพิ่ม Hosting', emptyText: 'ยังไม่มี Hosting service' },
  { id: 'ssl',     label: 'SSL',      icon: '🔒',
    addLabel: '+ เพิ่ม SSL',     emptyText: 'ยังไม่มี SSL certificate' },
  { id: 'others',  label: 'Others',   icon: '📦',
    addLabel: '+ เพิ่ม Others',  emptyText: 'ยังไม่มี service อื่น ๆ' },
];

let _svcCache = { hosting: [], ssl: [], others: [] };
let _svcSearch = '';
// Active tab ของ Services Config — default = 'domain'
let _scActiveTab = 'domain';

async function renderServicesConfigPage() {
  const tab = SERVICE_TYPES.find(t => t.id === _scActiveTab) || SERVICE_TYPES[0];
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🛠️ Services Config</h2>
      <button class="btn primary" id="sc-add-btn">${escapeHtml(tab.addLabel)}</button>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      จัดการ Domain / Hosting / SSL / Others — จับคู่ Domain กับ services ได้ที่ <a href="#/websites" style="color:var(--primary)">Websites</a>
    </div>
    <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:14px;flex-wrap:wrap">
      ${SERVICE_TYPES.map(t => `
        <button class="sc-tab" data-sc-tab="${t.id}" style="background:transparent;border:none;border-bottom:2px solid transparent;padding:9px 16px;font-size:13px;font-weight:600;color:var(--text-muted);cursor:pointer;font-family:inherit;transition:color .15s,border-color .15s">${t.icon} ${t.label}</button>
      `).join('')}
    </div>
    <div id="sc-content"></div>
  `;
  // wire tabs
  document.querySelectorAll('.sc-tab').forEach(b => {
    b.addEventListener('click', async () => {
      _scActiveTab = b.dataset.scTab;
      _updateScTabsUI();
      _updateScAddButton();
      await renderActiveScContent();
    });
  });
  $('sc-add-btn').addEventListener('click', _onScAddClick);
  _updateScTabsUI();
  await renderActiveScContent();
}

function _updateScTabsUI() {
  document.querySelectorAll('.sc-tab').forEach(b => {
    const isActive = b.dataset.scTab === _scActiveTab;
    b.style.color = isActive ? 'var(--primary)' : 'var(--text-muted)';
    b.style.borderBottomColor = isActive ? 'var(--primary)' : 'transparent';
  });
}

function _updateScAddButton() {
  const tab = SERVICE_TYPES.find(t => t.id === _scActiveTab) || SERVICE_TYPES[0];
  if ($('sc-add-btn')) $('sc-add-btn').textContent = tab.addLabel;
}

function _onScAddClick() {
  if (_scActiveTab === 'domain') {
    showDomainModal(null);
  } else {
    showServiceModal(null, _scActiveTab);
  }
}

async function renderActiveScContent() {
  const c = $('sc-content');
  if (!c) return;
  if (_scActiveTab === 'domain') {
    // Domain tab — ใช้ helpers ที่ extract มาจาก renderDomainsConfigPage เดิม
    c.innerHTML = _buildDomainTabBodyHTML();
    _wireDomainTab();
    await loadDomainsConfigList();
  } else {
    // Service tab (hosting/ssl/others) — ใช้ logic เดิม
    c.innerHTML = `
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
        <div style="flex:1;min-width:240px;position:relative">
          <input id="svc-search" type="text" placeholder="🔍 ค้นหาชื่อ / provider / note..." autocomplete="off"
            style="width:100%;padding:8px 32px 8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
        </div>
        <span id="svc-count" style="color:var(--text-muted);font-size:12.5px;font-weight:600;white-space:nowrap">— รายการ</span>
      </div>
      <div id="svc-list"><div class="empty">กำลังโหลด…</div></div>
    `;
    // Reset search ตอน switch tab — ป้องกันค่า search ของ tab เดิมไป filter tab ใหม่
    _svcSearch = '';
    $('svc-search').value = '';
    $('svc-search').addEventListener('input', e => {
      _svcSearch = e.target.value;
      renderServicesRows();
    });
    await loadAllServices();
  }
}

async function loadAllServices() {
  // 1 endpoint, filter on client → simpler, only needs 1 query
  let data;
  try {
    data = await fetchJson('/api/admin/services');
  } catch (e) {
    if ($('svc-list')) $('svc-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _svcCache = { hosting: [], ssl: [], others: [] };
  for (const s of (data.services || [])) {
    if (_svcCache[s.service_type]) _svcCache[s.service_type].push(s);
  }
  renderServicesRows();
}

function renderServicesRows() {
  const listEl = $('svc-list');
  if (!listEl) return;
  const tab = SERVICE_TYPES.find(t => t.id === _scActiveTab);
  const all = _svcCache[_scActiveTab] || [];
  const q = _svcSearch.trim().toLowerCase();
  const list = !q ? all : all.filter(s =>
    (s.name || '').toLowerCase().includes(q)
    || (s.provider || '').toLowerCase().includes(q)
    || (s.notes || '').toLowerCase().includes(q)
  );
  if ($('svc-count')) {
    $('svc-count').textContent = q
      ? `${list.length} / ${all.length} รายการ`
      : `${all.length} รายการ`;
  }
  if (all.length === 0) {
    listEl.innerHTML = `<div class="empty">${escapeHtml(tab.emptyText)} — กด <strong>+ เพิ่ม Service</strong></div>`;
    return;
  }
  if (list.length === 0) {
    listEl.innerHTML = `<div class="empty">ไม่พบ service ที่ตรงกับ "<strong>${escapeHtml(_svcSearch)}</strong>"</div>`;
    return;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // v1.9.271 — table layout
  listEl.innerHTML = `<div class="cfg-table-wrap"><div class="cfg-table-scroll"><table class="cfg-table">
    <thead><tr>
      <th>บริการ</th><th>สถานะ</th><th>ราคา</th><th>วันหมดอายุ</th><th>Domain ที่ผูก</th><th style="text-align:right">จัดการ</th>
    </tr></thead>
    <tbody>${list.map(s => renderServiceRow(s, today, tab.icon)).join('')}</tbody>
  </table></div></div>`;
  // คลิกแถว = แก้ไข · ⋮ kebab = แก้ไข/ลบ
  listEl.querySelectorAll('tr[data-svc-row]').forEach(row => {
    row.addEventListener('click', () => {
      const s = (_svcCache[_scActiveTab] || []).find(x => x.id === parseInt(row.dataset.svcRow, 10));
      if (s) showServiceModal(s, _scActiveTab);
    });
  });
  listEl.querySelectorAll('[data-svc-kebab]').forEach(btn => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const s = (_svcCache[_scActiveTab] || []).find(x => x.id === parseInt(btn.dataset.svcKebab, 10));
    if (!s) return;
    _kebabMenu(btn, [
      { icon: '✏️', label: 'แก้ไข', onClick: () => showServiceModal(s, _scActiveTab) },
      { icon: '🗑', label: 'ลบ', danger: true, onClick: () => handleServiceAction({ dataset: { svcId: String(s.id), svcAct: 'delete', svcName: s.name, svcLinked: String(s.linked_domains || 0) } }) },
    ]);
  }));
}

function renderServiceRow(s, today, typeIcon) {
  let statusBadge = '<span style="color:var(--text-muted);font-size:11px">— ไม่มีวันหมดอายุ</span>';
  let expStyle = 'color:var(--text-muted)';
  if (s.expire_date) {
    const exp = new Date(s.expire_date);
    const days = Math.floor((exp - today) / 86400000);
    if (days < 0) {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(220,38,38,.10);color:var(--critical)">⛔ หมด ${-days} วันแล้ว</span>`;
      expStyle = 'color:var(--critical);font-weight:700';
    } else if (days <= 30) {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(245,158,11,.12);color:#92400e">⚠ เหลือ ${days} วัน</span>`;
      expStyle = 'color:#b45309;font-weight:600';
    } else {
      statusBadge = `<span style="display:inline-flex;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green)">✓ เหลือ ${days} วัน</span>`;
      expStyle = 'color:var(--text)';
    }
  }
  let subLine = '';
  if (s.provider) subLine = `🏢 ${escapeHtml(s.provider)}`;
  else if (s.notes) subLine = `<span title="${escapeHtml(s.notes)}">📝 ${escapeHtml(s.notes.length > 40 ? s.notes.slice(0, 37) + '…' : s.notes)}</span>`;
  return `
    <tr data-svc-row="${s.id}" title="คลิกเพื่อแก้ไข">
      <td>
        <div style="display:flex;align-items:center;gap:10px;min-width:190px">
          <span style="font-size:20px;flex-shrink:0">${typeIcon}</span>
          <div style="min-width:0">
            <div style="font-weight:700;font-size:13.5px;color:var(--text)">${escapeHtml(s.name)}</div>
            ${subLine ? `<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:230px">${subLine}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${statusBadge}</td>
      <td style="white-space:nowrap;color:var(--text-muted)">${s.price != null ? escapeHtml(fmtMoneyOrNumber(s.price)) + ' ' + escapeHtml(s.currency || 'THB') : '—'}</td>
      <td style="white-space:nowrap;${expStyle}">${s.expire_date ? escapeHtml(fmtDateThai(s.expire_date)) : '—'}</td>
      <td style="white-space:nowrap">${s.linked_domains > 0 ? `<span style="color:var(--primary);font-weight:600">🔗 ${s.linked_domains}</span>` : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td style="text-align:right;white-space:nowrap"><button type="button" class="kebab-btn" data-svc-kebab="${s.id}" title="เมนู">⋮</button></td>
    </tr>
  `;
}

function fmtMoneyOrNumber(n) {
  if (n == null) return '—';
  try { return Number(n).toLocaleString('th-TH', { maximumFractionDigits: 2 }); }
  catch { return String(n); }
}

async function handleServiceAction(btn) {
  const id = parseInt(btn.dataset.svcId, 10);
  const act = btn.dataset.svcAct;
  if (act === 'edit') {
    const list = _svcCache[_scActiveTab] || [];
    const s = list.find(x => x.id === id);
    if (s) showServiceModal(s, _scActiveTab);
  } else if (act === 'delete') {
    const name = btn.dataset.svcName;
    const linked = parseInt(btn.dataset.svcLinked, 10) || 0;
    const warn = linked > 0 ? `\n\n⚠ service นี้ผูกอยู่กับ ${linked} domain — การลบจะตัดความเชื่อมโยงทั้งหมด` : '';
    if (!confirm(`ลบ service "${name}"?${warn}`)) return;
    try {
      await fetchJson('/api/admin/services/' + id, { method: 'DELETE' });
      await loadAllServices();
    } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
  }
}

function showServiceModal(svc, defaultType) {
  const isEdit = !!svc;
  const t = svc ? svc.service_type : (defaultType || 'hosting');
  let _svcmDomLoaded = false;   // v1.9.269
  showModal({
    slide: true,
    title: isEdit ? `แก้ไข ${SERVICE_TYPES.find(x => x.id === svc.service_type)?.label || 'Service'}: ${svc.name}` : '+ เพิ่ม Service ใหม่',
    body: `
      ${isEdit ? `<div style="display:flex;gap:18px;border-bottom:1px solid var(--border);margin-bottom:14px">
        <button type="button" class="svcm-tab" data-svcm-tab="form" style="background:none;border:none;border-bottom:2px solid var(--primary);color:var(--text);font-weight:600;font-size:13px;padding:8px 2px;cursor:pointer;font-family:inherit">ข้อมูล</button>
        <button type="button" class="svcm-tab" data-svcm-tab="domains" style="background:none;border:none;border-bottom:2px solid transparent;color:var(--text-muted);font-weight:600;font-size:13px;padding:8px 2px;cursor:pointer;font-family:inherit">🔗 Domain ที่ผูก (${svc.linked_domains || 0})</button>
      </div>` : ''}
      <div data-svcm-pane="form">
      <div class="field">
        <label>ประเภท *</label>
        <select id="sm-type" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          ${SERVICE_TYPES.map(x => `<option value="${x.id}"${x.id === t ? ' selected' : ''}>${x.icon} ${x.label}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>ชื่อบริการ *</label>
        <input id="sm-name" type="text" value="${isEdit ? escapeHtml(svc.name) : ''}" placeholder="เช่น DigitalOcean Droplet, Let's Encrypt" />
      </div>
      <div class="field">
        <label>Provider (ผู้ให้บริการ)</label>
        <input id="sm-provider" type="text" value="${isEdit ? escapeHtml(svc.provider || '') : ''}" placeholder="เช่น DigitalOcean, AWS, Cloudflare" />
      </div>
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">
        <div class="field">
          <label>ราคา</label>
          <input id="sm-price" type="number" step="0.01" min="0" value="${isEdit && svc.price != null ? svc.price : ''}" placeholder="0.00" />
        </div>
        <div class="field">
          <label>สกุลเงิน</label>
          <select id="sm-currency" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
            <option value="THB"${(isEdit && svc.currency === 'THB') || !isEdit ? ' selected' : ''}>THB</option>
            <option value="USD"${isEdit && svc.currency === 'USD' ? ' selected' : ''}>USD</option>
            <option value="EUR"${isEdit && svc.currency === 'EUR' ? ' selected' : ''}>EUR</option>
          </select>
        </div>
        <div class="field">
          <label>วันหมดอายุ</label>
          <input id="sm-expire" type="date" value="${isEdit ? escapeHtml((svc.expire_date || '').slice(0, 10)) : ''}" />
        </div>
      </div>
      <div class="field">
        <label>หมายเหตุ</label>
        <textarea id="sm-notes" rows="2" style="width:100%;padding:9px 12px;font-size:13.5px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit;resize:vertical">${isEdit ? escapeHtml(svc.notes || '') : ''}</textarea>
      </div>
      </div><!-- /form pane -->
      ${isEdit ? `
      <div data-svcm-pane="domains" style="display:none"><div id="svcm-domains"><div class="empty" style="padding:16px;font-size:12.5px">กำลังโหลด…</div></div></div>
      <div style="margin-top:18px;border-top:1px solid var(--border);padding-top:14px">
        <button type="button" id="svcm-delete" class="btn danger" style="font-size:12.5px;padding:7px 14px">🗑 ลบ service นี้</button>
      </div>` : ''}
    `,
    onSubmit: async () => {
      const data = {
        service_type: $('sm-type').value,
        name: $('sm-name').value.trim(),
        provider: $('sm-provider').value.trim() || null,
        price: $('sm-price').value ? parseFloat($('sm-price').value) : null,
        currency: $('sm-currency').value,
        expire_date: $('sm-expire').value || null,
        notes: $('sm-notes').value.trim() || null,
      };
      if (!data.name) throw new Error('กรอกชื่อบริการ');
      const url = isEdit ? `/api/admin/services/${svc.id}` : '/api/admin/services';
      await fetchJson(url, {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      // หากเปลี่ยน type → switch tab ให้ + rebuild content
      _scActiveTab = data.service_type;
      _updateScTabsUI();
      _updateScAddButton();
      await _reloadCustomerAfterEdit();
    },
  });
  // v1.9.269 — แท็บ Domain ที่ผูก + ปุ่มลบ (edit เท่านั้น)
  if (isEdit) setTimeout(() => {
    const tabs = Array.from(document.querySelectorAll('.svcm-tab'));
    const panes = {
      form: document.querySelector('[data-svcm-pane="form"]'),
      domains: document.querySelector('[data-svcm-pane="domains"]'),
    };
    const loadDomains = async () => {
      const box = document.querySelector('#svcm-domains');
      if (!box) return;
      let doms = [];
      try { doms = (await fetchJson('/api/admin/services/' + svc.id + '/domains')).domains || []; }
      catch (e) { box.innerHTML = '<div class="empty" style="padding:14px;font-size:12.5px">โหลดไม่สำเร็จ</div>'; return; }
      box.innerHTML = doms.length
        ? doms.map(d => `<div style="display:flex;align-items:center;gap:9px;padding:9px 11px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px"><span style="font-size:15px;flex-shrink:0">🌐</span><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(d.name)}</div>${d.expire_date ? `<div style="font-size:11px;color:var(--text-muted)">⏰ หมด ${escapeHtml(fmtDateThai(d.expire_date))}</div>` : ''}</div></div>`).join('')
        : '<div class="empty" style="padding:18px;font-size:12.5px">— ยังไม่มี domain ผูกกับ service นี้ —<br><span style="font-size:11px">ผูก domain ได้ที่หน้า Websites</span></div>';
    };
    tabs.forEach(tb => tb.addEventListener('click', () => {
      const key = tb.dataset.svcmTab;
      tabs.forEach(x => { const on = x === tb; x.style.borderBottomColor = on ? 'var(--primary)' : 'transparent'; x.style.color = on ? 'var(--text)' : 'var(--text-muted)'; });
      Object.entries(panes).forEach(([k, el]) => { if (el) el.style.display = k === key ? '' : 'none'; });
      if (key === 'domains' && !_svcmDomLoaded) { _svcmDomLoaded = true; loadDomains(); }
    }));
    const delBtn = document.querySelector('#svcm-delete');
    if (delBtn) delBtn.addEventListener('click', async () => {
      const linked = svc.linked_domains || 0;
      const warn = linked > 0 ? `\n\n⚠ ผูกอยู่กับ ${linked} domain — การลบจะตัดความเชื่อมโยงทั้งหมด` : '';
      if (!confirm(`ลบ service "${svc.name}"?${warn}`)) return;
      try {
        await fetchJson('/api/admin/services/' + svc.id, { method: 'DELETE' });
        const bg = delBtn.closest('.modal-bg'); if (bg) bg.querySelector('#m-cancel').click();
        await _reloadCustomerAfterEdit();
      } catch (e) { alert('ลบไม่สำเร็จ: ' + e.message); }
    });
  }, 0);
}


// ============== Websites — pair Domain with Hosting/SSL/Others ==============

let _wsCache = [];
let _wsSearch = '';
// Filter state — '' = ทุกตัว, '__none' = "ยังไม่มีผูก", หรือชื่อ specific (เป็นข้อความ)
let _wsFilter = { registrar: '', hosting: '', ssl: '', others: '' };

async function renderWebsitesPage() {
  _subMain().innerHTML = `
    <div class="page-head">
      <h2 class="page-title">🔗 Websites</h2>
      <span class="card-sub" id="ws-count">—</span>
    </div>
    <div class="hint" style="margin-bottom:14px;color:var(--text-muted);font-size:13px">
      จับคู่ <strong>Domain</strong> กับ <strong>Hosting / SSL / Others</strong> — เพิ่ม Domain ที่ <a href="#/services-config" style="color:var(--primary)">Services Config</a> (Domain tab), เพิ่ม service ที่ <a href="#/services-config" style="color:var(--primary)">Services Config</a>
    </div>
    <div style="margin-bottom:10px">
      <input id="ws-search" type="text" placeholder="🔍 ค้นหาชื่อ domain / service..." autocomplete="off"
        style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg-card);color:var(--text);box-sizing:border-box" />
    </div>
    <!-- Filters: registrar / hosting / ssl / others -->
    <div id="ws-filters" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      <span style="font-size:11.5px;color:var(--text-muted);font-weight:600;letter-spacing:.4px">FILTER:</span>
      <select id="ws-filter-registrar" class="ws-filter-sel"></select>
      <select id="ws-filter-hosting" class="ws-filter-sel"></select>
      <select id="ws-filter-ssl" class="ws-filter-sel"></select>
      <select id="ws-filter-others" class="ws-filter-sel"></select>
      <button id="ws-filter-clear" class="btn" type="button" style="font-size:11.5px;padding:5px 10px;display:none">✕ ล้าง filter</button>
    </div>
    <div id="ws-list"><div class="empty">กำลังโหลด…</div></div>
  `;
  // Add CSS for filter selects (one-time)
  if (!document.getElementById('ws-filter-css')) {
    const css = document.createElement('style');
    css.id = 'ws-filter-css';
    css.textContent = `.ws-filter-sel {padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--bg-card);color:var(--text);font-family:inherit;cursor:pointer;max-width:180px}`;
    document.head.appendChild(css);
  }
  $('ws-search').addEventListener('input', (e) => {
    _wsSearch = e.target.value;
    renderWebsitesList();
  });
  // Wire filter selects
  for (const k of ['registrar', 'hosting', 'ssl', 'others']) {
    const el = $('ws-filter-' + k);
    if (el) el.addEventListener('change', () => {
      _wsFilter[k] = el.value;
      _updateWsClearBtn();
      renderWebsitesList();
    });
  }
  $('ws-filter-clear').addEventListener('click', () => {
    _wsFilter = { registrar: '', hosting: '', ssl: '', others: '' };
    for (const k of ['registrar', 'hosting', 'ssl', 'others']) {
      const el = $('ws-filter-' + k);
      if (el) el.value = '';
    }
    _updateWsClearBtn();
    renderWebsitesList();
  });
  await loadWebsites();
}

function _updateWsClearBtn() {
  const hasFilter = Object.values(_wsFilter).some(v => v);
  const btn = $('ws-filter-clear');
  if (btn) btn.style.display = hasFilter ? '' : 'none';
}

// Build options for each filter from current data
function _populateWsFilters() {
  // Domain registrars (จาก domains.provider) — รวม DOMAIN_PROVIDERS + ค่าจริงในข้อมูล
  const registrarSet = new Set(DOMAIN_PROVIDERS);
  for (const w of _wsCache) {
    const p = (w.domain.provider || '').trim();
    if (p) registrarSet.add(p);
  }
  // Service names by type — เก็บ unique names ที่ผูกอยู่จริง
  const hostingSet = new Set(), sslSet = new Set(), othersSet = new Set();
  for (const w of _wsCache) {
    for (const s of (w.services || [])) {
      const name = (s.name || '').trim();
      if (!name) continue;
      if (s.service_type === 'hosting') hostingSet.add(name);
      else if (s.service_type === 'ssl') sslSet.add(name);
      else if (s.service_type === 'others') othersSet.add(name);
    }
  }

  const fillSel = (id, allLabel, items) => {
    const el = $(id);
    if (!el) return;
    const current = _wsFilter[id.replace('ws-filter-', '')];
    const sortedItems = Array.from(items).sort((a, b) => a.localeCompare(b, 'th'));
    let opts = `<option value="">${escapeHtml(allLabel)}</option>`;
    // "__none" option only meaningful for hosting/ssl/others (not registrar — domains always have provider field, just maybe blank)
    if (id !== 'ws-filter-registrar') {
      opts += `<option value="__none">— ยังไม่ได้ผูก —</option>`;
    } else {
      opts += `<option value="__none">— ไม่ระบุ —</option>`;
    }
    for (const v of sortedItems) {
      const sel = (v === current) ? ' selected' : '';
      opts += `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(v)}</option>`;
    }
    el.innerHTML = opts;
    if (current) el.value = current;   // restore (สำคัญตอน list re-render)
  };

  fillSel('ws-filter-registrar', '🌐 ทุกผู้จดทะเบียน Domain', registrarSet);
  fillSel('ws-filter-hosting',   '🖥️ ทุก Hosting',           hostingSet);
  fillSel('ws-filter-ssl',       '🔒 ทุก SSL',               sslSet);
  fillSel('ws-filter-others',    '📦 ทุก Others',            othersSet);
}

async function loadWebsites() {
  let data;
  try {
    data = await fetchJson('/api/admin/websites');
  } catch (e) {
    $('ws-list').innerHTML = `<div class="empty">โหลดไม่สำเร็จ: ${escapeHtml(e.message)}</div>`;
    return;
  }
  _wsCache = data.websites || [];
  // โหลด services list ด้วย — ใช้ใน "Add link" picker
  try {
    const sd = await fetchJson('/api/admin/services');
    _svcCache = { hosting: [], ssl: [], others: [] };
    for (const s of (sd.services || [])) {
      if (_svcCache[s.service_type]) _svcCache[s.service_type].push(s);
    }
  } catch (e) {
    /* ignore — จะแสดง warning ตอนกด Add link */
  }
  _populateWsFilters();
  _updateWsClearBtn();
  renderWebsitesList();
}

// Apply filter ตาม type — true ถ้า website ผ่าน filter
function _wsMatchesServiceFilter(w, typeId, filterValue) {
  if (!filterValue) return true;   // no filter
  const services = (w.services || []).filter(s => s.service_type === typeId);
  if (filterValue === '__none') return services.length === 0;
  return services.some(s => (s.name || '').trim() === filterValue);
}

function renderWebsitesList() {
  const listEl = $('ws-list');
  if (!listEl) return;
  const q = _wsSearch.trim().toLowerCase();

  let filtered = _wsCache.slice();
  // Search filter (text)
  if (q) {
    filtered = filtered.filter(w => {
      if ((w.domain.name || '').toLowerCase().includes(q)) return true;
      return (w.services || []).some(s =>
        (s.name || '').toLowerCase().includes(q)
        || (s.provider || '').toLowerCase().includes(q)
      );
    });
  }
  // Registrar filter (domain.provider)
  if (_wsFilter.registrar) {
    filtered = filtered.filter(w => {
      const p = (w.domain.provider || '').trim();
      if (_wsFilter.registrar === '__none') return !p;
      return p === _wsFilter.registrar;
    });
  }
  // Service filters
  filtered = filtered.filter(w =>
    _wsMatchesServiceFilter(w, 'hosting', _wsFilter.hosting)
    && _wsMatchesServiceFilter(w, 'ssl', _wsFilter.ssl)
    && _wsMatchesServiceFilter(w, 'others', _wsFilter.others)
  );

  if ($('ws-count')) $('ws-count').textContent = `${filtered.length} / ${_wsCache.length} websites`;
  if (_wsCache.length === 0) {
    listEl.innerHTML = `<div class="empty">ยังไม่มี domain — เพิ่มที่ <a href="#/services-config" style="color:var(--primary)">Services Config</a> (Domain tab) ก่อน</div>`;
    return;
  }
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty">ไม่พบ website ที่ตรงกับเงื่อนไข — กด <strong>✕ ล้าง filter</strong> เพื่อดูทั้งหมด</div>`;
    return;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  listEl.innerHTML = filtered.map(w => renderWebsiteCard(w, today)).join('');
  listEl.querySelectorAll('button[data-ws-act]').forEach(btn => {
    btn.addEventListener('click', () => handleWebsiteAction(btn));
  });
  // v1.9.270 — คลิกชื่อ/ข้อมูล domain → แก้ไข (slide) + ลบในแผง
  listEl.querySelectorAll('[data-ws-row]').forEach(row => {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.wsRow, 10);
      const w = _wsCache.find(x => x.domain && x.domain.id === id);
      if (w) showDomainModal(w.domain);
    });
  });
}

function renderWebsiteCard(w, today) {
  const d = w.domain;
  // Domain status — สั้น + ใส่ icon ตาม days remaining
  let domStatus = '';
  if (d.expire_date) {
    const exp = new Date(d.expire_date);
    const days = Math.floor((exp - today) / 86400000);
    if (days < 0) domStatus = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:700;background:rgba(220,38,38,.10);color:var(--critical);white-space:nowrap">⛔ ${-days}d</span>`;
    else if (days <= 30) domStatus = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:700;background:rgba(245,158,11,.12);color:#92400e;white-space:nowrap">⚠ ${days}d</span>`;
    else domStatus = `<span style="display:inline-flex;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600;background:rgba(16,185,129,.12);color:var(--green);white-space:nowrap">✓ ${days}d</span>`;
  }

  // Service chip — single inline element
  const renderSvcChip = (s) => {
    let svcExpire = '';
    if (s.expire_date) {
      const exp = new Date(s.expire_date);
      const days = Math.floor((exp - today) / 86400000);
      if (days < 0) svcExpire = `<span style="color:var(--critical);font-weight:700">⛔${-days}d</span>`;
      else if (days <= 30) svcExpire = `<span style="color:#92400e;font-weight:700">⚠${days}d</span>`;
      else svcExpire = `<span style="color:var(--text-muted)">${days}d</span>`;
    }
    const tip = `${escapeHtml(s.name)}${s.provider ? ' · ' + escapeHtml(s.provider) : ''}${s.price != null ? ' · ' + fmtMoneyOrNumber(s.price) + ' ' + escapeHtml(s.currency || '') : ''}${s.expire_date ? ' · หมด ' + escapeHtml(fmtDateThai(s.expire_date)) : ''}`;
    const typeIcon = s.service_type === 'hosting' ? '🖥️' : s.service_type === 'ssl' ? '🔒' : '📦';
    // ชื่อบริการ + provider — provider ต่อท้ายแบบ muted ให้อ่านง่าย
    // เช่น "DigitalOcean Droplet · DigitalOcean"
    const nameLabel = s.provider
      ? `${escapeHtml(s.name)} <span style="color:var(--text-muted);font-weight:500">· ${escapeHtml(s.provider)}</span>`
      : escapeHtml(s.name);
    return `
      <span class="ws-svc-chip" title="${tip}" style="display:inline-flex;align-items:center;gap:5px;padding:3px 7px 3px 9px;border:1px solid var(--border);background:var(--bg);border-radius:999px;font-size:11.5px;line-height:1.4;max-width:340px">
        <span>${typeIcon}</span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px;font-weight:600;color:var(--text)">${nameLabel}</span>
        ${svcExpire}
        <button class="btn" data-ws-act="unlink" data-ws-domain-id="${d.id}" data-ws-service-id="${s.id}" data-ws-name="${escapeHtml(s.name)}" style="font-size:9.5px;padding:0 4px;line-height:1;border-radius:50%;height:16px;min-width:16px;background:transparent;border-color:transparent;color:var(--text-muted)" title="ยกเลิกการผูก">✕</button>
      </span>
    `;
  };

  const renderAddBtn = (typeId, label, icon) => `
    <button class="btn" data-ws-act="add" data-ws-domain-id="${d.id}" data-ws-type="${typeId}"
      style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border:1px dashed var(--border);background:transparent;border-radius:999px;font-size:11px;color:var(--text-muted);font-weight:500"
      title="เพิ่ม ${escapeHtml(label)}">${icon}+</button>
  `;

  const by = w.by_type || {};
  const allSvcs = [...(by.hosting || []), ...(by.ssl || []), ...(by.others || [])];
  const chips = allSvcs.map(renderSvcChip).join('');

  // Domain meta line — provider + register/expire dates inline
  const metaParts = [];
  if (d.provider) metaParts.push(`🏢 ${escapeHtml(d.provider)}`);
  if (d.register_date) metaParts.push(`📅 ${escapeHtml(fmtDateThai(d.register_date))}`);
  if (d.expire_date) metaParts.push(`⏰ ${escapeHtml(fmtDateThai(d.expire_date))}`);
  const metaLine = metaParts.length ? metaParts.join(' <span style="color:var(--border)">·</span> ') : '';

  return `
    <div class="card" style="display:block;margin-bottom:8px;padding:10px 14px">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button data-ws-act="logo" data-ws-domain-id="${d.id}" title="คลิกเพื่อแก้ไขโลโก้"
          style="background:transparent;border:none;padding:0;cursor:pointer;flex-shrink:0">
          ${domainLogoHTML(d, 40)}
        </button>
        <div class="hw-card" data-ws-row="${d.id}" title="คลิกเพื่อแก้ไข domain" style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:2px;overflow:hidden;cursor:pointer;border-radius:8px;padding:2px 4px;margin:-2px -4px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-weight:700;font-size:14.5px;font-family:ui-monospace,Menlo,monospace;color:var(--text)">${escapeHtml(d.name)}</span>
            ${domStatus}
            <span style="font-size:11px;color:var(--text-muted)">${w.service_count} svc</span>
            <span style="font-size:13px;color:var(--text-muted)">›</span>
          </div>
          ${metaLine ? `<div style="font-size:11.5px;color:var(--text-muted);line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${metaLine}</div>` : ''}
        </div>
        <div style="display:flex;gap:5px;flex-shrink:0;flex-wrap:wrap">
          <button class="btn" data-ws-act="lookup" data-ws-domain-id="${d.id}" data-ws-name="${escapeHtml(d.name)}" style="font-size:11.5px;padding:5px 10px" title="WHOIS / nslookup / DNS">🔍 Lookup</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);align-items:center">
        ${chips || '<span style="font-size:11.5px;color:var(--text-muted);font-style:italic">ยังไม่ได้ผูก service</span>'}
        ${renderAddBtn('hosting', 'Hosting', '🖥️')}
        ${renderAddBtn('ssl', 'SSL', '🔒')}
        ${renderAddBtn('others', 'Others', '📦')}
      </div>
    </div>
  `;
}

async function handleWebsiteAction(btn) {
  const act = btn.dataset.wsAct;
  const domainId = parseInt(btn.dataset.wsDomainId, 10);
  if (act === 'add') {
    const type = btn.dataset.wsType;
    showLinkServiceModal(domainId, type);
  } else if (act === 'unlink') {
    const serviceId = parseInt(btn.dataset.wsServiceId, 10);
    const name = btn.dataset.wsName;
    if (!confirm(`ยกเลิกการผูก "${name}" จาก domain นี้?`)) return;
    try {
      await fetchJson(`/api/admin/domains/${domainId}/services/${serviceId}`, { method: 'DELETE' });
      await loadWebsites();
    } catch (e) { alert('ยกเลิกไม่สำเร็จ: ' + e.message); }
  } else if (act === 'lookup') {
    // เปิด WHOIS / nslookup / DNS modal — reuse function เดิมจาก Domain Config
    const name = btn.dataset.wsName;
    if (typeof showLookupModal === 'function') showLookupModal(name, 'whois');
    else alert('Lookup ใช้งานไม่ได้');
  } else if (act === 'edit') {
    // เปิด full edit modal — reuse function เดิม + load domain object จาก _wsCache
    const w = _wsCache.find(x => x.domain.id === domainId);
    if (w) {
      // เก็บ refresh callback แทน loadDomainsConfigList default
      _wsAfterEditReload = true;
      showDomainModal(w.domain);
    }
  } else if (act === 'logo') {
    // เปิด quick logo modal (เฉพาะรูป — ไม่ต้องเข้า full edit)
    const w = _wsCache.find(x => x.domain.id === domainId);
    if (w) showQuickLogoModal(w.domain);
  }
}

// Flag: เมื่อกด edit จาก Websites page — หลัง save ให้ reload websites list ด้วย
let _wsAfterEditReload = false;

// Quick logo edit modal — focus เฉพาะรูป (ไม่ต้องแก้ field อื่น)
function showQuickLogoModal(domain) {
  const hasLogo = !!domain.logo_data;
  showModal({
    title: `🖼 โลโก้: ${domain.name}`,
    body: `
      <div class="hint" style="font-size:12.5px;color:var(--text-muted);margin-bottom:12px">
        แก้ไขเฉพาะโลโก้ (วงกลม) ของ domain นี้ — ไม่กระทบ field อื่น
      </div>
      <div style="display:flex;gap:14px;align-items:flex-start">
        <div id="ql-preview" style="width:96px;height:96px;border-radius:50%;border:1.5px dashed var(--border);background:${hasLogo ? 'var(--bg-card)' : 'var(--bg-soft)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
          ${hasLogo
            ? `<img src="${domain.logo_data}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`
            : `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>โลโก้</span>`
          }
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:7px">
          <button type="button" class="btn" id="ql-upload-btn" style="font-size:13px;padding:8px 12px;text-align:left">📷 อัพโหลดไฟล์...</button>
          <button type="button" class="btn" id="ql-search-btn" style="font-size:13px;padding:8px 12px;text-align:left">🔍 ค้นหาโลโก้จาก domain</button>
          <button type="button" class="btn danger" id="ql-remove-btn" style="font-size:13px;padding:8px 12px;text-align:left;${hasLogo ? '' : 'display:none'}">🗑 ลบโลโก้</button>
          <input type="file" id="ql-file-input" accept="image/*" style="display:none" />
        </div>
      </div>
      <input type="hidden" id="ql-data" value="${escapeHtml(domain.logo_data || '')}" />
    `,
    onSubmit: async () => {
      const cur = $('ql-data').value;
      const initial = domain.logo_data || '';
      if (cur === initial) {
        // No change — skip API call
        return;
      }
      // PATCH เฉพาะ logo_data
      await fetchJson(`/api/admin/domains/${domain.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_data: cur }),   // '' = clear
      });
      await loadWebsites();
    },
  });

  // Wire (เลียน showDomainModal logo wiring)
  const setQl = (dataUrl) => {
    const dataEl = $('ql-data');
    const preview = $('ql-preview');
    const removeBtn = $('ql-remove-btn');
    if (!dataEl || !preview) return;
    dataEl.value = dataUrl || '';
    if (dataUrl) {
      preview.style.background = 'var(--bg-card)';
      preview.innerHTML = `<img src="${dataUrl}" alt="logo" style="width:100%;height:100%;object-fit:cover" />`;
      if (removeBtn) removeBtn.style.display = '';
    } else {
      preview.style.background = 'var(--bg-soft)';
      preview.innerHTML = `<span style="color:var(--text-muted);font-size:11px;text-align:center;line-height:1.3">ยังไม่มี<br/>โลโก้</span>`;
      if (removeBtn) removeBtn.style.display = 'none';
    }
  };

  const fileInput = $('ql-file-input');
  $('ql-upload-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => openCropModal(ev.target.result, setQl);
    reader.readAsDataURL(file);
    fileInput.value = '';
  });
  $('ql-search-btn').addEventListener('click', () => openLogoSearchModal(domain.name, setQl));
  $('ql-remove-btn').addEventListener('click', () => {
    if (!confirm('ลบโลโก้ของ domain นี้?')) return;
    setQl('');
  });
}

function showLinkServiceModal(domainId, typeId) {
  const tabInfo = SERVICE_TYPES.find(t => t.id === typeId);
  const available = (_svcCache[typeId] || []);
  // หา domain เพื่อรู้ว่า service ไหนผูกอยู่แล้ว
  const w = _wsCache.find(x => x.domain.id === domainId);
  const linkedIds = new Set((w?.services || []).map(s => s.id));
  const candidates = available.filter(s => !linkedIds.has(s.id));

  if (available.length === 0) {
    alert(`ยังไม่มี ${tabInfo.label} ในระบบ — เพิ่มที่ Services Config ก่อน`);
    location.hash = '#/services-config';
    return;
  }
  if (candidates.length === 0) {
    alert(`Domain นี้ผูกกับ ${tabInfo.label} ทุกตัวที่มีในระบบแล้ว — เพิ่ม ${tabInfo.label} ใหม่ที่ Services Config`);
    return;
  }

  showModal({
    title: `+ เพิ่ม ${tabInfo.icon} ${tabInfo.label}`,
    body: `
      <div class="field">
        <label>เลือก ${escapeHtml(tabInfo.label)}</label>
        <select id="ls-id" size="${Math.min(8, candidates.length)}" style="width:100%;padding:6px;font-size:13px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text);font-family:inherit">
          ${candidates.map(s => `<option value="${s.id}">${escapeHtml(s.name)}${s.provider ? ' (' + escapeHtml(s.provider) + ')' : ''}${s.price != null ? ' — ' + fmtMoneyOrNumber(s.price) + ' ' + escapeHtml(s.currency || '') : ''}</option>`).join('')}
        </select>
      </div>
      <div class="hint" style="font-size:11.5px;color:var(--text-muted)">เลือกแล้วกด <strong>บันทึก</strong> เพื่อผูกกับ domain นี้</div>
    `,
    onSubmit: async () => {
      const sid = parseInt($('ls-id').value, 10);
      if (!sid) throw new Error('เลือก service ก่อน');
      await fetchJson(`/api/admin/domains/${domainId}/services/${sid}`, { method: 'POST' });
      // v1.9.283 — reload เฉพาะหน้าที่เปิดอยู่ (Websites มี #ws-list · Domain tab ไม่ต้อง)
      if ($('ws-list') && typeof loadWebsites === 'function') await loadWebsites();
    },
  });
}


