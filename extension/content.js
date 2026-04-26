// content.js — runs on every freepik.com page.
//
// Strategy: scan the DOM for the credit-balance number using three layers
// (user selector → text/attribute heuristics → bounded numeric scan), debounce
// to avoid spamming the backend, and observe SPA navigations via MutationObserver.
//
// Comments use the convention from the brief:
//   - Thai for business logic
//   - English for technical / library code

const TAG = '[FCT]';
const SCRIPT_VERSION = 'v9-active-probe';  // เพิ่มทุกครั้งที่แก้ logic — ดูใน console ว่าโหลด version ไหน

// Hostname ที่ extension จะทำหน้าที่ scrape credit (mode A)
// เว็บอื่นที่ user เพิ่มใน admin จะได้แค่ prefill (mode B) — ไม่ scrape credit
const CREDIT_HOSTNAMES = /(?:^|\.)freepik\.com$/i;

/**
 * Fetch backend ผ่าน background.js — เลี่ยง CORS
 * (content.js รันใน origin ของหน้าเว็บ → fetch ไป localhost จะถูก browser block)
 * @param {string} path  path เช่น /api/extension/match?url=...
 * @param {object} [opts]  {method, body}
 */
function backendFetch(path, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: 'BACKEND_FETCH', path, method: opts.method, body: opts.body },
      (reply) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!reply) {
          reject(new Error('no reply from background'));
          return;
        }
        if (!reply.ok) {
          reject(new Error(reply.error || 'HTTP ' + reply.status));
          return;
        }
        resolve(reply.data);
      }
    );
  });
}

// --- ค่าคงที่ทางธุรกิจ ---------------------------------------------------
const SCAN_DEBOUNCE_MS = 1000;             // หน่วงสแกน 1 วินาที กันสแปม
const REPORT_INTERVAL_MS = 5 * 60 * 1000;  // รายงานซ้ำทุก 5 นาที แม้ค่าไม่เปลี่ยน
const MAX_PLAUSIBLE = 1_000_000;           // เลขที่สูงเกิน 1 ล้าน ก็ไม่ใช่เครดิตแล้ว
// ใช้เฉพาะ numeric scan แบบ fallback (layer 3) —
// custom selector กับ attribute hints (layer 1, 2) เชื่อค่าได้เลย ไม่ filter
const MIN_FALLBACK_SCAN = 5;

// --- รัน-ไทม์สเตต ---------------------------------------------------------
let lastReportedBalance = null;
let lastReportedAt = 0;
let scanTimer = null;

/**
 * Parse a string like "5,900", "5.900", "5 900 credits left" → 5900.
 * Returns null if no plausible number was found.
 * @param {string} text
 * @returns {number|null}
 */
