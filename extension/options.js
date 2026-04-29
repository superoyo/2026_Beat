// options.js — read/write extension settings + run "test selector" against
// the active freepik.com tab.

const DEFAULT_BACKEND = 'http://localhost:8765';

const $ = id => document.getElementById(id);

async function load() {
  const r = await chrome.storage.sync.get(['customSelector', 'backendUrl', 'apiKey']);
  $('customSelector').value = r.customSelector || '';
  $('backendUrl').value = r.backendUrl || DEFAULT_BACKEND;
  $('apiKey').value = r.apiKey || '';
}

async function save() {
  const customSelector = $('customSelector').value.trim();
  const backendUrl = $('backendUrl').value.trim() || DEFAULT_BACKEND;
  const apiKey = $('apiKey').value.trim();
  await chrome.storage.sync.set({ customSelector, backendUrl, apiKey });
  $('saveStatus').textContent = 'บันทึกแล้ว ✓';
  setTimeout(() => { $('saveStatus').textContent = ''; }, 2500);
}

async function testSelector() {
  const selector = $('customSelector').value.trim();
  const out = $('testResult');
  out.style.display = '';
  out.className = 'test-result';

  if (!selector) {
    out.classList.add('warn');
    out.textContent = 'กรุณาใส่ selector ก่อนทดสอบ';
    return;
  }

  // หาแท็บ freepik.com / magnific.{com,ai} ที่ active อยู่
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const HOSTS_RE = /^https:\/\/[^/]*\.(?:freepik\.com|magnific\.(?:com|ai))\//i;
  if (!tab || !tab.url || !HOSTS_RE.test(tab.url)) {
    out.classList.add('warn');
    out.textContent = 'กรุณาเปิดแท็บ freepik.com หรือ magnific.com ก่อน แล้วลองอีกครั้ง';
    return;
  }

  try {
    const reply = await chrome.tabs.sendMessage(tab.id, {
      type: 'TEST_SELECTOR',
      selector,
    });
    if (!reply || !reply.ok) {
      out.classList.add('error');
      out.textContent = 'Selector ผิดพลาด: ' + (reply?.error || 'unknown');
      return;
    }
    if (reply.count === 0) {
      out.classList.add('warn');
      out.textContent = 'ไม่พบ element ที่ตรงกับ selector นี้';
      return;
    }
    out.classList.add('ok');
    const lines = [
      `พบ ${reply.count} element`,
      ...reply.matches.slice(0, 10).map((m, i) =>
        `  [${i + 1}] parsed=${m.parsed ?? '(ไม่ใช่ตัวเลข)'}  text="${m.text}"`
      ),
    ];
    if (reply.matches.length > 10) lines.push(`  …และอีก ${reply.matches.length - 10} ตัว`);
    out.textContent = lines.join('\n');
  } catch (e) {
    out.classList.add('error');
    out.textContent = 'ส่งข้อความถึง content script ไม่ได้: ' + e.message
      + '\n(ลอง reload หน้า freepik.com / magnific.com หนึ่งครั้ง)';
  }
}

$('saveBtn').addEventListener('click', save);
$('testBtn').addEventListener('click', testSelector);

load();
