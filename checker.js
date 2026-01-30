// checker.js
// Usage: node checker.js
// Installs: npm install puppeteer

const puppeteer = require('puppeteer');
const fs = require('fs');

const URL = 'https://rifugiolagazuoi.com/EN/disponibilita.php?prm=8&chm=-1#TabDisp';

// Configure the date range and minimum beds to check
// Set these numbers before running: START_DAY (inclusive), END_DAY (inclusive), MIN_BEDS
const START_DAY = 21; // example: 24
const END_DAY = 21;   // example: 30
const MIN_BEDS = 2;   // example: require at least 1 bed to be considered available

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

  let lastDialog = null;
  page.on('dialog', async dialog => {
    lastDialog = dialog.message();
    try { await dialog.dismiss(); } catch (e) { /* ignore */ }
  });

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table', { timeout: 10000 });
  } catch (err) {
    console.error('Failed to load page or find table:', err.message);
    await browser.close();
    process.exit(1);
  }

  // (Debug outputs disabled) find table handle silently for internal use if needed
  const tableHandle = await page.$('table');
  const tableHTML = tableHandle ? await page.evaluate(el => el.outerHTML, tableHandle) : null;

  // Collect clickable elements inside each table cell and write to JSON
  const cellClickables = await page.$$eval('td', (tds) => {
    return Array.from(tds).map((td, cellIdx) => {
      const clickables = [];
      function add(el, type) {
        const rect = el.getBoundingClientRect();
        clickables.push({
          type,
          tag: el.tagName.toLowerCase(),
          text: el.innerText.trim(),
          onclick: el.getAttribute('onclick'),
          href: el.getAttribute('href'),
          datasetKeys: Object.keys(el.dataset),
          role: el.getAttribute('role'),
          style: el.getAttribute('style') || null,
          bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        });
      }

      td.querySelectorAll('a, button, [onclick], [role="button"], [data-href], [data-toggle], [tabindex]').forEach(el => add(el, 'explicit'));
      td.querySelectorAll('*').forEach(el => {
        const s = el.getAttribute('style') || '';
        if (s.includes('cursor:pointer') || s.includes('cursor: pointer')) add(el, 'style-cursor');
      });

      return { cellIdx, html: td.innerHTML, clickables };
    });
  });

  // Clickable elements collected (debug output disabled)

  // Find cells with class 'libero' and print their contents
  const liberoCells = await page.$$eval('td.libero', tds => tds.map(td => {
    const a = td.querySelector('a');
    return {
      text: td.innerText.trim(),
      html: td.innerHTML,
      anchor: a ? { href: a.href, text: a.innerText.trim(), onclick: a.getAttribute('onclick') } : null
    };
  }));

  // Collected liberoCells (debug output disabled)

  // Now click each libero cell's clickable element and read .reveal-overlay > .dettagli text to extract available beds
  const liberoResults = [];
  const liberoHandles = await page.$$('td.libero');
  for (let i = 0; i < liberoHandles.length; i++) {
    const td = liberoHandles[i];
    const anchor = await td.$('a');
    const clickTarget = anchor || td;
    let dettagliText = null;
    let beds = null;
    try {
      // Click and wait briefly for overlay
      try {
        await clickTarget.click({ button: 'left' });
      } catch (e) {
        // Fallback to dispatch click in page context
        await page.evaluate(el => el.click(), clickTarget);
      }

      // Wait for overlay with .dettagli
      try {
        await page.waitForSelector('.reveal-overlay .dettagli', { visible: true, timeout: 3000 });
        dettagliText = await page.$eval('.reveal-overlay .dettagli', el => el.innerText.trim());
      } catch (e) {
        // Maybe overlay appears but .dettagli not visible; try to find overlay and then the dettagli child
        try {
          await page.waitForSelector('.reveal-overlay', { visible: true, timeout: 3000 });
          dettagliText = await page.$eval('.reveal-overlay .dettagli', el => el ? el.innerText.trim() : null).catch(()=>null);
        } catch (e2) {
          dettagliText = null;
        }
      }

      // Extract number of beds from the dettagli text
      if (dettagliText) {
        const m = dettagliText.match(/(\d+)\s*(?:beds?|bed|posti letto|posti|Posti letto|posti)/i);
        if (m) beds = parseInt(m[1], 10);
        else {
          const m2 = dettagliText.match(/(\d+)/);
          beds = m2 ? parseInt(m2[1], 10) : null;
        }
      }

      // Try to close overlay
      try {
        await page.evaluate(() => {
          const closeSelectors = ['.reveal-overlay .close', '.reveal-overlay .reveal-close', '.reveal-overlay .close-button', '.reveal-overlay .primaryClose'];
          for (const sel of closeSelectors) {
            const btn = document.querySelector(sel);
            if (btn) { btn.click(); return; }
          }
          // fallback: click overlay background to close
          const overlay = document.querySelector('.reveal-overlay');
          if (overlay) overlay.click();
        });
        await page.keyboard.press('Escape').catch(()=>{});
        // wait for overlay to disappear
        await page.waitForSelector('.reveal-overlay', { hidden: true, timeout: 3000 }).catch(()=>{});
      } catch (e) {}

    } catch (err) {
      console.error('Error clicking libero cell', i, err.message);
    }

    const tdText = (await (await td.getProperty('innerText')).jsonValue()).trim();
    liberoResults.push({ index: i, text: tdText, anchor: anchor ? { href: await (await anchor.getProperty('href')).jsonValue(), text: (await (await anchor.getProperty('innerText')).jsonValue()).trim() } : null, dettagliText, beds });
  }

  // Results collected (no files written)

  // Build a map of day number -> beds and print only the specified range
  const dateBedsMap = {};
  liberoResults.forEach(r => {
    const label = (r.text && r.text.split('\n')[0]) || (r.anchor && r.anchor.text) || null;
    const day = label ? parseInt(label, 10) : NaN;
    if (!Number.isNaN(day)) dateBedsMap[day] = (r.beds !== null && r.beds !== undefined) ? r.beds : null;
  });

  for (let d = START_DAY; d <= END_DAY; d++) {
    const beds = Object.prototype.hasOwnProperty.call(dateBedsMap, d) ? dateBedsMap[d] : undefined;
    if (beds === undefined || beds === null || beds < MIN_BEDS) {
      console.log(`${d}: unavailable`);
    } else {
      console.log(`${d}: ${beds}`);
    }
  }

  await browser.close();
  process.exit(0);
})();