function parseNumberFromText(text) {
  if (!text) return null;
  // จับเฉพาะกลุ่มตัวเลข เว้นวรรค จุด หรือคอมม่า — รองรับฟอร์แมตไทย/EU/US
  const match = text.match(/(\d[\d.,\s]*\d|\d)/);
  if (!match) return null;
  const cleaned = match[1].replace(/[\s,.]/g, '');
  const n = parseInt(cleaned, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Run a CSS selector and return the best plausible balance (or null).
 * If the selector matches multiple elements, pick the largest plausible number
 * — Freepik usually shows the headline credit count larger than tiny badges.
 * @param {string} selector
 */
function tryCustomSelector(selector) {
  if (!selector) return null;
  let nodes;
  try {
    nodes = document.querySelectorAll(selector);
  } catch (e) {
    console.debug(TAG, 'invalid custom selector:', selector, e);
    return null;
  }
  // user เจตนาชี้มาตรงๆ — เชื่อค่าได้เลย ไม่ต้อง filter ด้วย MIN
  let best = null;
  for (const el of nodes) {
    const n = parseNumberFromText(el.textContent || '');
    if (n != null && n >= 0 && n <= MAX_PLAUSIBLE) {
      if (best == null || n > best) best = n;
    }
  }
  return best;
}

/**
 * Heuristic search:
 *  - text matching /N credits left/i (also รองรับภาษาไทย "เครดิต ... คงเหลือ")
 *  - attribute hints: data-testid*='credit', class*='credit'
 *  - fallback: numeric scan inside <header> and <aside>
 */
/**
 * Pattern scan with confidence tier.
 * Returns {value, confidence} where confidence ∈ {'high', 'low', null}.
 *  - 'high' = matched a known-good selector (trust always)
 *  - 'low'  = matched a broader heuristic (trust only if we've never seen 'high')
 *  - null   = nothing found
 */
function tryPatternScan() {
  // (1a) known-good selectors — verified จากหน้า freepik จริง
  const KNOWN_GOOD = [
    '[data-cy="credits-limit"]',
    '[data-cy="credits-remaining"]',
    '[data-cy="credits-balance"]',
    '[data-cy="user-credits"]',
    '[data-testid="credits-limit"]',
    '[data-testid="user-credits"]',
  ];
  for (const sel of KNOWN_GOOD) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const n = parseNumberFromText(el.textContent || '');
    if (n != null && n >= 0 && n <= MAX_PLAUSIBLE) {
      return { value: n, confidence: 'high', source: sel };
    }
  }

  // (1b) broader attribute hints — fallback
  const hintNodes = document.querySelectorAll([
    '[data-cy*="credit" i]',
    '[data-cy*="balance" i]',
    '[data-testid*="credit" i]',
    '[data-testid*="balance" i]',
    '[class*="credit" i]',
    '[class*="balance" i]',
  ].join(', '));
  for (const el of hintNodes) {
    if (el.children.length > 2) continue;
    const cy = (el.getAttribute('data-cy') || '').toLowerCase();
    const tid = (el.getAttribute('data-testid') || '').toLowerCase();
    const cls = (el.className || '').toString().toLowerCase();
    const meta = cy + ' ' + tid + ' ' + cls;
    if (/cost|used|today|icon|button|link|tooltip|label/.test(meta)) continue;
    const n = parseNumberFromText(el.textContent || '');
    if (n != null && n >= 0 && n <= MAX_PLAUSIBLE) {
      return { value: n, confidence: 'low', source: 'attr-hint' };
    }
  }

  // (2) ข้อความที่มีคำว่า credit/เครดิต ใกล้ตัวเลข
  const creditTextRe = /(\d[\d.,\s]{0,9})\s*(credits?|เครดิต)/i;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let bestText = null;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue;
    if (!t || t.length > 200) continue;
    const m = t.match(creditTextRe);
    if (m) {
      const n = parseNumberFromText(m[1]);
      if (n != null && n >= 0 && n <= MAX_PLAUSIBLE) {
        if (bestText == null || n > bestText) bestText = n;
      }
    }
  }
  if (bestText != null) return { value: bestText, confidence: 'low', source: 'text-pattern' };

  // (3) numeric scan ใน header/aside — last resort
  const containers = document.querySelectorAll('header, aside, nav');
  let bestNum = null;
  for (const c of containers) {
    const els = c.querySelectorAll('span, strong, b, div');
    for (const el of els) {
      if (el.children.length > 2) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length > 20) continue;
      if (!/^\d[\d.,\s]*\d$|^\d$/.test(txt)) continue;
      const n = parseNumberFromText(txt);
      if (n != null && n >= MIN_FALLBACK_SCAN && n <= MAX_PLAUSIBLE) {
        if (bestNum == null || n > bestNum) bestNum = n;
      }
    }
  }
  if (bestNum != null) return { value: bestNum, confidence: 'low', source: 'numeric-scan' };
  return null;
}

/**
 * Main scan entrypoint with confidence-lock anti-noise.
 *
 * เคยเจอ high-confidence แล้ว → ไว้ใจเฉพาะ high-confidence เท่านั้น
 * จนกว่าจะ reset (เช่น user เคลียร์ storage หรือ Freepik เปลี่ยน DOM)
 *
 * เหตุผล: บางทีตอน scan element high-confidence ไม่อยู่ (เช่น dropdown ปิด)
 * ทำให้ scraper ไป fallback จับเลขขยะ (เช่น 5 จาก notification badge) แทน
 *
 * @returns {Promise<number|null>}
 */
