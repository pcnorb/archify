import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findChrome } from '../archify/bin/visual-check.mjs';
import { desktopBrowser } from './helpers/desktop-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..', 'archify');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-passport-scroll-'));
const chromePath = process.env.ARCHIFY_CHROME ? findChrome() : null;

// A small diagram has a short canvas. The Passport of its table lists the links,
// so it is taller than the canvas.
function hubDiagram(links) {
  const columns = Array.from({ length: 4 }, (_, i) => ({ name: `COLUMN_${i}`, type: 'INTEGER' }));
  const entities = [{ id: 'hub', label: 'HUB', pos: [320, 0], width: 240, attributes: [{ name: 'ID', type: 'INTEGER', key: 'pk' }, ...columns] }];
  const relationships = [];
  for (let i = 0; i < links; i += 1) {
    const id = `t${i}`;
    entities.push({ id, label: `TABLE_${i}`, pos: [i % 2 === 0 ? 0 : 640, Math.floor(i / 2) * 70], width: 200, attributes: [{ name: 'ID', type: 'INTEGER', key: 'pk' }] });
    relationships.push({ id: `r${i}`, from: 'hub', to: id, label: `LINK_${i}`, fromCardinality: 'many', toCardinality: 'one', fromSide: i % 2 === 0 ? 'left' : 'right', toSide: i % 2 === 0 ? 'right' : 'left' });
  }
  return {
    schema_version: 1,
    diagram_type: 'erd',
    meta: { title: 'Passport scroll', locale: 'en', output: 'passport-scroll.html', quality_profile: 'standard' },
    layout: { mode: 'grid' },
    entities,
    relationships,
  };
}

async function evaluate(browser, sessionId, expression, awaitPromise = false) {
  const response = await browser.cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Runtime.evaluate failed');
  }
  return response.result?.value;
}

test('the Semantic Passport scrolls inside a short canvas instead of being cut off', {
  skip: chromePath ? false : 'Set ARCHIFY_CHROME to run the real browser regression.',
}, async () => {
  const input = path.join(tmp, 'hub.json');
  const artifact = path.join(tmp, 'passport-scroll.html');
  fs.writeFileSync(input, JSON.stringify(hubDiagram(4)));
  execFileSync(process.execPath, [path.join(skillRoot, 'renderers/erd/render-erd.mjs'), input, artifact]);

  const browser = desktopBrowser(chromePath);
  try {
    const sessionId = await browser.sessionPromise;
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    const loaded = browser.cdp.waitFor('Page.loadEventFired', sessionId);
    await browser.cdp.send('Page.navigate', { url: pathToFileURL(artifact).href }, sessionId);
    await loaded;
    await evaluate(browser, sessionId, `document.documentElement.setAttribute('data-motion', 'still')`);
    assert.equal(await evaluate(browser, sessionId, `Archify.focus.set('hub', { toggle: false })`), true);
    await evaluate(browser, sessionId, `Archify.readerLayout.whenStable()`, true);
    // The list of links is opened with the "relations" button, as a reader would.
    await evaluate(browser, sessionId, `(function () { var b = document.getElementById('btn-focus-relations'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
    await evaluate(browser, sessionId, `new Promise(function (r) { setTimeout(function () { requestAnimationFrame(function () { requestAnimationFrame(r); }); }, 60); })`, true);
    const state = await evaluate(browser, sessionId, `(function () {
      var chip = document.getElementById('focus-chip');
      var box = document.querySelector('.diagram-container').getBoundingClientRect();
      var rect = chip.getBoundingClientRect();
      return { hidden: chip.hidden, chipTop: rect.top, chipBottom: rect.bottom, boxTop: box.top, boxBottom: box.bottom,
        scrolls: chip.scrollHeight > chip.clientHeight + 1, overflowY: getComputedStyle(chip).overflowY };
    })()`);
    assert.equal(state.hidden, false, JSON.stringify(state));
    assert.ok(state.chipTop >= state.boxTop - 1, JSON.stringify(state));
    assert.ok(state.chipBottom <= state.boxBottom + 1, `the Passport hangs below the canvas: ${JSON.stringify(state)}`);
  } finally {
    await browser.close();
  }
});
