import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const exec = promisify(execFile);
export const searchSchema = z.object({
  repository_root: z.string().min(1).max(4000).refine(value => path.isAbsolute(value),
    'repository_root must be an absolute path.').optional()
    .describe('Absolute current task workspace/repository path. Supply on every search; never infer from the MCP server working directory. Required unless a legacy default root is configured.'),
  question: z.string().min(1).max(8000),
  objective: z.string().max(4000).default(''),
  query: z.string().min(1).max(1000),
  path: z.string().max(1000).default('.'),
  globs: z.array(z.string().min(1).max(200)).max(12).default([]),
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  context_lines: z.number().int().min(0).max(30).default(8),
  max_candidates: z.number().int().min(1).max(100).default(40),
  mode: z.enum(['filtered', 'baseline', 'shadow']).default('filtered'),
}).strict();

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

// Keep local telemetry and common credential/build directories out of retrieval.
// These exclusions are not a general secret scanner.
const excluded = ['.git', 'node_modules', '.jev-context', '.env*', '*.pem', '*.key',
  'credentials*', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'dist', 'build'];

export function parseCandidates(stdout, maxChars = 12000, maxLines = 120) {
  const passages = [];
  let current = null;
  let omittedLongLines = 0;
  const flush = () => {
    if (current?.matches.length) {
      const text = current.lines.map(l => `${l.number}: ${l.text}`).join('\n');
      passages.push({ id: sha256(`${current.file}:${current.start}:${text}`).slice(0, 20),
        file: current.file, start_line: current.start, end_line: current.end,
        match_lines: current.matches, text, sha256: sha256(text) });
    }
    current = null;
  };
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type === 'end') { flush(); continue; }
    if (!['match', 'context'].includes(event.type)) continue;
    const d = event.data;
    if (d.path?.text === undefined || d.lines?.text === undefined) { flush(); continue; }
    const file = d.path.text.replaceAll('\\', '/').replace(/^\.\//, '');
    const text = d.lines.text.replace(/\r?\n$/, '');
    if (text.length > maxChars) { flush(); omittedLongLines++; continue; }
    if (current && (current.file !== file || d.line_number > current.end + 1 ||
        current.lines.length >= maxLines || current.chars + text.length > maxChars)) flush();
    if (!current) current = { file, start: d.line_number, end: d.line_number - 1, lines: [], matches: [], chars: 0 };
    if (d.line_number <= current.end) continue;
    current.lines.push({ number: d.line_number, text });
    current.end = d.line_number;
    current.chars += text.length;
    if (event.type === 'match') current.matches.push(d.line_number);
  }
  flush();
  return { candidates: passages, omitted_long_lines: omittedLongLines };
}

export async function retrieve(root, args, { rg = process.env.JEV_CONTEXT_RG || 'rg', dataDir } = {}) {
  const realRoot = await realpath(root);
  const target = await realpath(path.resolve(realRoot, args.path));
  if (!isWithin(realRoot, target) || !(await stat(target)).isDirectory()) {
    throw new Error('Search path must be a directory inside the configured root.');
  }
  const relative = path.relative(realRoot, target).replaceAll('\\', '/') || '.';
  if (relative.split('/').some(p => ['.git', 'node_modules', '.jev-context'].includes(p))) {
    throw new Error('Search path is excluded.');
  }
  const argv = ['--no-config', '--json', '--sort', 'path', '--color', 'never',
    '--max-filesize', '1M', '--context', String(args.context_lines)];
  if (!args.regex) argv.push('--fixed-strings');
  if (!args.case_sensitive) argv.push('--ignore-case');
  for (const glob of args.globs) argv.push('--glob', glob);
  for (const glob of excluded) argv.push('--glob', `!${glob}`);
  argv.push('--', args.query, relative);
  let stdout;
  let admittedFiles;
  const started = performance.now();
  // Positive --glob options and explicitly named ignored directories can override
  // rg ignore rules. Build an independent root-wide file set without user globs,
  // then admit only those paths before any candidate reaches Jev or telemetry.
  try {
    const listingArgs = ['--no-config', '--files', '--null'];
    for (const glob of excluded) listingArgs.push('--glob', `!${glob}`);
    listingArgs.push('--', '.');
    let listing;
    try {
      ({ stdout: listing } = await exec(rg, listingArgs, { cwd: realRoot, encoding: 'utf8', windowsHide: true,
        timeout: 15000, maxBuffer: 16 * 1024 * 1024 }));
    } catch (error) {
      if (error.code === 1) listing = error.stdout || '';
      else throw error;
    }
    const telemetryRoot = dataDir ? await realpath(dataDir) : null;
    admittedFiles = new Set(listing.split('\0').filter(Boolean)
      .map(file => file.replaceAll('\\', '/').replace(/^\.\//, ''))
      .filter(file => !telemetryRoot || !isWithin(telemetryRoot, path.resolve(realRoot, file))));
  } catch {
    throw new Error('Could not verify ignored-file exclusions within the 15s/16MiB limit; narrow the repository or check configuration.');
  }
  try {
    ({ stdout } = await exec(rg, argv, { cwd: realRoot, encoding: 'utf8', windowsHide: true,
      timeout: 15000, maxBuffer: 16 * 1024 * 1024 }));
  } catch (error) {
    if (error.code === 1) stdout = error.stdout;
    else throw new Error('ripgrep failed or exceeded its 15s/16MiB limit; narrow the query or check rg installation.');
  }
  const parsed = parseCandidates(stdout);
  const admitted = parsed.candidates.filter(candidate => admittedFiles.has(candidate.file));
  const candidates = admitted.slice(0, args.max_candidates);
  return { candidates, snapshot_sha256: sha256(JSON.stringify(candidates)),
    retrieval_ms: Math.round(performance.now() - started),
    rg_stdout_bytes: Buffer.byteLength(stdout),
    candidates_found: admitted.length, candidates_admitted: candidates.length,
    omitted_candidate_cap: Math.max(0, admitted.length - candidates.length),
    omitted_ignored_passages: parsed.candidates.length - admitted.length,
    omitted_long_lines: parsed.omitted_long_lines,
    limits: { context_lines: args.context_lines, max_candidates: args.max_candidates,
      max_file_bytes: 1048576, max_passage_chars: 12000, max_passage_lines: 120,
      respects_ignore_files: true, follows_symlinks: false } };
}
