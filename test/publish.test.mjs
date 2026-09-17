import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('publish guard accepts blank examples and blocks raw results and exact keys without printing values', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'jev-publish-test-'));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init');
  writeFileSync(path.join(cwd, '.env.example'), 'TYPESAFE_API_KEY=\nTYPESAFE_MODEL=jev-latest\n');
  git('add', '.env.example');
  const credential = ['test', 'only', 'credential', 'value'].join('-');
  const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-publish.mjs', import.meta.url))],
    { cwd, encoding: 'utf8', env: { ...process.env, TYPESAFE_API_KEY: credential } });
  assert.equal(check().status, 0);
  writeFileSync(path.join(cwd, 'runs.csv'), 'raw benchmark content');
  git('add', 'runs.csv');
  assert.equal(check().status, 1);
  git('rm', '--cached', 'runs.csv');
  writeFileSync(path.join(cwd, 'settings.json'), JSON.stringify({ key: credential }));
  git('add', 'settings.json');
  const rejected = check();
  assert.equal(rejected.status, 1);
  assert.ok(!rejected.stderr.includes(credential));
  git('rm', '--cached', 'settings.json');
  writeFileSync(path.join(cwd, '.env.example'), `TYPESAFE_API_KEY=${credential}\n`);
  git('add', '.env.example');
  assert.equal(check().status, 1);
});
