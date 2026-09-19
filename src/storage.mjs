import { mkdir, realpath, readdir, lstat, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STORAGE_LIMIT_BYTES = 200_000_000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const runFiles = new Set(['record.json', 'record.tmp', 'baseline.txt', 'filtered.txt', 'actual.txt']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A short filesystem lock coordinates lease registration and pruning across processes.
// Never steal a lock based on age: a paused writer may still own it.
async function locked(dataDir, fn) {
  await mkdir(dataDir, { recursive: true });
  const root = await realpath(dataDir), lock = path.join(root, '.storage-lock');
  const started = Date.now();
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() - started > 10000) throw new Error('Telemetry storage is locked. If no Jev process is running, remove .storage-lock from the telemetry directory and retry.');
      await sleep(50);
    }
  }
  try { return await fn(root); }
  finally { await rmdir(lock); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function pruneLocked(root, limit) {
  const entries = await readdir(root, { withFileTypes: true });
  const protectedGroups = new Set(), activeRuns = new Map(), groups = new Map();
  // Leases are registered before a run directory is created or a parent is read.
  for (const entry of entries) {
    if (!/^\.active-[a-f0-9-]{36}\.json$/.test(entry.name) || !entry.isFile()) continue;
    const filename = path.join(root, entry.name);
    const lease = JSON.parse(await readFile(filename, 'utf8'));
    if (alive(lease.pid)) { protectedGroups.add(lease.group); activeRuns.set(lease.run, lease.group); }
    else await unlink(filename);
  }
  for (const entry of entries) {
    if (!uuid.test(entry.name) || !entry.isDirectory()) continue;
    if (activeRuns.has(entry.name)) continue; // Payloads may be mid-write or record.tmp may be renamed.
    const directory = path.join(root, entry.name);
    const files = await readdir(directory, { withFileTypes: true });
    // Refuse unfamiliar contents and symlinks. Delete only our flat run files.
    if (files.some(f => !f.isFile() || !runFiles.has(f.name))) continue;
    let bytes = 0;
    for (const file of files) bytes += (await lstat(path.join(directory, file.name))).size;
    let record;
    const recordFile = files.find(f => f.name === 'record.json') ?? files.find(f => f.name === 'record.tmp');
    if (recordFile) {
      try { record = JSON.parse(await readFile(path.join(directory, recordFile.name), 'utf8')); }
      catch { continue; } // Preserve corrupt records for diagnosis rather than guessing ownership.
      if (record.id !== entry.name) continue;
    }
    const groupId = activeRuns.get(entry.name) ?? (uuid.test(record?.source_retrieval_id || '') ? record.source_retrieval_id : entry.name);
    const group = groups.get(groupId) ?? { id: groupId, runs: [], bytes: 0, time: Infinity };
    const time = Date.parse(record?.timestamp) || (await lstat(directory)).mtimeMs;
    group.runs.push({ id: entry.name, directory, files: files.map(f => f.name) });
    group.bytes += bytes;
    if (entry.name === groupId) group.time = time;
    groups.set(groupId, group);
  }
  let bytes = [...groups.values()].reduce((sum, g) => sum + g.bytes, 0);
  const removed = [];
  for (const group of [...groups.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))) {
    if (bytes < limit) break;
    if (protectedGroups.has(group.id)) continue;
    // Children first; preserve the parent if a dependent file cannot be removed.
    group.runs.sort((a, b) => Number(a.id === group.id) - Number(b.id === group.id));
    for (const run of group.runs) {
      const resolved = await realpath(run.directory);
      if (path.dirname(resolved) !== root || (await lstat(run.directory)).isSymbolicLink()) throw new Error('Unsafe telemetry directory during pruning.');
      for (const file of run.files) await unlink(path.join(resolved, file));
      await rmdir(resolved);
      removed.push(run.id);
    }
    bytes -= group.bytes;
  }
  return { bytes, removed };
}

// limit is an internal test seam, deliberately absent from user configuration.
export async function pruneStorage(dataDir, limit = STORAGE_LIMIT_BYTES) {
  return locked(dataDir, root => pruneLocked(root, limit));
}

export async function withStorage(dataDir, group, operation, run = group) {
  const leaseName = `.active-${randomUUID()}.json`;
  await locked(dataDir, async root => {
    await writeFile(path.join(root, leaseName), JSON.stringify({ pid: process.pid, group, run }), { flag: 'wx', mode: 0o600 });
    try { await pruneLocked(root, STORAGE_LIMIT_BYTES); }
    catch (error) { await unlink(path.join(root, leaseName)); throw error; }
  });
  try { return await operation(); }
  finally {
    await locked(dataDir, async root => {
      await unlink(path.join(root, leaseName));
      await pruneLocked(root, STORAGE_LIMIT_BYTES);
    });
  }
}