async function findBalance() {
  const stored = await chrome.storage.sync.get(['customSelector']);

  // user ตั้ง custom selector → trust ทันที (signal ชัดสุด)
  if (stored.customSelector) {
    const v = tryCustomSelector(stored.customSelector);
    if (v != null) return v;
  }

  const result = tryPatternScan();
  if (!result) return null;

  // เช็ค confidence lock
  const local = await chrome.storage.local.get(['has_seen_high_confidence']);
  const seenHigh = !!local.has_seen_high_confidence;

  if (result.confidence === 'high') {
    if (!seenHigh) {
      await chrome.storage.local.set({ has_seen_high_confidence: true });
      console.debug(TAG, 'high-confidence locked on selector:', result.source);
    }
    return result.value;
  }

  // confidence === 'low'
  if (seenHigh) {
    // เคยเจอ high แล้ว — รอบนี้ไม่เจอ → skip ไม่ trust ค่าขยะ
    console.debug(TAG, 'skipping low-confidence', result.value, 'from', result.source,
      '(เคยเจอ high-confidence selector แล้ว — รอ DOM ปรากฏใหม่)');
    return null;
  }

  // ยังไม่เคยเจอ high → trust low เป็น first-time
  console.debug(TAG, 'using low-confidence', result.value, 'from', result.source);
  return result.value;
}

/**
 * Scrape the user's display name from the profile dropdown.
 *
 * Freepik (เม.ย. 2026) ไม่มี data-cy สำหรับ name/email โดยตรง — ใช้แค่ Tailwind class
 * แต่ structure คงตัว: <img data-cy="user-avatar"> sibling-with <div> ที่มี <p>2 ตัว
 *   - <p ... font-bold>FEFLddb Content</p>     ← display name
 *   - <p ...>contentfeflddb@gmail.com</p>      ← email
 *
 * Strategy: anchor ที่ data-cy="user-avatar" → walk up หา container ที่มี <p> ≥ 2 ตัว
 *
 * @returns {string|null}
 */
function findProfileName() {
  // (1a) known-good explicit selectors (เผื่อ Freepik เพิ่ม data-cy ในอนาคต)
  const EXPLICIT = [
    '[data-cy="user-name"]',
    '[data-cy="profile-name"]',
    '[data-cy="username"]',
    '[data-cy="user-display-name"]',
    '[data-testid="user-name"]',
    '[data-testid="profile-name"]',
  ];
  for (const sel of EXPLICIT) {
    const el = document.querySelector(sel);
    if (el) {
      const txt = (el.textContent || '').trim();
      if (txt && txt.length <= 80 && !/^\d+$/.test(txt)) return txt;
    }
  }

  // (1b) anchor ที่ user-avatar → เดินขึ้นหา container ที่มี <p> sibling
  // นี่คือ pattern จริงของ Freepik dropdown ปัจจุบัน
  const avatar = document.querySelector('[data-cy="user-avatar"]');
  if (avatar) {
    let cur = avatar;
    for (let i = 0; i < 6; i++) {
      if (!cur.parentElement) break;
      cur = cur.parentElement;
      const ps = cur.querySelectorAll('p');
      if (ps.length >= 2) {
        // เลือก <p> ที่มี font-bold ก่อน (display name) ถ้าไม่มีก็เอา <p> แรก
        let nameP = null;
        for (const p of ps) {
          if (/font-bold/i.test(p.className)) { nameP = p; break; }
        }
        if (!nameP) nameP = ps[0];
        const name = (nameP.textContent || '').trim();
        if (name && name.length <= 80 && !/^\d+$/.test(name)) {
          return name;
        }
        break;  // เจอ container แล้ว ไม่ต้องเดินขึ้นอีก
      }
    }
  }

  // (2) email pattern fallback — ทุก element ที่มีข้อความเป็นอีเมล
  // อีเมลคงตัวกว่า display name (อาจเปลี่ยนได้)
  const all = document.querySelectorAll('p, span, div');
  for (const el of all) {
    if (el.children.length > 0) continue;  // เฉพาะ leaf
    const t = (el.textContent || '').trim();
    if (t.length > 80) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t;
  }

  return null;
}

/**
 * Send a snapshot to the background worker (which forwards to the backend).
 * @param {number} balance
 * @param {string|null} profileName
 */
function reportBalance(balance, profileName) {
  const now = Date.now();
  const isSameAsLast = balance === lastReportedBalance;
  const sinceLast = now - lastReportedAt;
  if (isSameAsLast && sinceLast < REPORT_INTERVAL_MS) return;

  lastReportedBalance = balance;
  lastReportedAt = now;

  try {
    chrome.runtime.sendMessage({
      type: 'CREDIT_SNAPSHOT',
      balance,
      sourceUrl: location.href,
      profileName: profileName || null,
    });
    console.debug(TAG, 'reported balance:', balance, '| profile:', profileName || '(none)');
  } catch (e) {
    // service worker อาจถูก suspend — อันนี้เป็นเรื่องปกติของ MV3
    console.debug(TAG, 'sendMessage failed (worker asleep?):', e);
  }
}

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(async () => {
    scanTimer = null;
    const balance = await findBalance();
    if (balance != null) {
      // เก็บ profile name พร้อมกัน — มักอยู่ใน dropdown เดียวกับเครดิต
      const profileName = findProfileName();
      reportBalance(balance, profileName);
    }
  }, SCAN_DEBOUNCE_MS);
}

