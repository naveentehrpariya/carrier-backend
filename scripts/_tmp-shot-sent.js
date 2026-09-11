// Prove the "already sent" actions are visible: publish once, then screenshot step 3
// and read back the computed colour of each button.
const path = require('path');
const { launchBrowser } = require('../utils/puppeteer');
const OUT = process.env.SHOT_DIR || '/tmp';
const BASE = 'http://localhost:3000';
const API = 'http://localhost:8080';
const FIX = path.join(__dirname, '..', '__fixtures__', 'fuel');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  try {
    const s = await (await fetch(`${API}/user/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'demo' },
      body: JSON.stringify({ email: 'admin@crossmiles.com', password: 'Demo12345!', tenantId: 'demo' }),
    })).json();
    if (!s.token) throw new Error(s.message);
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((ss) => {
      localStorage.setItem('token', ss.token);
      localStorage.setItem('user', JSON.stringify(ss.user));
      localStorage.setItem('tenantContext', JSON.stringify({ tenant: { tenantId: 'demo', subdomain: 'demo' } }));
    }, s);

    // one known-vendor sheet, priced and published, so step 3 has a sent row
    const token = s.token;
    const h = { Authorization: `Bearer ${token}`, 'X-Tenant-ID': 'demo', 'Content-Type': 'application/json' };
    const list = await (await fetch(`${API}/fuel/sheets`, { headers: h })).json();
    for (const sh of list.sheets || []) await fetch(`${API}/fuel/sheets/remove/${sh._id}`, { headers: h });

    await page.goto(`${BASE}/fuel`, { waitUntil: 'networkidle2' });
    await sleep(2000);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /add a price sheet/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(900);
    (await page.$('input[type=file]')).uploadFile(path.join(FIX, 'flying-j-cad-2026-09-09.pdf'));
    await sleep(600);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /read sheet/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(5000);

    const sheets = await (await fetch(`${API}/fuel/sheets`, { headers: h })).json();
    const id = sheets.sheets[0]._id;
    await fetch(`${API}/fuel/sheets/${id}/publish`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.05' }], title: 'Fuel Price Sheet' }),
    });

    await page.goto(`${BASE}/fuel/sheets/${id}`, { waitUntil: 'networkidle2' });
    await sleep(3500);
    // open step 3
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Send it out/i.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(1500);

    const colours = await page.evaluate(() => {
      const out = [];
      [...document.querySelectorAll('button')].forEach((b) => {
        const t = (b.textContent || '').trim();
        if (!/^(View|CSV)$/.test(t)) return;
        const cs = getComputedStyle(b);
        out.push({ label: t, color: cs.color, background: cs.backgroundColor, border: cs.borderColor });
      });
      return out;
    });
    console.log('  computed styles:', JSON.stringify(colours));

    await page.screenshot({ path: path.join(OUT, 'sent-actions.png') });
    console.log('  shot sent-actions');
  } finally { await browser.close(); }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
