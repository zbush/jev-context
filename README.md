# Jev Context

A local Codex plugin that runs ripgrep, classifies candidate code passages with Jev, and returns only `Yes` passages. It records paired filtered/unfiltered payloads so retrieval savings can be reproduced exactly under a named tokenizer.

This repository contains the plugin only. The initial smoke tests used a separate Brotato project; its source, credentials, and benchmark outputs are not included.

## Run locally

Requires Node.js 22+, ripgrep on PATH (or `JEV_CONTEXT_RG`), and a TypeSafe API key for filtered/shadow mode. Install dependencies inside this directory using `pnpm install --frozen-lockfile` (or `npm install`). The pinned dependency set is in `pnpm-lock.yaml`. On Windows sandboxes, `pnpm install --package-import-method=copy` avoids inaccessible hard links.

Commands below run **from this plugin directory**. Copy `.env.example` to `.env` and set your own TypeSafe key. Set `repoPath` to the repository you want to search, and adapt `examples/search.json` to its files and your question. No key value is written to plugin configuration or logs.

```powershell
node --test test/*.test.mjs
Copy-Item .env.example .env
# Edit .env locally before making live requests.
$repoPath = 'C:\path\to\your\repository'
node --env-file=.env src/cli.mjs search --root "$repoPath" --input examples/search.json
node --env-file=.env src/cli.mjs benchmark --root "$repoPath" --input examples/benchmark.json --data .jev-context/live-smoke
node src/cli.mjs report --data .jev-context/live-smoke --out reports/live-smoke --labels examples/labels.json --verify
```

The supplied benchmark definitions refer to the original, separate Brotato repository. Adapt the questions, queries, paths, and labels to your target before using them. They make **at most 36 Jev API calls**: three cases capped at 12 candidates each. The benchmark prints metrics, not raw source passages. Each rerun incurs new API usage; there is no classification cache or automatic retry in this MVP. Use a fresh `--data` directory for each independent benchmark suite, or expect subsequent reports to include every run in the directory. Three examples are a smoke test, not a representative efficacy study.

`search` prints the actual response text to stdout and a small metrics receipt to stderr. The MCP server reserves stdout for MCP transport. `report` writes `summary.json` and `runs.csv`; it never needs an API key. `--verify` re-tokenizes saved payloads, checks their hashes and candidate snapshot hashes, checks selection against stored judgments, and exits nonzero on an audit mismatch. This is a reproducibility check, not a signed attestation.

## Connect to Codex

The plugin contains `.codex-plugin/plugin.json` and a workflow skill. Generate the ignored, machine-specific `.mcp.json` launcher before installing:

```powershell
node scripts/configure.mjs --root "$repoPath" --env-file .env
```

Use `--rg` with an absolute ripgrep executable path when the app does not inherit your shell PATH. Use `--data` to select a telemetry directory. The generated `.mcp.json` uses absolute paths to the source checkout and Node executable. This deliberately supports local development: moving the checkout requires reconfiguration and plugin reinstall. To distribute the source, recipients install dependencies and regenerate their own launcher; don't share the machine-specific `.mcp.json` unchanged.

Register/install the package through the Codex personal marketplace, or add its generated command/args/environment as a local STDIO MCP server in Codex settings. Start a new Codex task after installation and ask: **“Use Jev code search to find where TypeSafe timeouts are enforced.”** Installing a plugin doesn't add tools to an already running task. This plugin does not intercept native grep, file reads, or web search; the skill routes the requested workflow through its tool.

## Tool contract

`search_code` requires `question` and `query`. Optional fields:

- `objective`: current information need, alongside the user's full question.
- `path`: repository-relative directory, default `.`; escapes outside the configured root are rejected.
- `globs`: up to 12 ripgrep include/exclude globs.
- `regex`: false by default, so a query is treated literally; shell execution is never used.
- `case_sensitive`: false by default.
- `context_lines`: 0–30, default 8.
- `max_candidates`: 1–100, default 40.
- `mode`: `filtered` (default), `baseline`, or `shadow`.

`filtered` returns only Yes. `baseline` returns all admitted candidates and makes **no Jev calls**. `shadow` classifies but returns the baseline; its paired reduction is hypothetical and its actual payload saving is zero. The baseline shares candidate chunking, query, exclusions, caps, and formatting with filtered mode; it is **not** arbitrary native grep output.

Passages retain source paths, line numbers, source text, and stable content IDs. Nearby matches merge; chunks are bounded to 120 lines/12,000 characters. Search respects ignore files, does not follow symlinks, excludes files over 1 MiB, and has a 15-second/16-MiB stdout bound. Candidate-cap and oversized-line omissions are explicit. A ripgrep error or overflow returns an error rather than a silently partial success. These search limits are not Jev savings.

Jev is asked one independent Choice question per passage, with Yes/No/Unknown rubrics. Optional `JEV_CONTEXT_MIN_YES_PROBABILITY` (0–1, default 0) demotes a low-probability Yes to Unknown while preserving the original judgment. Do not treat the default as an evaluated universal threshold. `TYPESAFE_MODEL` defaults to `jev-latest`; pin a version for longitudinal experiments. `JEV_CONTEXT_CONCURRENCY` is 1–8, default 4. Each API call times out after 15 seconds.

Any failed classification makes the entire search an error with **no source text returned**. Successful API usage within that failed run is retained; unavailable usage is flagged, never assumed free. Error responses are counted, and failed runs are excluded from successful paired-savings totals. An all-No/Unknown result explicitly says that no passages passed filtering; it does not assert an absence of evidence. Recovery of withheld items remains post-MVP.

