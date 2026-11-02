import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../mods/quests/main.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quests-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'cache', 'quests');
  await fs.mkdir(dir, { recursive: true });
  const disk = Object.fromEntries(['readdir', 'readFile', 'writeFile', 'unlink'].map(name =>
    [name, (file, ...args) => fs[name](file.replaceAll('\\', '/'), ...args)]));
  const notices = [];
  const modules = {
    'gpui-kit': { View: class {}, div() {}, svg() {} },
    'gpui-base': { v_flex() {}, h_flex() {} },
    'fs/promises': { ...disk, ...overrides.fs?.(disk) },
    herdr: { agents: () => [], appHome: () => root, exec: overrides.exec ?? (async () => ({ code: 0, stdout: '' })),
      focused: () => ({}), notify: item => notices.push(item), openOverlay() {}, panes: () => [],
      props: () => ({}), run() {}, spaces: () => [], theme: () => ({}) },
  };
  const mod = new vm.SourceTextModule(source);
  await mod.link(async name => {
    const values = modules[name];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    });
  });
  await mod.evaluate();
  const view = new mod.namespace.default();
  Object.assign(view, { quests: [], writes: new Map(), canceling: new Set(), revision: 0, homes: { remote: '/fixture' } });
  const cx = { notify() {} };
  const put = async (file = 'quest.json') => {
    const quest = { file, machine: null, at: '2026-01-01T00:00:00Z', prompt: 'Fixture' };
    await fs.writeFile(path.join(dir, file), JSON.stringify(quest));
    view.quests.push(quest);
    return quest;
  };
  return { view, cx, put, dir, notices };
}

test('Cancel removes the file, survives refresh, and keeps other quests', async t => {
  const { view, cx, put, dir } = await fixture(t);
  const removed = await put('remove.json');
  await put('keep.json');
  await view.cancel(removed, cx);
  await assert.rejects(fs.access(path.join(dir, removed.file)), { code: 'ENOENT' });
  await view.list(cx);
  assert.deepEqual(view.quests.map(q => q.file), ['keep.json']);
});

test('Cancel waits for a checkbox save so it cannot recreate the file', async t => {
  const started = deferred(), release = deferred();
  const { view, cx, put, dir } = await fixture(t, { fs: disk => ({
    writeFile: async (...args) => { started.resolve(); await release.promise; return disk.writeFile(...args); },
  }) });
  const q = await put();
  view.toggle(q, 'verify:0', cx);
  await started.promise;
  const cancel = view.cancel(q, cx);
  await fs.access(path.join(dir, q.file));
  release.resolve();
  await cancel;
  await assert.rejects(fs.access(path.join(dir, q.file)), { code: 'ENOENT' });
  assert.deepEqual(view.quests, []);
});

test('A scan started before Cancel cannot restore the removed card', async t => {
  const read = deferred(), release = deferred();
  const { view, cx, put } = await fixture(t, { fs: disk => ({
    readFile: async (...args) => { const text = await disk.readFile(...args); read.resolve(); await release.promise; return text; },
  }) });
  const q = await put();
  const scan = view.list(cx);
  await read.promise;
  await view.cancel(q, cx);
  release.resolve();
  await scan;
  assert.deepEqual(view.quests, []);
});

test('Same filename on another machine is a different quest', async t => {
  const { view, cx, put } = await fixture(t);
  const local = await put();
  const remote = { ...local, machine: 'remote' };
  view.quests.push(remote);
  await view.cancel(local, cx);
  assert.deepEqual(view.quests, [remote]);
});

test('Local deletion failure retains the record and reports the failure', async t => {
  const { view, cx, put, dir, notices } = await fixture(t, { fs: () => ({
    unlink: async () => { throw new Error('Access denied'); },
  }) });
  const q = await put();
  await view.cancel(q, cx);
  await fs.access(path.join(dir, q.file));
  assert.deepEqual(view.quests, [q]);
  assert.equal(notices[0].body, 'Access denied');
  assert.equal(view.canceling.size, 0);
});

test('Remote command failure does not silently remove the card', async t => {
  const { view, cx, notices } = await fixture(t, { exec: async () => ({ code: 1, stderr: 'Permission denied' }) });
  const q = { file: 'quest.json', machine: 'remote' };
  view.quests = [q];
  await view.cancel(q, cx);
  assert.deepEqual(view.quests, [q]);
  assert.equal(notices[0].body, 'Permission denied');
  assert.equal(view.canceling.size, 0);
});
