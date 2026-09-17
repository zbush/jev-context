import { execFileSync } from 'node:child_process';

// Inspect the index, not the working tree: this is what a commit would publish.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const files = git('ls-files', '-z').split('\0').filter(Boolean);
const violations = [];
const forbiddenPath = /(^|\/)(node_modules|\.local|\.jev-context|reports|logs|artifacts|coverage)(\/|$)|(^|\/)\.mcp\.json$|\.(csv|jsonl|ndjson|log|pem|key)$|(^|\/)(record\.(json|tmp)|summary\.json|baseline\.txt|filtered\.txt|actual\.txt)$/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];
for (const file of files) {
  const base = file.split('/').at(-1);
  if (forbiddenPath.test(file) || (base.startsWith('.env') && base !== '.env.example')) {
    violations.push(`${file}: excluded local/benchmark/credential file`);
    continue;
  }
  const text = git('show', `:${file}`);
  if (secretPatterns.some(pattern => pattern.test(text))) violations.push(`${file}: possible credential`);
  if (process.env.TYPESAFE_API_KEY?.length > 8 && text.includes(process.env.TYPESAFE_API_KEY)) {
    violations.push(`${file}: contains the configured TypeSafe credential`);
  }
  if (/C:[\\/]+Users[\\/]+ZBush/i.test(text)) violations.push(`${file}: machine-specific user path`);
  if (base === '.env.example' && /^TYPESAFE_API_KEY[\t ]*=[\t ]*[^\s]/m.test(text)) violations.push(`${file}: example API key must be blank`);
}
if (violations.length) {
  console.error('Publish check failed (matched contents are intentionally omitted):\n' + violations.join('\n'));
  process.exitCode = 1;
} else console.log(`Publish check passed for ${files.length} indexed files. No credential values were printed.`);