// ============================================================================
// PREFILL MODE — fill saved username/password on login pages
// ============================================================================

/**
 * หา <form> ที่น่าจะเป็น login form (มีช่อง password อย่างน้อย 1 ช่อง).
 * @returns {{form:HTMLFormElement, userInput:HTMLInputElement|null, pwInput:HTMLInputElement}|null}
 */
function findLoginForm() {
  const pwInputs = document.querySelectorAll('input[type="password"]');
  for (const pw of pwInputs) {
    // ข้ามช่อง confirm/new password
    const name = (pw.name + ' ' + pw.id + ' ' + pw.autocomplete).toLowerCase();
    if (/confirm|new[-_]?password|repeat/.test(name)) continue;

    const form = pw.closest('form');
    if (!form) continue;

    // หาช่อง username/email ใน form เดียวกัน
    let userInput = null;
    const candidates = form.querySelectorAll(
      'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
    );
    for (const c of candidates) {
      const meta = (c.name + ' ' + c.id + ' ' + c.autocomplete + ' ' + c.placeholder).toLowerCase();
      if (/email|user|login|account/.test(meta)) {
        userInput = c;
        break;
      }
    }
    if (!userInput && candidates.length > 0) {
      userInput = candidates[0];   // fallback: ช่องแรก
    }
    return { form, userInput, pwInput: pw };
  }
  return null;
}

/** Trigger React/Vue change events properly */
function setReactInputValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillCredential(formInfo, cred) {
  if (formInfo.userInput) setReactInputValue(formInfo.userInput, cred.username);
  setReactInputValue(formInfo.pwInput, cred.password);
  // แจ้ง backend ว่า cred นี้ถูกใช้ (update last_used_at)
  backendFetch('/api/extension/credentials/' + cred.id + '/used', { method: 'POST' })
    .catch(() => {});
  console.debug(TAG, 'filled credential id=' + cred.id + ' label=' + (cred.label || '-'));
}

let prefillWidget = null;
let prefillCreds = [];
let prefillFormInfo = null;

function buildPrefillWidget() {
  if (prefillWidget) return;
  prefillWidget = document.createElement('div');
  prefillWidget.id = 'fct-prefill-widget';
  prefillWidget.innerHTML = `
    <div class="fct-panel" id="fct-panel" style="display:none">
      <div class="fct-panel-head">
        <span>🔑 FEFL Beat — เลือกบัญชี</span>
        <button class="fct-close" id="fct-close-btn">×</button>
      </div>
      <div class="fct-panel-sub" id="fct-panel-sub"></div>
      <div id="fct-cred-list"></div>
    </div>
    <button class="fct-trigger" id="fct-trigger">🔑 FEFL Beat : Sign On</button>
  `;
  document.body.appendChild(prefillWidget);

  prefillWidget.querySelector('#fct-trigger').addEventListener('click', togglePrefillPanel);
  prefillWidget.querySelector('#fct-close-btn').addEventListener('click', () => {
    prefillWidget.querySelector('#fct-panel').style.display = 'none';
  });
}

