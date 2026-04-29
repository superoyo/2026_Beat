// content.js — runs on every freepik.com / magnific.com page.
//
// Strategy: scan the DOM for the credit balance using three layers
// (user selector → text/attribute heuristics → bounded numeric scan), debounce
// to avoid spamming the backend, and observe SPA navigations via MutationObserver.
//
// v28: เพิ่ม magnific.{com,ai} ใน hostname regex — DOM เหมือน Freepik เด๊ะ
//      (เปลี่ยนแค่ชื่อเว็บ rebrand) ใช้ selectors เดิมได้ทุกตัว
//
// Comments use the convention from the brief:
//   - Thai for business logic
//   - English for technical / library code

const TAG = '[FCT]';
const SCRIPT_VERSION = 'v28-magnific';  // เพิ่มทุกครั้งที่แก้ logic — ดูใน console ว่าโหลด version ไหน

// Hostname ที่ extension จะทำหน้าที่ scrape credit (mode A)
// - freepik.com   (เดิม)
// - magnific.com  (rebrand จาก freepik — DOM เดียวกัน)
// - magnific.ai   (เผื่อโดเมนสำรอง)
// เว็บอื่นที่ user เพิ่มใน admin จะได้แค่ prefill (mode B) — ไม่ scrape balance
const CREDIT_HOSTNAMES = /(?:^|\.)(?:freepik\.com|magnific\.(?:com|ai))$/i;

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
 * Parse a string like "5,900", "5.900", "690K", "1.5K", "2M" → number.
 * - K suffix → ×1000, M suffix → ×1,000,000
 * - มี K/M → จุดถือเป็น decimal (1.5K = 1500)
 * - ไม่มี K/M → จุดถือเป็น thousands separator แบบไทย/EU (5.900 = 5900)
 * @param {string} text
 * @returns {number|null}
 */
function parseNumberFromText(text) {
  if (!text) return null;
  const match = text.match(/([\d,.\s]+)\s*([KkMm])?/);
  if (!match) return null;
  const suffix = (match[2] || '').toLowerCase();
  let raw = match[1].replace(/[\s,]/g, '');  // ตัด space + comma
  let n;
  if (suffix === 'k' || suffix === 'm') {
    // มี suffix → จุดเป็น decimal
    n = parseFloat(raw);
  } else {
    // ไม่มี suffix → จุดเป็น thousands separator (Thai/EU) — ตัดออก
    n = parseInt(raw.replace(/\./g, ''), 10);
  }
  if (!Number.isFinite(n)) return null;
  if (suffix === 'k') n *= 1000;
  else if (suffix === 'm') n *= 1_000_000;
  return Math.round(n);
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
  // Magnific.com ใช้ DOM เดียวกัน (rebrand เฉย ๆ) — selectors ชุดนี้ใช้ได้กับทั้งคู่
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
      console.log('%c[FCT] ✓ high-confidence locked on:', 'color:#10b981;font-weight:bold', result.source);
    }
    // เก็บ tentative ล่าสุดด้วย เผื่อ debug/popup ต้องดู
    await chrome.storage.local.set({
      last_tentative: { value: result.value, source: result.source, confidence: 'high', at: Date.now() },
    });
    return result.value;
  }

  // confidence === 'low' — บันทึก tentative ทุกครั้ง (popup จะใช้แสดงสถานะ)
  await chrome.storage.local.set({
    last_tentative: { value: result.value, source: result.source, confidence: 'low', at: Date.now() },
  });

  if (seenHigh) {
    // เคยเจอ high แล้ว — รอบนี้ไม่เจอ → skip ไม่ trust ค่าขยะ
    // log ครั้งแรกของ session ให้เด่น พร้อมบอกวิธี reset
    if (!_lockSkipLogged) {
      _lockSkipLogged = true;
      console.warn('%c[FCT] ⚠ confidence-lock blocking low-confidence value', 'color:#dc2626;font-weight:bold',
        '\n  value:', result.value, 'from', result.source,
        '\n  เหตุผล: เคยเจอ high-confidence selector มาก่อน → รอ selector เดิมโผล่ใหม่',
        '\n  วิธีแก้:',
        '\n    1. คลิก icon extension → ปุ่ม "🔓 Reset detect"',
        '\n    2. หรือพิมพ์ใน console: chrome.storage.local.remove(["has_seen_high_confidence"])',
        '\n    3. หรือใช้ Inspect → ตรวจ DOM ว่า selector ของ Magnific ตรงกับ KNOWN_GOOD ไหม');
    } else {
      // logs ถัดไปเงียบกว่า — กันสแปม
      console.debug(TAG, 'skipping low-confidence', result.value, 'from', result.source);
    }
    return null;
  }

  // ยังไม่เคยเจอ high → trust low เป็น first-time
  console.log('%c[FCT] ✓ using low-confidence', 'color:#f59e0b', result.value, 'from', result.source);
  return result.value;
}