## What the token metrics mean

For each call, let `B` be the token count of `baseline.txt`, `F` of `filtered.txt`, and `A` of `actual.txt`:

- `paired_tokens_saved = B - F`.
- `paired_reduction_pct = 100 × (B - F) / B`.
- `actual_vs_baseline_tokens_saved = B - A`; zero for shadow/baseline modes.
- Suite reduction is `100 × (sum(B) - sum(F)) / sum(B)`, **not** an average of percentages.

Counts include the entire saved response text: JSON structure, paths, IDs, counts, notices, and selected code. They use pinned `tiktoken` 1.0.22 with explicit `o200k_base` by default (`JEV_CONTEXT_ENCODING=cl100k_base` is also supported). They are exact for those saved strings under that encoding. **The tokenizer used internally by the current Codex model is not verified. These are not exact host-context or billed token counts.** Tool transport framing, injected tool definitions/skill instructions, the model's tool-call generation, and subsequent turns are outside this payload metric. Tool arguments are counted separately as `tool_arguments_tokens`.

Records also include UTF-8 byte counts, payload/candidate SHA-256 hashes, exact requests without credentials, all judgments/probabilities, model versions returned by TypeSafe, API input/output usage, per-candidate latency, retrieval time, Jev wall time, and total processing time. Total processing time includes payload writes but excludes writing the final record and MCP transport. Reports group different modes, sources, tokenizer versions, prompts, requested models, and thresholds separately. Negative savings are preserved.

**Jev token usage is separate from Codex payload tokens.** Sending more tokens through a cheaper classifier can still be useful, but token counts across different models are not interchangeable dollars. No pricing or dollar-saving claim is built in. Missing usage may include chargeable failed calls.

## Measure eventual whole-task savings

Retrieval reduction is a mechanism metric. To establish the plugin's value for complete tasks:

1. Freeze a repository revision and define representative tasks and success checks before testing.
2. Run baseline and filtered arms in separate fresh tasks with the same Codex model, instructions, and starting repository. Alternate/randomize arm order and repeat tasks. Never load baseline and filtered source into the same answering context.
3. For an isolated filter comparison, use this wrapper in both arms and change only its mode. For the final product comparison, use ordinary retrieval without the plugin in the control arm so plugin/tool/skill overhead is included in the result.
4. Record complete-task host/API usage, including **all follow-up searches and reads**, cached input tokens, output tokens, errors, elapsed time, Jev usage, and whether the answer passed the same quality checks.
5. Import the complete-task counts with `report --task-usage path/to/task-usage.json`. This reports input, uncached-input, output, and total Codex-token deltas, preserving regressions and separating quality-passing pairs. It does not read unstable Codex transcript formats or claim to independently verify imported evidence.

The usage file is an array of `{name, baseline, filtered}`. Each arm contains `task_id`, `model`, `evidence` (path or link to the usage export), `input_tokens`, `cached_input_tokens`, `output_tokens`, and `quality_passed`. Cached tokens must be a subset of input tokens; use distinct task IDs and matching model names. Input/output totals must cover the complete task, not just the last model response. This import needs real measurements; none are fabricated in the example benchmark.

## Evidence quality

`--labels` accepts a mapping from benchmark case name to manually reviewed `{file, line, relevant: true}` anchors. The report separates retrieval recall (did the search find it?), conditional filter recall (did Jev keep what search found?), and end-to-end anchor recall. `examples/labels.json` contains five positive anchors for the current Brotato source. Update line anchors when the source changes. These sparse labels do not prove overall recall, precision, or answer correctness; add representative labels and complete-task checks before making broad claims.

## Data handling

Filtered/shadow searches send the question, objective, search query, and code passages to `https://api.typesafe.ai/v1/systemone`. Baseline is local only. The tool does not upload an entire repository. `.env*`, common key files, ignored files, dependency directories, and `.jev-context` are excluded, but this is not a secret scanner: secrets embedded in ordinary source can still be transmitted.

Telemetry is local under `<repository>/.jev-context/<run-id>/` by default. Each directory contains `record.json`, `baseline.txt`, `filtered.txt`, and `actual.txt`. **These files contain original code and user questions, including withheld passages.** Keep this directory private and out of version control; add any custom data directory to ignore rules. Logs persist until deleted. Raw snapshots are retained so post-MVP expansion and reproducible audits are possible. API key values are never logged.

The server runs with the host's filesystem permissions. The root and API configuration are environment-controlled rather than supplied by tool callers. This is a retrieval tool, not a security boundary against a malicious repository or other tools reading files directly.

## Development and publication

Run `node --test test/*.test.mjs` before pushing. The suite runs offline without API keys or live Jev calls. Configure the local commit guard once per clone with `git config core.hooksPath .githooks`; it checks indexed files for excluded outputs, common credential patterns, and local user paths. Run `node scripts/check-publish.mjs` manually to inspect the exact commit contents. When `TYPESAFE_API_KEY` is in the environment, the guard also checks for that exact value without printing it. This targeted guard is not a comprehensive secret scanner.

Credentials (`.env*`, except the blank `.env.example`), generated `.mcp.json`, raw telemetry, reports, CSV/JSONL outputs, and dependencies stay local. Only benchmark **definitions** and manually reviewed label definitions belong in source control. Never force-add generated run records or response payloads. Custom output locations must also be ignored.

## Sources

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Choice](https://docs.typesafe.ai/primitives/choice) and [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP server SDK](https://modelcontextprotocol.io/docs/develop/build-server)
- [tiktoken](https://github.com/openai/tiktoken)