function togglePrefillPanel() {
  const panel = prefillWidget.querySelector('#fct-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
}

function renderPrefillList(siteName) {
  const list = prefillWidget.querySelector('#fct-cred-list');
  prefillWidget.querySelector('#fct-panel-sub').textContent = `เว็บ: ${siteName}`;
  if (prefillCreds.length === 0) {
    list.innerHTML = `<div class="fct-empty">
      ยังไม่มี credential สำหรับเว็บนี้<br/>
      <a href="http://localhost:8765/admin" target="_blank">เปิด Admin เพื่อเพิ่ม →</a>
    </div>`;
    return;
  }
  list.innerHTML = prefillCreds.map((c, i) => `
    <div class="fct-cred" data-idx="${i}">
      ${c.label ? `<div class="fct-cred-label">${c.label}</div>` : ''}
      <div class="fct-cred-username">${c.username}</div>
    </div>
  `).join('');
  list.querySelectorAll('.fct-cred').forEach(el => {
    el.addEventListener('click', () => {
      const cred = prefillCreds[parseInt(el.dataset.idx, 10)];
      // re-find form ทุกครั้ง — DOM อาจเปลี่ยน
      const formInfo = findLoginForm();
      if (!formInfo) {
        alert('ไม่พบ login form ในหน้านี้');
        return;
      }
      fillCredential(formInfo, cred);
      prefillWidget.querySelector('#fct-panel').style.display = 'none';
    });
  });
}

let prefillCheckInFlight = false;
async function checkPrefill() {
  if (prefillCheckInFlight) return;
  prefillCheckInFlight = true;
  try {
    const formInfo = findLoginForm();
    if (!formInfo) {
      // ไม่มี login form → ซ่อน widget
      if (prefillWidget) prefillWidget.style.display = 'none';
      return;
    }
    prefillFormInfo = formInfo;

    // Query backend ผ่าน background proxy (เลี่ยง CORS)
    let data;
    try {
      data = await backendFetch(
        '/api/extension/match?url=' + encodeURIComponent(location.href)
      );
    } catch (e) {
      console.debug(TAG, 'prefill: backend unreachable, hiding widget:', e.message);
      if (prefillWidget) prefillWidget.style.display = 'none';
      return;
    }

    if (!data.matched) {
      if (prefillWidget) prefillWidget.style.display = 'none';
      return;
    }

    prefillCreds = data.credentials || [];
    buildPrefillWidget();
    prefillWidget.style.display = '';
    renderPrefillList(data.site.name);
    console.debug(TAG, 'prefill ready:', prefillCreds.length, 'credentials for', data.site.name);
  } finally {
    prefillCheckInFlight = false;
  }
}

// debounce prefill check (เผื่อ DOM เปลี่ยนเยอะๆ ตอน SPA นำทาง)
let prefillTimer = null;
function schedulePrefillCheck() {
  if (prefillTimer) clearTimeout(prefillTimer);
  prefillTimer = setTimeout(checkPrefill, 800);
}

// ============================================================================
// PAGE BRIDGE — รับคำสั่ง FCT_FORCE_PING จากหน้า admin (postMessage)
// → ส่งไป background → background fetch backend → ตอบกลับ
// ใช้เพื่อ "active probe" ในหน้า /admin#/extension status widget
// ============================================================================
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.type !== 'FCT_FORCE_PING') return;
  const reqId = data.requestId;
  try {
    chrome.runtime.sendMessage({ type: 'FORCE_PING' }, (reply) => {
      const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
      window.postMessage({
        type: 'FCT_PING_RESULT',
        requestId: reqId,
        ok: !!(reply && reply.ok),
        backend: reply && reply.backend,
        status: reply && reply.status,
        error: (reply && reply.error) || err || null,
        version: SCRIPT_VERSION,
      }, '*');
    });
  } catch (e) {
    window.postMessage({
      type: 'FCT_PING_RESULT',
      requestId: reqId,
      ok: false, error: e.message, version: SCRIPT_VERSION,
    }, '*');
  }
});

// --- bootstrapping --------------------------------------------------------
console.debug(TAG, SCRIPT_VERSION, 'content script loaded for', location.href);

const isCreditHost = CREDIT_HOSTNAMES.test(location.hostname);

// CREDIT MODE — เฉพาะบน freepik.com
if (isCreditHost) {
  scheduleScan();
}

// PREFILL MODE — รันบนทุกเว็บ (รวม freepik.com หน้า login)
schedulePrefillCheck();

// observe DOM changes
const observer = new MutationObserver(() => {
  if (isCreditHost) scheduleScan();
  schedulePrefillCheck();
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  characterData: true,
});

// ตอบ message จาก options page (Test selector button)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'TEST_SELECTOR') {
    try {
      const nodes = document.querySelectorAll(msg.selector);
      const matches = [];
      for (const el of nodes) {
        const n = parseNumberFromText(el.textContent || '');
        matches.push({
          text: (el.textContent || '').trim().slice(0, 80),
          parsed: n,
        });
      }
      sendResponse({ ok: true, count: nodes.length, matches });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;  // sendResponse will be used asynchronously
  }
  if (msg && msg.type === 'PING_SCAN') {
    findBalance().then(b => sendResponse({ balance: b }));
    return true;
  }
});