// session-scoped flag — log lock-skip warning ครั้งเดียวต่อ tab session
let _lockSkipLogged = false;

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
 * Scrape "credits spent" จาก profile dropdown — Freepik แสดงเป็น "Spent 690K"
 * อยู่ใน element data-cy="credits-spent"
 * @returns {number|null}
 */
function findCreditsSpent() {
  // Known-good selector ก่อน
  const direct = document.querySelector('[data-cy="credits-spent"]');
  if (direct) {
    const n = parseNumberFromText(direct.textContent || '');
    if (n != null && n >= 0 && n <= 100_000_000) return n;
  }
  // Fallback: หา element ที่มีข้อความ "Spent X..." ใกล้กับ credits-limit
  const limit = document.querySelector('[data-cy="credits-limit"]');
  if (limit) {
    let cur = limit;
    for (let i = 0; i < 5; i++) {
      if (!cur.parentElement) break;
      cur = cur.parentElement;
      const txt = (cur.textContent || '');
      const m = txt.match(/Spent\s+(\d[\d.,\s]*[KkMm]?)/i);
      if (m) {
        const n = parseNumberFromText(m[1]);
        if (n != null) return n;
      }
    }
  }
  return null;
}

/**
 * Scrape email ของ profile ที่ login อยู่ (แยกจาก display name)
 * — ใช้ link credit balance กับ credential ใน DB
 */
function findProfileEmail() {
  // 1) anchor ที่ user-avatar — เดินขึ้นหา container ที่มี <p> sibling
  const avatar = document.querySelector('[data-cy="user-avatar"]');
  if (avatar) {
    let cur = avatar;
    for (let i = 0; i < 6; i++) {
      if (!cur.parentElement) break;
      cur = cur.parentElement;
      const ps = cur.querySelectorAll('p');
      for (const p of ps) {
        const t = (p.textContent || '').trim();
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t.toLowerCase();
      }
      if (ps.length >= 2) break;  // เจอ profile block แล้วไม่เจอ email — ไม่มีจริงๆ
    }
  }
  // 2) fallback — element ใดก็ได้ที่มีข้อความเป็น email
  const all = document.querySelectorAll('p, span, div');
  for (const el of all) {
    if (el.children.length > 0) continue;
    const t = (el.textContent || '').trim();
    if (t.length > 80) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return t.toLowerCase();
  }
  return null;
}

/**
 * Send a snapshot to the background worker (which forwards to the backend).
 * @param {number} balance
 * @param {string|null} profileName
 * @param {string|null} profileEmail
 * @param {number|null} creditsSpent
 */
function reportBalance(balance, profileName, profileEmail, creditsSpent) {
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
      profileEmail: profileEmail || null,
      creditsSpent: (creditsSpent != null && Number.isFinite(creditsSpent)) ? creditsSpent : null,
    });
    console.log('%c[FCT] ✅ sent to backend', 'color:#10b981;font-weight:bold',
      '\n  balance:', balance,
      '\n  spent:', creditsSpent != null ? creditsSpent : '(none)',
      '\n  profile:', profileName || '(none)',
      '\n  email:', profileEmail || '(none)',
      '\n  url:', location.href);
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
      // เก็บ profile name + email + spent พร้อมกัน — มักอยู่ใน dropdown เดียวกับเครดิต
      const profileName = findProfileName();
      const profileEmail = findProfileEmail();
      const creditsSpent = findCreditsSpent();
      reportBalance(balance, profileName, profileEmail, creditsSpent);
    }
  }, SCAN_DEBOUNCE_MS);
}

// ============================================================================
// PREFILL MODE — fill saved username/password on login pages
// ============================================================================

/** ตรวจว่า input element มอง visible หรือไม่ (เลี่ยง hidden/0-size/display:none) */
function isInputVisible(el) {
  if (!el) return false;
  if (el.disabled) return false;
  if (el.type === 'hidden') return false;
  // offsetParent === null ก็เป็น hidden ยกเว้น position:fixed → เช็ค getClientRects เพิ่ม
  if (el.offsetParent === null && el.getClientRects().length === 0) return false;
  return true;
}

/**
 * querySelectorAll ที่ traverse เข้า shadow DOMs ของหน้าเว็บด้วย
 * (Auth0/Web Components บางทีใส่ password field ใน shadow root → document.qsa หาไม่เจอ)
 */
function deepQuerySelectorAll(selector, root = document) {
  const result = [];
  if (!root) return result;
  const direct = (root.querySelectorAll && root.querySelectorAll(selector)) || [];
  for (const el of direct) result.push(el);
  // เดินเข้า shadow DOMs ของทุก element
  const all = (root.querySelectorAll && root.querySelectorAll('*')) || [];
  for (const el of all) {
    if (el.shadowRoot) {
      const inShadow = deepQuerySelectorAll(selector, el.shadowRoot);
      for (const x of inShadow) result.push(x);
    }
  }
  return result;
}

