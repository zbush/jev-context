import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, readFile, symlink, stat, open } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pruneStorage, withStorage, STORAGE_LIMIT_BYTES } from '../src/storage.mjs';

const fixture = () => mkdtemp(path.join(os.tmpdir(), 'jev-retention-'));
async function run(root, { id = randomUUID(), parent, date = '2026-01-01', size = 1000 } = {}) {
  const dir = path.join(root, id);
  await mkdir(dir);
  await writeFile(path.join(dir, 'record.json'), JSON.stringify({ id, operation: parent ? 'expand' : 'search',
    source_retrieval_id: parent, timestamp: date, status: 'ok' }));
  await writeFile(path.join(dir, 'actual.txt'), 'x'.repeat(size));
  return id;
}
async function bytes(root) {
  let total = 0;
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of await readdir(path.join(root, dir.name))) total += (await stat(path.join(root, dir.name, file))).size;
  }
  return total;
}

test('fixed decimal 200 MB cap prunes oldest original search and all its expansions', async () => {
  assert.equal(STORAGE_LIMIT_BYTES, 200_000_000);
  const root = await fixture();
  const old = await run(root);
  const newer = await run(root, { date: '2026-02-01' });
  const expansion = await run(root, { parent: old, date: '2026-03-01' });
  const result = await pruneStorage(root, 2000);
  assert.deepEqual(new Set(result.removed), new Set([old, expansion]));
  assert.deepEqual(await readdir(root), [newer]);
  assert.ok(result.bytes < 2000);
});

test('below cap is preserved; exact cap triggers pruning; oversized newest group can be removed', async () => {
  const root = await fixture(), id = await run(root), total = await bytes(root);
  assert.deepEqual((await pruneStorage(root, total + 1)).removed, []);
  assert.deepEqual((await pruneStorage(root, total)).removed, [id]);
  const big = await run(root);
  assert.deepEqual((await pruneStorage(root, 1)).removed, [big]);
});

test('active expansion protects parent and incomplete child while other groups can be pruned', async () => {
  const root = await fixture(), parent = await run(root), newer = await run(root, { date: '2026-02-01' });
  const child = randomUUID();
  await withStorage(root, parent, async () => {
    await mkdir(path.join(root, child));
    await writeFile(path.join(root, child, 'actual.txt'), 'partial');
    const result = await pruneStorage(root, 1);
    assert.deepEqual(result.removed, [newer]);
    assert.ok((await readdir(root)).includes(parent));
    assert.ok((await readdir(root)).includes(child));
  }, child);
  assert.ok(!(await readdir(root)).some(name => name.startsWith('.active-')));
  assert.equal((await pruneStorage(root, 1)).removed.length, 2);
});

test('leases release on errors, and simultaneous operations protect the same parent', async () => {
  const root = await fixture(), parent = await run(root);
  await assert.rejects(withStorage(root, parent, async () => { throw new Error('test failure'); }), /test failure/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const first = withStorage(root, parent, async () => { ready(); await gate; });
  await entered;
  await withStorage(root, parent, async () => assert.deepEqual((await pruneStorage(root, 1)).removed, []));
  assert.deepEqual((await pruneStorage(root, 1)).removed, []);
  release(); await first;
  assert.deepEqual((await pruneStorage(root, 1)).removed, [parent]);
});

test('unrelated directories, nested content, and symlink targets are not deleted', async () => {
  const root = await fixture(), external = await fixture();
  await writeFile(path.join(external, 'sentinel'), 'keep');
  await symlink(external, path.join(root, randomUUID()), process.platform === 'win32' ? 'junction' : 'dir');
  const nested = path.join(root, randomUUID());
  await mkdir(path.join(nested, 'nested'), { recursive: true });
  await mkdir(path.join(root, 'unrelated'));
  const managed = await run(root);
  assert.deepEqual((await pruneStorage(root, 1)).removed, [managed]);
  assert.equal(await readFile(path.join(external, 'sentinel'), 'utf8'), 'keep');
  assert.equal((await readdir(root)).length, 3);
});

test('another process holds a live lease; a crashed process lease is recovered', async () => {
  const root = await fixture(), parent = await run(root);
  const moduleUrl = new URL('../src/storage.mjs', import.meta.url).href;
  const script = `import { withStorage } from ${JSON.stringify(moduleUrl)};
    await withStorage(${JSON.stringify(root)}, ${JSON.stringify(parent)}, async () => {
      console.log('ready'); await new Promise(resolve => process.stdin.once('data', resolve));
    }); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const closed = once(child, 'exit');
    await once(child.stdout, 'data');
    assert.deepEqual((await pruneStorage(root, 1)).removed, []);
    child.stdin.write('finish');
    assert.equal((await closed)[0], 0);
  } finally { child.kill(); }
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import { withStorage } from ${JSON.stringify(moduleUrl)};
     await withStorage(${JSON.stringify(root)}, ${JSON.stringify(parent)}, () => process.exit(0));`]);
  assert.ok((await readdir(root)).some(name => name.startsWith('.active-')));
  assert.deepEqual((await pruneStorage(root, 1)).removed, [parent]);
  assert.deepEqual(await readdir(root), []);
});

test('automatic cleanup enforces the production cap after a completed operation', async () => {
  const root = await fixture(), id = randomUUID();
  await withStorage(root, id, async () => {
    await run(root, { id });
    const file = await open(path.join(root, id, 'actual.txt'), 'r+');
    try { await file.truncate(STORAGE_LIMIT_BYTES); } finally { await file.close(); }
    assert.ok((await readdir(root)).includes(id));
  });
  assert.deepEqual(await readdir(root), []);
});
