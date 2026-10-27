// External-viewer output: split the parts of a rendered page that are the same
// for every diagram (viewer styles, viewer script, page markup, translation
// data) into content-hashed shared files, and keep only the diagram-specific
// parts in the page. Opt-in through ARCHIFY_EXTERNAL_VIEWER (--external-viewer).
//
// The shared parts are derived at render time: the standard template is filled
// once with placeholder values, and the real page is checked against that
// reference. If the real page does not match the reference exactly, the caller
// gets null and writes the ordinary standalone page, so output never degrades.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyTemplate } from './utils.mjs';

const SLOTS = { title: 'ARCHIFYEXT0TITLE0', sub: 'ARCHIFYEXT0SUB0', svg: 'ARCHIFYEXT0SVG0', cards: 'ARCHIFYEXT0CARDS0' };
const SLOT_RE = /ARCHIFYEXT0(TITLE|SUB|SVG|CARDS)0/g;
const MIN_SCRIPT_BYTES = 100_000;
const NOTICES_RE = /<script type="application\/json" id="archify-software-notices">([\s\S]*?)<\/script>/;

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 10);

// Pull the shared style and script blocks out of a page. Returns null when the
// page does not have the expected shape.
function extractShared(html) {
  const headEnd = html.indexOf('</head>');
  if (headEnd < 0) return null;
  const styles = [...html.slice(0, headEnd).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].filter((m) => m[1].length > MIN_SCRIPT_BYTES);
  if (styles.length === 0 || scripts.length !== 1) return null;
  return { styles, script: scripts[0] };
}

function strip(html, css, js, cssHref, jsHref, noticesHref) {
  const shared = extractShared(html);
  if (!shared) return null;
  if (shared.styles.map((m) => m[1]).join('\n') !== css || shared.script[1] !== js) return null;
  let out = html;
  // Replace from the end so earlier offsets stay valid.
  const spans = [
    ...shared.styles.map((m, i) => ({ m, text: i === 0 ? `<link rel="stylesheet" href="${cssHref}">` : '' })),
    { m: shared.script, text: `<script src="${jsHref}"></script>` },
  ].sort((a, b) => b.m.index - a.m.index);
  for (const { m, text } of spans) out = out.slice(0, m.index) + text + out.slice(m.index + m[0].length);
  // The license notices travel with the shared files, which hold the fonts.
  return out.replace(NOTICES_RE, `<link rel="license" href="${noticesHref}">`);
}

function bodyBounds(html) {
  const open = /<body\b[^>]*>/.exec(html);
  const close = html.lastIndexOf('</body>');
  if (!open || close < 0) return null;
  return { start: open.index + open[0].length, end: close };
}

function writeShared(file, content) {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

const relativeHref = (fromFile, toFile) => {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

// Returns the external-viewer page for `args`, or null when the standard page
// must be used. `args` are the applyTemplate options of the real page.
export function externalViewerHtml(template, args, outPath, assetsDir) {
  if (args.sourceEvidence) return null;
  const real = applyTemplate(template, args);
  const ref = applyTemplate(template, {
    ...args,
    title: SLOTS.title,
    subtitle: args.subtitle && String(args.subtitle).trim() ? SLOTS.sub : args.subtitle,
    svg: SLOTS.svg,
    cards: SLOTS.cards,
  });
  const refShared = extractShared(ref);
  if (!refShared) return null;
  const css = refShared.styles.map((m) => m[1]).join('\n');
  const js = refShared.script[1];
  const cssFile = path.join(assetsDir, `archify-viewer.${sha(css)}.css`);
  const jsFile = path.join(assetsDir, `archify-viewer.${sha(js)}.js`);
  const notices = NOTICES_RE.exec(ref);
  if (!notices || !NOTICES_RE.test(real)) return null;
  const noticesText = JSON.parse(notices[1]);
  const noticesFile = path.join(assetsDir, `archify-notices.${sha(noticesText)}.txt`);
  const hrefs = [relativeHref(outPath, cssFile), relativeHref(outPath, jsFile), relativeHref(outPath, noticesFile)];
  const refPage = strip(ref, css, js, ...hrefs);
  const realPage = strip(real, css, js, ...hrefs);
  if (!refPage || !realPage) return null;
  const rb = bodyBounds(refPage);
  const pb = bodyBounds(realPage);
  if (!rb || !pb) return null;
  const refBody = refPage.slice(rb.start, rb.end);
  const realBody = realPage.slice(pb.start, pb.end);

  // Walk the reference body: literal pieces between slot placeholders.
  const pieces = [];
  const names = [];
  let last = 0;
  for (const m of refBody.matchAll(SLOT_RE)) {
    // A slot inside a tag would need attribute escaping; use the standard page.
    const before = refBody.slice(0, m.index);
    if (before.lastIndexOf('<') > before.lastIndexOf('>')) return null;
    pieces.push(refBody.slice(last, m.index));
    names.push(m[1].toLowerCase());
    last = m.index + m[0].length;
  }
  pieces.push(refBody.slice(last));
  if (!names.includes('svg')) return null;

  // Read each slot value out of the real body.
  const values = {};
  let pos = 0;
  if (!realBody.startsWith(pieces[0])) return null;
  pos = pieces[0].length;
  for (let i = 0; i < names.length; i += 1) {
    const next = pieces[i + 1];
    const idx = next === '' ? realBody.length : realBody.indexOf(next, pos);
    if (idx < 0) return null;
    const value = realBody.slice(pos, idx);
    if (names[i] in values && values[names[i]] !== value) return null;
    values[names[i]] = value;
    pos = idx + next.length;
  }
  // Rebuilding the page from the shared parts must give the same body.
  let rebuilt = pieces[0];
  names.forEach((name, i) => { rebuilt += values[name] + pieces[i + 1]; });
  if (rebuilt !== realBody) return null;

  const chrome = pieces.reduce((acc, piece, i) => acc + piece + (i < names.length ? `\0${names[i]}\0` : ''), '');
  const shell = `var T=${JSON.stringify(chrome)};
(function(){
  var g=function(id){var e=document.getElementById('archify-slot-'+id);return e?e.innerHTML:''};
  var h=T.replace(/\\0(title|sub|svg|cards)\\0/g,function(_,k){return g(k)});
  var t=document.querySelectorAll('template[id^=archify-slot-]');
  document.write(h);
  for(var i=0;i<t.length;i++)t[i].parentNode.removeChild(t[i]);
})();
`;
  const shellFile = path.join(assetsDir, `archify-shell.${sha(shell)}.js`);
  writeShared(cssFile, css);
  writeShared(jsFile, js);
  writeShared(shellFile, shell);
  writeShared(noticesFile, `${noticesText}\n`);

  const slots = [...new Set(names)]
    .map((name) => `<template id="archify-slot-${name}">${values[name]}</template>`)
    .join('\n');
  const page = `${slots}\n<script src="${relativeHref(outPath, shellFile)}"></script>\n`;
  return realPage.slice(0, pb.start) + page + realPage.slice(pb.end);
}