/**
 * หา login container — รองรับ 3 mode:
 *   1. 'both'           — มีทั้ง user + password ในหน้าเดียว (ปกติ)
 *   2. 'user-only'      — มีแค่ user/email field (Step 1 ของ 2-step login: ChatGPT, Google, MS)
 *   3. 'password-only'  — มีแค่ password field (Step 2 หลังกด Next)
 * @returns {{form:Element, userInput:HTMLInputElement|null, pwInput:HTMLInputElement|null, mode:string}|null}
 */
function findLoginForm() {
  // ใช้ deep query — รองรับ shadow DOMs ของหน้าเว็บ (Auth0 Web Components ฯลฯ)
  const pwInputs = deepQuerySelectorAll('input[type="password"]');
  const visiblePws = pwInputs.filter(p => {
    const name = (p.name + ' ' + p.id + ' ' + p.autocomplete).toLowerCase();
    if (/confirm|new[-_]?password|repeat/.test(name)) return false;
    return isInputVisible(p);
  });

  // === A. มี password ที่ visible — โหมด 'both' หรือ 'password-only' ===
  if (visiblePws.length > 0) {
    for (const pw of visiblePws) {
      // หา container — prefer <form>, fallback walk up
      let container = pw.closest('form');
      if (!container) {
        let cur = pw.parentElement;
        for (let depth = 0; depth < 10 && cur; depth++) {
          const others = cur.querySelectorAll(
            'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
          );
          for (const c of others) {
            if (c !== pw && isInputVisible(c)) { container = cur; break; }
          }
          if (container) break;
          cur = cur.parentElement;
        }
        if (!container) container = pw.parentElement;
      }
      if (!container) continue;

      // หา user input ใน container
      const candidates = container.querySelectorAll(
        'input[type="email"], input[type="text"], input[type="tel"], input:not([type])'
      );
      let userInput = null;
      // Pass 1: keyword
      for (const c of candidates) {
        if (c === pw || !isInputVisible(c)) continue;
        const meta = (c.name + ' ' + c.id + ' ' + c.autocomplete + ' ' + c.placeholder).toLowerCase();
        if (/email|user|login|account|phone|tel|mobile/.test(meta)) { userInput = c; break; }
      }
      // Pass 2: visible ตัวแรก
      if (!userInput) {
        for (const c of candidates) {
          if (c === pw || !isInputVisible(c)) continue;
          userInput = c;
          break;
        }
      }
      const mode = userInput ? 'both' : 'password-only';
      console.debug(TAG, 'login form detected mode=' + mode,
        '· container:', container.tagName.toLowerCase() + (container.id ? '#' + container.id : ''),
        '· user:', userInput ? userInput.name || userInput.id || '(no-name)' : '(none)',
        '· pw:', pw.name || pw.id || '(no-name)'
      );
      return { form: container, userInput, pwInput: pw, mode };
    }
  }

  // === B. ไม่มี password — เช็ค user-only mode (Step 1 ของ 2-step login) ===
  const userCandidates = deepQuerySelectorAll(
    'input[type="email"], input[type="text"], input[type="tel"]'
  ).filter(isInputVisible);

  for (const c of userCandidates) {
    const meta = (c.name + ' ' + c.id + ' ' + c.autocomplete + ' ' + c.placeholder).toLowerCase();
    // ต้องมี signal ที่ชัดเจนว่าเป็น login field — ป้องกัน false positive
    // (เช่น search box, comment box ที่ไม่ใช่ login)
    const acHint = (c.autocomplete || '').toLowerCase();
    const isLoginField =
      /email|user(name)?|login|account|signin|sign[-_]in/.test(meta)
      || acHint === 'username' || acHint === 'email';
    if (!isLoginField) continue;

    let container = c.closest('form') || c.parentElement;
    console.debug(TAG, 'login form detected mode=user-only',
      '· user:', c.name || c.id || '(no-name)', 'autocomplete=' + (c.autocomplete || '(none)')
    );
    return { form: container, userInput: c, pwInput: null, mode: 'user-only' };
  }

  return null;
}

// === Pending credential — เก็บไว้ระหว่าง step 1 → step 2 ของ 2-step login ===
// เก็บ 2 keys:
//  1. hostname-specific (chatgpt.com)         — TTL 15 นาที (กรณี user อ่าน email)
//  2. global "recent"                         — TTL 10 นาที (fallback กรณี
//     password page ไปคนละ hostname เช่น auth.openai.com — ChatGPT มี email
//     verification page กลาง ที่ user อาจอ่านนาน)
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_RECENT_TTL_MS = 10 * 60 * 1000;
const PENDING_RECENT_KEY = 'fct_recent_pending';

function _pendingKey() { return 'pending_prefill_' + location.hostname; }

async function savePendingCredential(cred) {
  const entry = {
    cred_id: cred.id, label: cred.label,
    username: cred.username, password: cred.password,
    saved_hostname: location.hostname,
    saved_url: location.href,
    ts: Date.now(),
  };
  await chrome.storage.local.set({
    [_pendingKey()]: entry,
    [PENDING_RECENT_KEY]: entry,    // fallback for cross-hostname 2-step
  });
  console.debug(TAG, '💾 saved pending credential for', location.hostname,
    '(label:', cred.label || '(no-label)', ') — รอ password page ถัดไป');
}

