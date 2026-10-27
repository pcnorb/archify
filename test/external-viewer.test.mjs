import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../archify/', import.meta.url));
const cli = path.join(root, 'bin/archify.mjs');
const erd = path.join(root, 'examples/orders.erd.json');
const workflow = path.join(root, 'examples/agent-tool-call.workflow.json');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-external-viewer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const run = (args, cwd) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

test('--external-viewer keeps the shared viewer parts in files beside the pages', (t) => {
  const dir = workspace(t);
  const standalone = run(['render', 'erd', erd, 'standalone.html'], dir);
  assert.equal(standalone.status, 0, standalone.stderr);
  // Two pages at different depths share one asset set.
  const first = run(['render', 'erd', erd, 'pages/one.html', '--external-viewer', 'shared'], dir);
  const second = run(['render', 'workflow', workflow, 'pages/deep/two.html', '--external-viewer=shared'], dir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const full = fs.readFileSync(path.join(dir, 'standalone.html'), 'utf8');
  const page = fs.readFileSync(path.join(dir, 'pages/one.html'), 'utf8');
  assert.ok(page.length < full.length / 5, `external page ${page.length} bytes vs standalone ${full.length}`);
  assert.doesNotMatch(page, /archify-i18n-data|archify-software-notices/);
  assert.match(page, /<link rel="stylesheet" href="\.\.\/shared\/archify-viewer\.[0-9a-f]{10}\.css">/);
  assert.match(page, /<link rel="license" href="\.\.\/shared\/archify-notices\.[0-9a-f]{10}\.txt">/);
  assert.match(page, /<script src="\.\.\/shared\/archify-shell\.[0-9a-f]{10}\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(dir, 'pages/deep/two.html'), 'utf8'), /href="\.\.\/\.\.\/shared\/archify-viewer\./);

  const assets = fs.readdirSync(path.join(dir, 'shared'));
  assert.equal(assets.filter((name) => /^archify-viewer\..*\.css$/.test(name)).length, 1);
  assert.equal(assets.filter((name) => /^archify-viewer\..*\.js$/.test(name)).length, 1);
  assert.equal(assets.filter((name) => /^archify-notices\..*\.txt$/.test(name)).length, 1);
  // The ERD renderer's in-diagram style block moves to a shared file too.
  // One file for each distinct rule set (the ERD page and the workflow page differ).
  assert.equal(assets.filter((name) => /^archify-diagram\..*\.css$/.test(name)).length, 2);
  assert.doesNotMatch(page, /<style\b/);
  assert.match(page, /<link rel="stylesheet" href="\.\.\/shared\/archify-diagram\.[0-9a-f]{10}\.css">/);
  // Page-specific markup stays in the page; the shell restores the rest.
  const slots = [...page.matchAll(/<template id="archify-slot-(\w+)">/g)].map((m) => m[1]);
  assert.ok(slots.includes('svg') && slots.includes('title'), slots.join(','));
  assert.equal((page.match(/<svg\b/g) || []).length, (full.match(/<svg\b/g) || []).length);
  const notices = fs.readFileSync(path.join(dir, 'shared', assets.find((name) => name.startsWith('archify-notices.'))), 'utf8');
  assert.match(notices, /Apache License/);
});

test('without the option the output does not change', (t) => {
  const dir = workspace(t);
  assert.equal(run(['render', 'erd', erd, 'a.html'], dir).status, 0);
  assert.equal(run(['render', 'erd', erd, 'b.html'], dir).status, 0);
  const page = fs.readFileSync(path.join(dir, 'a.html'), 'utf8');
  assert.equal(page, fs.readFileSync(path.join(dir, 'b.html'), 'utf8'));
  assert.match(page, /archify-i18n-data/);
  assert.doesNotMatch(page, /archify-shell/);
  assert.equal(fs.existsSync(path.join(dir, 'shared')), false);
});

test('--external-viewer requires a directory', (t) => {
  const result = run(['render', 'erd', erd, 'a.html', '--external-viewer'], workspace(t));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--external-viewer requires a directory path/);
});