async function getPendingCredential() {
  const r = await chrome.storage.local.get([_pendingKey(), PENDING_RECENT_KEY]);
  // Pass 1: hostname-specific (TTL 5 นาที)
  const local = r[_pendingKey()];
  if (local && Date.now() - local.ts < PENDING_TTL_MS) {
    return local;
  }
  // Pass 2: global recent (TTL 2 นาที) — สำหรับ cross-hostname 2-step
  // เช่น chatgpt.com (Step 1) → auth.openai.com (Step 2)
  const recent = r[PENDING_RECENT_KEY];
  if (recent && Date.now() - recent.ts < PENDING_RECENT_TTL_MS) {
    if (recent.saved_hostname !== location.hostname) {
      console.debug(TAG, '🌉 cross-hostname pending: saved on',
        recent.saved_hostname, '→ using on', location.hostname);
    }
    return recent;
  }
  // expired
  if (local) await chrome.storage.local.remove([_pendingKey()]);
  if (recent) await chrome.storage.local.remove([PENDING_RECENT_KEY]);
  return null;
}

async function clearPendingCredential() {
  await chrome.storage.local.remove([_pendingKey(), PENDING_RECENT_KEY]);
}

// Show ephemeral toast เมื่อ auto-fill ทำงานเงียบๆ (user จะได้รู้)
function showAutoFillToast(message) {
  try {
    const host = document.createElement('div');
    host.setAttribute('style', `
      position: fixed !important;
      bottom: 80px !important;
      right: 20px !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      isolation: isolate !important;
      transform: translateZ(0) !important;
    `);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .toast {
          background: #10b981; color: #fff;
          padding: 10px 16px; border-radius: 999px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          font-size: 13px; font-weight: 500;
          box-shadow: 0 6px 20px rgba(0,0,0,.35);
          opacity: 0; transform: translateY(8px);
          transition: opacity .25s, transform .25s;
        }
        .toast.show { opacity: 1; transform: translateY(0); }
      </style>
      <div class="toast">${escapeHtmlSafe(message)}</div>
    `;
    (document.documentElement || document.body).appendChild(host);
    requestAnimationFrame(() => {
      const t = root.querySelector('.toast');
      if (t) t.classList.add('show');
    });
    setTimeout(() => {
      const t = root.querySelector('.toast');
      if (t) t.classList.remove('show');
      setTimeout(() => host.remove(), 300);
    }, 2800);
  } catch (e) {
    console.debug(TAG, 'toast failed:', e.message);
  }
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

async function fillCredential(formInfo, cred) {
  const mode = formInfo.mode || 'both';

  if ((mode === 'both' || mode === 'user-only') && formInfo.userInput) {
    setReactInputValue(formInfo.userInput, cred.username);
  }
  if ((mode === 'both' || mode === 'password-only') && formInfo.pwInput) {
    setReactInputValue(formInfo.pwInput, cred.password);
  }

  // 2-step login bookkeeping
  if (mode === 'user-only') {
    // ใส่ username เสร็จแล้ว — เก็บ cred ไว้ใช้ตอน password page โผล่
    await savePendingCredential(cred);
  } else {
    // both / password-only — log เสร็จแล้ว ไม่ต้องเก็บ
    await clearPendingCredential();
  }

  // ดึง paired user info (ถ้ามี) จาก chrome.storage
  let pairedUser = null;
  try {
    const r = await chrome.storage.sync.get(['pairedUser']);
    pairedUser = r.pairedUser || null;
  } catch {}

  const body = { source_url: location.href };
  if (pairedUser) {
    if (pairedUser.member_id) body.member_id = pairedUser.member_id;
    if (pairedUser.label) body.user_label = pairedUser.label;
    if (pairedUser.deviceLabel) body.device_label = pairedUser.deviceLabel;
  }
  // แจ้ง backend ว่า cred นี้ถูกใช้ — log เฉพาะ both หรือ password-only
  // (user-only ยังไม่นับว่า "ใช้" จนกว่าจะกรอก password ในหน้าถัดไป)
  if (mode !== 'user-only') {
    backendFetch('/api/extension/credentials/' + cred.id + '/used', {
      method: 'POST',
      body,
    }).catch(() => {});
  }
  console.debug(TAG, '✓ filled credential id=' + cred.id + ' label=' + (cred.label || '-')
    + ' mode=' + mode + ' as=' + (pairedUser ? pairedUser.label : '(unpaired)'));
}

function escapeHtmlSafe(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}

// === Prefill widget — ใช้ Shadow DOM เพื่อ isolate จาก page CSS ทั้งหมด ===
// (ป้องกันปัญหา z-index/stacking context/pointer-events ของหน้าเว็บ
//  เช่น ChatGPT, Tailwind modals ที่ครอบงำ widget)
let prefillWidget = null;   // = host element (เก็บไว้สำหรับ style.display ภายนอก)
let prefillRoot = null;     // = shadow root (querySelector ภายใน)
let prefillCreds = [];
let prefillFormInfo = null;
let prefillAccess = null;   // {via, reason, teams[], member_id} จาก backend

// CSS ที่จะ inline ใน Shadow DOM — ไม่อิง prefill.css (page CSS เข้าไม่ถึง shadow)
const PREFILL_SHADOW_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  #root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 13px; color: #e6ebf3;
    max-width: 320px;
    pointer-events: auto;
  }
  .fct-trigger {
    background: #4f8cff; color: #fff;
    border: none; border-radius: 999px;
    padding: 10px 16px; font-size: 13px; font-weight: 500;
    cursor: pointer;
    box-shadow: 0 6px 20px rgba(0,0,0,.35);
    display: flex; align-items: center; gap: 6px;
    font-family: inherit;
    pointer-events: auto;
  }
  .fct-trigger:hover { background: #3b78eb; }
  .fct-panel {
    background: #131a26; border: 1px solid #243044;
    border-radius: 12px; padding: 12px; width: 320px;
    box-shadow: 0 10px 30px rgba(0,0,0,.5);
    margin-bottom: 10px;
  }
  .fct-panel-head {
    display: flex; justify-content: space-between; align-items: center;
    font-weight: 600; margin-bottom: 8px;
  }
  .fct-close {
    background: none; border: none; color: #8b95a8;
    cursor: pointer; font-size: 16px; padding: 0 4px;
  }
  .fct-close:hover { color: #e6ebf3; }
  .fct-panel-sub { color: #8b95a8; font-size: 11px; margin-bottom: 8px; }
  .fct-cred {
    background: #1b2433; border: 1px solid #243044;
    border-radius: 8px; padding: 10px; margin-bottom: 6px;
    cursor: pointer; transition: border .15s;
  }
  .fct-cred:hover { border-color: #4f8cff; background: #232f44; }
  .fct-cred-label { font-size: 12px; color: #8b95a8; }
  .fct-cred-username {
    font-size: 13px; font-weight: 500; color: #e6ebf3;
    word-break: break-all;
  }
  .fct-empty {
    color: #8b95a8; font-size: 12px;
    text-align: center; padding: 14px;
  }
  .fct-empty a { color: #4f8cff; }
`;

function buildPrefillWidget() {
  if (prefillWidget) return;

  // Host element — ใช้ inline !important styles เพื่อ override page CSS แน่ๆ
  prefillWidget = document.createElement('div');
  prefillWidget.id = 'fct-prefill-host';
  prefillWidget.setAttribute('style', `
    position: fixed !important;
    bottom: 20px !important;
    right: 20px !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    isolation: isolate !important;
    contain: layout style !important;
    width: auto !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    transform: translateZ(0) !important;
  `);

  // Shadow DOM — encapsulate จาก page CSS/JS ทั้งหมด
  prefillRoot = prefillWidget.attachShadow({ mode: 'open' });
  prefillRoot.innerHTML = `
    <style>${PREFILL_SHADOW_CSS}</style>
    <div id="root">
      <div class="fct-panel" id="fct-panel" style="display:none">
        <div class="fct-panel-head">
          <span>🔑 FEFL Beat — เลือกบัญชี</span>
          <button class="fct-close" id="fct-close-btn">×</button>
        </div>
        <div class="fct-panel-sub" id="fct-panel-sub"></div>
        <div id="fct-cred-list"></div>
      </div>
      <button class="fct-trigger" id="fct-trigger">🔑 FEFL Beat : Sign On</button>
    </div>
  `;

  // Append ที่ <html> ไม่ใช่ <body> — escape body's stacking context
  // (บางเว็บใส่ transform/contain บน body ทำให้ position:fixed ใน body ถูก clip)
  (document.documentElement || document.body).appendChild(prefillWidget);

  prefillRoot.getElementById('fct-trigger').addEventListener('click', togglePrefillPanel);
  prefillRoot.getElementById('fct-close-btn').addEventListener('click', () => {
    prefillRoot.getElementById('fct-panel').style.display = 'none';
  });
}

function togglePrefillPanel() {
  const panel = prefillRoot.getElementById('fct-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
}

function renderPrefillList(siteName) {
  const list = prefillRoot.getElementById('fct-cred-list');
  // Header sub-text: site name + access source (badge)
  const sub = prefillRoot.getElementById('fct-panel-sub');
  let accessBadge = '';
  if (prefillAccess) {
    const via = prefillAccess.via;
    if (via === 'admin_paired') {
      accessBadge = `<div style="margin-top:4px;font-size:11px;padding:3px 7px;border-radius:6px;background:#fef3c7;color:#92400e;display:inline-block">⚠ admin-paired (bypass team filter)</div>`;
    } else if (via === 'team_all') {
      const names = (prefillAccess.teams || []).filter(t => t.access_type === 'all').map(t => t.name).join(', ');
      accessBadge = `<div style="margin-top:4px;font-size:11px;padding:3px 7px;border-radius:6px;background:#dcfce7;color:#166534;display:inline-block">✓ via Team: ${escapeHtmlSafe(names)} (all)</div>`;
    } else if (via === 'team_select') {
      const names = (prefillAccess.teams || []).map(t => t.name).join(', ');
      accessBadge = `<div style="margin-top:4px;font-size:11px;padding:3px 7px;border-radius:6px;background:#dbeafe;color:#1e40af;display:inline-block">✓ via Team: ${escapeHtmlSafe(names)} (select)</div>`;
    }
  }
  // mode badge — บอกว่ากำลังจะเติมอะไร (user-only / password-only / both)
  let modeBadge = '';
  const m = prefillFormInfo && prefillFormInfo.mode;
  if (m === 'user-only') {
    modeBadge = `<div style="margin-top:4px;font-size:11px;padding:3px 7px;border-radius:6px;background:#dbeafe;color:#1e40af;display:inline-block">📝 Step 1 — เลือก account → ระบบจะกรอก username ให้</div>`;
  } else if (m === 'password-only') {
    modeBadge = `<div style="margin-top:4px;font-size:11px;padding:3px 7px;border-radius:6px;background:#dbeafe;color:#1e40af;display:inline-block">🔑 Step 2 — เลือก account → ระบบจะกรอก password ให้</div>`;
  }
  sub.innerHTML = `เว็บ: ${escapeHtmlSafe(siteName)}${accessBadge}${modeBadge}`;

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
      prefillRoot.getElementById('fct-panel').style.display = 'none';
    });
  });
}

let prefillCheckInFlight = false;
let prefillNoFormLogged = false;   // กัน log spam — log เฉพาะครั้งแรก/หลัง URL เปลี่ยน
let prefillLastUrlForLog = null;
async function checkPrefill() {
  if (prefillCheckInFlight) return;
  prefillCheckInFlight = true;
  try {
    const formInfo = findLoginForm();
    if (!formInfo) {
      // ไม่มี login form → ซ่อน widget
      if (prefillWidget) prefillWidget.style.display = 'none';

      // Diagnostic — แสดงครั้งเดียวต่อ URL เพื่อช่วย debug
      if (location.href !== prefillLastUrlForLog) {
        prefillLastUrlForLog = location.href;
        prefillNoFormLogged = false;
      }
      if (!prefillNoFormLogged) {
        prefillNoFormLogged = true;
        const pwAll = deepQuerySelectorAll('input[type="password"]');
        const visiblePw = pwAll.filter(p => isInputVisible(p)).length;
        // List visible inputs (top 12) เพื่อช่วย debug
        const allInputs = deepQuerySelectorAll('input').filter(isInputVisible).slice(0, 12);
        const summary = allInputs.map(i => {
          const meta = i.name || i.id || i.placeholder || '(no-name)';
          return `[${i.type || 'text'}${i.autocomplete ? ' ac=' + i.autocomplete : ''}] ${meta}`;
        });

        // === IFRAME diagnostic — modal บางเว็บอยู่ใน iframe ===
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const sameOriginFrames = iframes.filter(f => {
          try { return !!f.contentDocument; } catch { return false; }
        });
        const crossOriginFrames = iframes.length - sameOriginFrames.length;
        let iframeHint = '';
        let iframePwTotal = 0;
        let iframeTextTotal = 0;
        const iframeUrls = [];
        for (const f of sameOriginFrames) {
          try {
            iframePwTotal += f.contentDocument.querySelectorAll('input[type="password"]').length;
            iframeTextTotal += f.contentDocument.querySelectorAll(
              'input[type="email"], input[type="text"]:not([type="hidden"])'
            ).length;
            iframeUrls.push(f.contentDocument.location.href || f.src || '(no-src)');
          } catch {}
        }
        if (iframes.length > 0) {
          iframeHint = `\n  iframes: ${iframes.length} total (${sameOriginFrames.length} same-origin, ${crossOriginFrames} cross-origin)`;
          if (iframePwTotal > 0 || iframeTextTotal > 0) {
            iframeHint += `\n  ⚠ พบใน same-origin iframe: ${iframePwTotal} password / ${iframeTextTotal} text/email`;
            iframeHint += `\n     iframe URLs: ${iframeUrls.join(', ').slice(0, 200)}`;
            iframeHint += `\n     → content.js ต้องรันใน iframe (ต้องมี all_frames:true ใน manifest)`;
          }
          if (crossOriginFrames > 0) {
            iframeHint += `\n  ⚠ มี cross-origin iframe — content.js รันแยก (ดู console ของ iframe context)`;
          }
        }

        // === Window context — เป็น popup window หรือไม่ ===
        const isPopupWindow = window.opener != null;
        const popupHint = isPopupWindow
          ? `\n  📦 หน้านี้คือ popup window (window.opener != null) — opener: ${window.opener.location ? window.opener.location.href : '(cross-origin)'}`
          : '';

        console.debug(TAG, '🔍 prefill: no login form detected on', location.href,
          `\n  password fields: ${pwAll.length} total, ${visiblePw} visible`,
          `\n  visible inputs (top 12):`, summary.length ? summary : '(none)',
          iframeHint + popupHint,
          pwAll.length === 0
            ? '\n  → ยังไม่เห็นช่อง password — อาจต้องคลิกปุ่มเปิดหน้า login/popup ก่อน'
            : visiblePw === 0
              ? '\n  → ช่อง password ถูกซ่อนอยู่'
              : '\n  → มีช่อง password แต่ container detection ล้มเหลว'
        );
      }
      return;
    }
    prefillNoFormLogged = false;
    prefillFormInfo = formInfo;

    // === SHORTCUT: มี pending → auto-fill ทันที ไม่ต้องถาม ===
    // รองรับทั้ง:
    //  - password-only (Step 2 มีแค่ password — Auth0 บางเทมเพลต)
    //  - both          (Step 2 แสดง email อ่านอย่างเดียว + password — เคส ChatGPT)
    if (formInfo.mode === 'password-only' || formInfo.mode === 'both') {
      const pending = await getPendingCredential();
      if (pending) {
        // Fill password เสมอ
        if (formInfo.pwInput) {
          setReactInputValue(formInfo.pwInput, pending.password);
        }
        // Fill username เฉพาะถ้าช่องว่าง — อย่า overwrite สิ่งที่ user/page ใส่ไว้แล้ว
        // (ChatGPT แสดง email ของ Step 1 ในช่อง read-only — เราไม่ต้องกรอกซ้ำ)
        if (formInfo.mode === 'both' && formInfo.userInput) {
          const existing = (formInfo.userInput.value || '').trim();
          if (!existing) {
            setReactInputValue(formInfo.userInput, pending.username);
          }
        }
        await clearPendingCredential();
        // log usage หลังกรอกครบ
        try {
          let pairedUser = null;
          const r = await chrome.storage.sync.get(['pairedUser']);
          pairedUser = r.pairedUser || null;
          const body = { source_url: location.href };
          if (pairedUser) {
            if (pairedUser.member_id) body.member_id = pairedUser.member_id;
            if (pairedUser.label) body.user_label = pairedUser.label;
            if (pairedUser.deviceLabel) body.device_label = pairedUser.deviceLabel;
          }
          backendFetch('/api/extension/credentials/' + pending.cred_id + '/used', {
            method: 'POST', body,
          }).catch(() => {});
        } catch {}
        if (prefillWidget) prefillWidget.style.display = 'none';
        showAutoFillToast(`✓ FEFL Beat: กรอก password ของ ${pending.username || pending.label || 'account'} ให้แล้ว`);
        console.debug(TAG, '🚀 auto-filled password from pending (mode=' + formInfo.mode + ', account:', pending.username, ')');
        return;
      }
      console.debug(TAG, formInfo.mode + ' detected, no pending → will show widget for manual pick');
      // ไม่มี pending → fall through to normal flow (โชว์ widget ให้เลือก)
    }

    // ตรวจ pairing status ก่อน — ถ้า unpaired ห้ามแสดง autofill เลย
    let pairedUserMatch = null;
    try {
      const r = await chrome.storage.sync.get(['pairedUser']);
      pairedUserMatch = r.pairedUser || null;
    } catch {}

    if (!pairedUserMatch) {
      // Unpaired = no identity context → ไม่ควรแสดง autofill ทุก site
      if (prefillWidget) prefillWidget.style.display = 'none';
      console.debug(TAG, '🔒 prefill: extension is UNPAIRED → autofill disabled. ไป admin → Extension → "เชื่อมบัญชีของฉัน"');
      return;
    }

    const memberQ = pairedUserMatch.member_id
      ? '&member_id=' + encodeURIComponent(pairedUserMatch.member_id)
      : '';

    let data;
    try {
      data = await backendFetch(
        '/api/extension/match?url=' + encodeURIComponent(location.href) + memberQ
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
    prefillAccess = data.access || null;

    // === DIAGNOSTIC LOG (เปิดให้ user ตรวจสอบสิทธิ์ได้ใน Console) ===
    const pairLabel = pairedUserMatch
      ? `${pairedUserMatch.role || '?'}:${pairedUserMatch.label || '?'} (member_id=${pairedUserMatch.member_id || 'null'})`
      : '(unpaired)';
    console.log(
      `${TAG} 🔑 prefill check:`,
      '\n  site         :', data.site.name,
      '\n  paired-as    :', pairLabel,
      '\n  via          :', prefillAccess ? prefillAccess.via : '(no access info)',
      '\n  reason       :', prefillAccess ? prefillAccess.reason : '(none)',
      '\n  teams matched:', prefillAccess ? prefillAccess.teams : [],
      '\n  credentials  :', prefillCreds.length,
    );

    // ถ้าไม่มี credential (ผู้ใช้ไม่มีสิทธิ์ผ่าน team) → ซ่อน widget เลย
    if (prefillCreds.length === 0) {
      if (prefillWidget) prefillWidget.style.display = 'none';
      console.warn(TAG, 'prefill: no credentials granted for', data.site.name, '— widget hidden');
      return;
    }

    buildPrefillWidget();
    prefillWidget.style.display = '';
    renderPrefillList(data.site.name);

    // เตือนถ้าผู้ใช้คาดว่าไม่ควรเห็น แต่ widget ยังโชว์ — บอกว่ามาจาก rule ไหน
    if (prefillAccess && prefillAccess.via === 'admin_paired') {
      console.warn(TAG, '⚠️  Extension is paired as ADMIN → bypasses all team filtering.',
        'หากต้องการ test team filter ให้ unpair แล้ว pair ใหม่ในฐานะ member');
    }
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
// PAGE BRIDGE — รับคำสั่งจากหน้า admin ผ่าน postMessage:
//   - FCT_FORCE_PING — active probe (ส่งให้ background ping backend)
//   - FCT_PAIR       — รับ config (Backend URL, API Key, ชื่อ user) มาเก็บ
// ============================================================================
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === 'FCT_FORCE_PING') {
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
        type: 'FCT_PING_RESULT', requestId: reqId,
        ok: false, error: e.message, version: SCRIPT_VERSION,
      }, '*');
    }
    return;
  }

  if (data.type === 'FCT_PAIR') {
    const reqId = data.requestId;
    const cfg = data.config || {};
    try {
      chrome.runtime.sendMessage({ type: 'PAIR', config: cfg }, (reply) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        window.postMessage({
          type: 'FCT_PAIR_RESULT',
          requestId: reqId,
          ok: !!(reply && reply.ok),
          error: (reply && reply.error) || err || null,
          version: SCRIPT_VERSION,
        }, '*');
      });
    } catch (e) {
      window.postMessage({
        type: 'FCT_PAIR_RESULT', requestId: reqId,
        ok: false, error: e.message, version: SCRIPT_VERSION,
      }, '*');
    }
    return;
  }

  // FCT_GET_PAIRING — admin page ขอเช็คว่า extension ตอนนี้ paired กับใคร
  if (data.type === 'FCT_GET_PAIRING') {
    const reqId = data.requestId;
    try {
      chrome.runtime.sendMessage({ type: 'GET_PAIRING' }, (reply) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        window.postMessage({
          type: 'FCT_PAIRING_RESULT',
          requestId: reqId,
          ok: !!(reply && reply.ok),
          pairedUser: reply ? reply.pairedUser : null,
          error: (reply && reply.error) || err || null,
          version: SCRIPT_VERSION,
        }, '*');
      });
    } catch (e) {
      window.postMessage({
        type: 'FCT_PAIRING_RESULT', requestId: reqId,
        ok: false, error: e.message, version: SCRIPT_VERSION,
      }, '*');
    }
    return;
  }

  // FCT_UNPAIR — เคลียร์ pairedUser ออกจาก chrome.storage
  if (data.type === 'FCT_UNPAIR') {
    const reqId = data.requestId;
    try {
      chrome.runtime.sendMessage({ type: 'UNPAIR' }, (reply) => {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
        window.postMessage({
          type: 'FCT_UNPAIR_RESULT',
          requestId: reqId,
          ok: !!(reply && reply.ok),
          error: (reply && reply.error) || err || null,
          version: SCRIPT_VERSION,
        }, '*');
      });
    } catch (e) {
      window.postMessage({
        type: 'FCT_UNPAIR_RESULT', requestId: reqId,
        ok: false, error: e.message, version: SCRIPT_VERSION,
      }, '*');
    }
    return;
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

// SPA navigation detection — content script รันใน isolated world ไม่เห็น
// pushState/replaceState ของ page → poll location.href ทุก 500ms
let _lastPolledUrl = location.href;
setInterval(() => {
  if (location.href !== _lastPolledUrl) {
    const oldUrl = _lastPolledUrl;
    _lastPolledUrl = location.href;
    console.debug(TAG, '🔄 URL changed:', oldUrl, '→', location.href, '— re-checking prefill');
    prefillNoFormLogged = false;   // reset log gate
    schedulePrefillCheck();
  }
}, 500);

// Safety net — re-check prefill ทุก 3 วินาที (กรณี MutationObserver พลาด event)
setInterval(() => schedulePrefillCheck(), 3000);

// ตอบ message จาก options page (Test selector button) + popup (Reset detect)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'RESET_AND_RESCAN') {
    chrome.storage.local.remove(['has_seen_high_confidence', 'last_tentative']).then(() => {
      _lockSkipLogged = false;   // reset session log gate
      console.log('%c[FCT] 🔓 confidence lock RESET — re-scanning now', 'color:#2563eb;font-weight:bold');
      // immediate rescan (bypass debounce)
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = setTimeout(async () => {
        scanTimer = null;
        const balance = await findBalance();
        if (balance != null) {
          const profileName = findProfileName();
          const profileEmail = findProfileEmail();
          const creditsSpent = findCreditsSpent();
          // bypass dedup — force send
          lastReportedBalance = null;
          reportBalance(balance, profileName, profileEmail, creditsSpent);
        }
      }, 100);
      sendResponse({ ok: true });
    });
    return true;
  }
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
