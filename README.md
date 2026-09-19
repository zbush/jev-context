# Jev Context

A local Codex plugin for when your LLM needs to search across a codebase to build context. It runs ripgrep, asks Jev a binary Yes/No relevance question for each candidate passage, and returns passages with `P(Yes) > min_yes_probability` (default `0.50`). Codex can recover lower-scoring passages with `expand_results`, or read surrounding source and containing functions with `expand_context`, without additional Jev calls. It records paired filtered/unfiltered payloads and expansion costs so retrieval savings can be reproduced exactly under a named tokenizer.

Install once for use across local projects. Codex supplies the current workspace on each search, so switching repositories needs no plugin reconfiguration. Global preferences control whether Jev is used automatically or only on request, and whether answers include token-savings receipts. Defaults are **ask only** and **receipts on**.

This repository contains the plugin only. The initial smoke tests used a separate Brotato project; its source, credentials, and benchmark outputs are not included.

## Experimental MVP

Jev Context is an experimental retrieval tool, not a security scanner or a guarantee of complete answers. Relevance judgments can be wrong. Passages at or below the threshold are withheld; `expand_results` can recover lower-scoring passages from successful binary filtered searches. Evaluate answer quality alongside token savings before relying on filtering for important work.

Filtered and shadow searches send candidate code and your question to the TypeSafe API and can incur charges. Use them only with code you are authorized to send to that service. Ignore rules and filename exclusions do not detect secrets embedded in ordinary source. Local telemetry retains original passages, including withheld code; keep it private. See [Data handling](#data-handling).

Reported savings count retrieval response text under a named tokenizer. They are not verified Codex context usage, total task savings, or billing reductions. Skill-driven automatic searches and answer receipts depend on Codex following the instructions; the plugin does not intercept native tools. See [What the token metrics mean](#what-the-token-metrics-mean).

Licensed under the [MIT License](LICENSE), provided without warranty. Third-party dependencies and the TypeSafe service have their own licenses and terms.

## Install and try it

These instructions use **Windows PowerShell** and local Codex tasks. The plugin requires Node.js 22+, ripgrep, and a TypeSafe API key for filtered searches. macOS/Linux users need equivalent shell commands; the walkthrough below has not been validated on those systems.

### 1. Check prerequisites

- Install [Node.js](https://nodejs.org/en/download), version 22 or newer; it includes npm.
- Install [ripgrep](https://github.com/BurntSushi/ripgrep#installation). Its executable is named `rg`.
- Have Codex installed with support for local plugins and the built-in Plugin Creator skill. See [Codex plugin setup](https://learn.chatgpt.com/docs/build-plugins).
- Obtain your own API key through [TypeSafe](https://docs.typesafe.ai/). This is separate from your OpenAI account; Jev API calls can incur charges.

Open a new PowerShell window after installing tools and check:

```powershell
node --version
npm.cmd --version
rg --version
```

Each command should print a version. Resolve missing commands before continuing. `npm.cmd` avoids PowerShell execution-policy errors affecting `npm.ps1`.

### 2. Download the plugin and install dependencies

On [this repository's GitHub page](https://github.com/zbush/jev-context), choose **Code → Download ZIP**, extract it to a permanent folder, and open PowerShell in that folder. Alternatively, with Git installed:

```powershell
git clone https://github.com/zbush/jev-context.git
Set-Location jev-context
```

All remaining terminal commands run **from the plugin directory**, where `package.json` and this README are located:

```powershell
npm.cmd install
```

If you already use pnpm, prefer `pnpm install --frozen-lockfile` for the pinned dependency set in `pnpm-lock.yaml`. In Windows sandboxes, add `--package-import-method=copy` if hard links are inaccessible. npm is the simpler setup route but does not use the pnpm lockfile.

### 3. Add your key and generate the launcher

On first setup only, create the local environment file:

```powershell
Copy-Item .env.example .env
notepad .env
```

In Notepad, fill in the empty `TYPESAFE_API_KEY=` value with your key, save, and close. Leave the other defaults unchanged for now. Do not paste your key into a Codex conversation. `.env` is ignored by Git; do not overwrite an existing `.env` when updating the plugin.

Generate the launcher, capturing the installed ripgrep path so Codex does not need to inherit your terminal's PATH:

```powershell
$rgPath = (Get-Command rg -CommandType Application).Source
node scripts/configure.mjs --env-file .env --rg "$rgPath"
```

This creates ignored `.mcp.json` with absolute paths to Node, the source checkout, and your environment file. No key value is copied into the launcher. Keep the checkout and its dependencies in place after installation; moving them requires regenerating the launcher and refreshing the installed plugin.

### 4. Check the connection without API charges

```powershell
$repoPath = (Get-Location).Path
node scripts/check-connection.mjs --root "$repoPath"
```

Expect JSON containing `"status": "ok"`, `"tool": "search_code"`, and `"jev_calls": 0`. This checks the launcher, MCP handshake, tool discovery, and a baseline search with no matches. It writes a local run record but does not test your API key, live classification, or installation inside Codex. Pass `--config` to check another launcher, such as an installed copy.

### 5. Register and install in Codex

Open this plugin folder as a local Codex project. In a task, invoke the built-in **Plugin Creator** skill with this prompt:

```text
$plugin-creator Register the existing jev-context plugin in this workspace
in my personal marketplace and install it. Preserve its implementation,
manifest, generated .mcp.json, and bundled skill. The launcher has already
passed scripts/check-connection.mjs. If registration needs a source mirror,
keep the generated launcher and skill consistent with this source checkout.
Tell me the marketplace name and confirm installation succeeded.
```

This uses the [documented Plugin Creator workflow](https://learn.chatgpt.com/docs/build-plugins) to register an existing local package. Allow any requested local marketplace write needed for registration. If registration succeeds but installation is left to you, refresh Codex, open **Plugins → Personal**, select **Jev Context**, and install it. With the Codex CLI available, the equivalent is `codex plugin add jev-context@personal` when the reported marketplace name is `personal`; substitute the reported name otherwise.

Start a **new Codex task** in this repository and ask:

> Use Jev code search to find where TypeSafe request timeouts are enforced. Search src for AbortSignal with at most 3 candidates, then explain the behavior and cite the source lines.

This first live search can make up to three Jev calls. You should see a `search_code` tool call and an explanation pointing to `src/jev.mjs`; with default settings, the answer should include a retrieval-token receipt. Whether passages pass filtering is a model judgment, so exact wording and savings vary.

Now open another local project and explicitly ask Codex to use Jev there. Codex supplies that task's repository path; switching projects needs no reconfiguration. Installing the plugin does not add tools to already running tasks or install it on other computers/cloud environments. Registering only the MCP server does not install the companion workflow skill.

### Troubleshooting

- **`rg` is missing or the connection check fails to launch:** verify `rg --version`, rerun configuration with the absolute `--rg` path, and retry the check.
- **Missing modules:** run dependency installation in the plugin directory. Keep that directory after installing into Codex.
- **The free check passes but live search fails:** check the key in `.env` and TypeSafe account access. The free check intentionally does not authenticate to TypeSafe. Restart the MCP server after editing `.env`.
- **Jev is unavailable or ignored:** confirm the plugin is installed, start a new task, and explicitly say “Use Jev code search.” Ask-only is the default; it does not intercept native search tools.
- **Changed settings seem inactive:** follow [Preferences](#preferences), including refreshing the installed skill and restarting the server. Restart Codex if a new task still uses the old server.
- **No passages returned:** distinguish no search matches from no candidates passing the relevance filter. Try other symbols, a clearer question, or more surrounding context; an empty filtered result does not prove the code is absent.

## Best usage: building context across a codebase

Jev is most useful when the answering LLM needs to discover which parts of an unfamiliar repository matter before explaining or changing code. Examples include tracing a feature through several modules, investigating a bug with many possible call sites, finding configuration consumers, and locating tests relevant to a planned change. When a search finds many unrelated matches, filtering can leave more room for useful evidence in the model's context.

Give Codex the actual task and ask it to use Jev **before loading broad search output**. For example:

> Use Jev code search to build context for how authentication works in this repository. Find the entry points, token validation, configuration, and relevant tests. Explain the flow with file and line references before suggesting changes.

> Use Jev code search to investigate why request timeouts are not reaching callers. Follow the request path, cancellation handling, and tests. Include evidence that contradicts the suspected cause.

For better results:

- **Provide a concrete question.** “Find where retry limits are read and enforced” gives the classifier a clearer goal than “find interesting code.”
- **Search broadly, then trace.** For exploratory questions, use a bounded directory and broader terms or regex alternatives with a specific relevance objective. Jev can filter the extra candidates before Codex reads them. Then follow discovered symbols, dependencies, and tests. Ripgrep retrieves literal/regex matches; Jev is not a semantic index that discovers code with no matching query terms.
- **Narrow after discovery.** Use relevant directories and file globs, and keep candidate caps modest. One admitted passage means one API call; repeated searches incur new usage because there is no classification cache.
- **Recover the right kind of missing evidence.** Use `expand_results` to lower the threshold on saved candidates, and `expand_context` to read a missing branch or nearby definition around a returned passage. Both avoid additional Jev calls but add response tokens. Candidate-cap omissions, unmatched symbols, and dependencies in other files require further searches or direct reads.
- **Judge answer quality as well as savings.** Ask for source references, follow relevant dependencies, and run appropriate tests before accepting changes. Filtering can omit important evidence.

For a known file or exact line, reading it directly is usually simpler. Searches where nearly every result is relevant may save little or add payload overhead, while still adding Jev latency and API usage. Use ask-only while evaluating the tradeoff; opt into [auto mode](#preferences) if you want Codex instructed to use Jev for routine code searches. Reported retrieval savings do not establish whole-task speed or cost savings.

## Advanced: CLI searches and benchmarks

These are optional developer tools, not installation steps. From the plugin directory, the included search example can run against this repository:

```powershell
$repoPath = (Get-Location).Path
node --env-file=.env src/cli.mjs search --root "$repoPath" --input examples/search.json
```

This search allows up to 12 Jev calls. For another repository, change `$repoPath` and adapt the question, query, and paths in `examples/search.json`.

The supplied **benchmark and label definitions refer to the separate Brotato repository**, which is not included. Adapt their questions, queries, paths, and line anchors to your target before running:

```powershell
$repoPath = 'C:\path\to\your\repository'
node --env-file=.env src/cli.mjs benchmark --root "$repoPath" --input examples/benchmark.json --data .jev-context/live-smoke
node src/cli.mjs report --data .jev-context/live-smoke --out reports/live-smoke --labels examples/labels.json --verify
```

The supplied three cases are capped at 12 candidates each: at most 36 Jev calls before you modify them. Each rerun incurs new API usage; there is no classification cache or automatic retry. Use a fresh `--data` directory per independent suite, or reports will include every retained run in that directory. The 200 MB storage limit also applies to benchmark directories; archive completed runs outside the active telemetry directory if you need lasting reproducibility. Three examples are a smoke test, not a representative efficacy study.

`search` prints response text to stdout and a metrics receipt to stderr. The MCP server reserves stdout for transport. `benchmark` prints metrics, not raw source passages. `report` writes `summary.json` and `runs.csv` without an API key. `--verify` re-tokenizes saved payloads, checks payload/candidate hashes and selection against stored judgments, and exits nonzero on an audit mismatch. This is a reproducibility check, not a signed attestation.

## Preferences

Two independent settings default to **receipts on** and **ask only**. Run these commands from the plugin source directory:

```powershell
# Show current settings
node scripts/settings.mjs
# Change either option or both
node scripts/settings.mjs --receipts off --run-mode auto
node scripts/settings.mjs --receipts on --run-mode ask-only
```

- **Receipts on/off:** controls the answer footer and whether tool responses include `token_savings`. Turning receipts off keeps local telemetry and reproducible token counts, with no receipt payload overhead.
- **Auto run:** the skill tells Codex to use Jev whenever searching code inside the current task workspace, unless the user opts out. This is model guidance, not interception or enforcement of native tools.
- **Ask only:** the skill tells Codex to use Jev only when explicitly requested. It does not prompt for permission on every ordinary search. An explicit request can cover an ongoing task.

Settings are saved in ignored `jev-context.settings.json`. The command also regenerates `skills/jev-code-search/SKILL.md` from `SKILL.template.md` so skill discovery matches the mode. Edit the template when changing shared instructions. Omitting an option preserves its current value; invalid settings fail rather than silently changing behavior.

After changing settings, refresh the installed plugin from its marketplace source and start a new Codex task. If your marketplace uses a separate source mirror, sync the generated skill and local settings there before reinstalling. The MCP launcher continues to read settings beside its source checkout. `JEV_CONTEXT_SETTINGS_FILE` can override that runtime path; keep it consistent with the generated skill. These are local command-line preferences, not toggles in Codex's plugin UI.

## Configuration reference

Edit `.env` in the original plugin checkout for API and search configuration:

- `TYPESAFE_API_KEY`: your TypeSafe key; required when filtered/shadow searches have candidates to classify. Baseline searches need no key.
- `TYPESAFE_MODEL`: defaults to `jev-latest`. Use a specific available model version for repeatable comparisons.
- `JEV_CONTEXT_ENCODING`: defaults to `o200k_base`; also supports `cl100k_base`. This changes measurement, not the Codex model.
- `JEV_CONTEXT_CONCURRENCY`: concurrent classification calls per search, integer 1–8; default 4. This is not a session-wide spending limit.
- `JEV_CONTEXT_MIN_YES_PROBABILITY`: number from 0–1; default `0.50`. Keep a passage when `P(Yes)` is strictly greater, regardless of the winning verdict. A search's `min_yes_probability` overrides this default. Higher values can discard useful evidence; no universal threshold has been established. **Migration:** older `.env` files may explicitly set `0`; remove that setting or change it to `0.5` to adopt the new default. Explicit zero remains supported and admits any positive Yes probability.
- `JEV_CONTEXT_RG`: ripgrep executable path; defaults to `rg` on PATH. Prefer launcher `--rg` as in the quickstart.
- `JEV_CONTEXT_DATA_DIR`: telemetry directory; defaults to `.jev-context` under your user home directory. Use an absolute path for predictable placement.
- `JEV_CONTEXT_SETTINGS_FILE`: optional absolute path to an alternative preferences JSON file. Default: `jev-context.settings.json` beside the plugin source. Advanced use only: `scripts/settings.mjs` still writes beside the checkout, so a custom file and the generated skill must be kept consistent.
- `JEV_CONTEXT_ROOT`: optional legacy repository fallback. Leave it unset for normal use; Codex supplies `repository_root` on each call. The generated launcher sets this value through `--root` instead.

The server reads configuration **at startup**, not on each search. After editing `.env` or preferences, restart the plugin's MCP server (restart Codex if needed), then start a new task. Changes to ordinary `.env` values do not require regenerating `.mcp.json` when the file stays at the same path. Preference changes also require refreshing the installed skill as described above.

`node scripts/configure.mjs` accepts `--env-file`, `--rg`, `--data`, and `--root`. It overwrites `.mcp.json`, so repeat every launcher option you want to retain. For example:

```powershell
$rgPath = (Get-Command rg -CommandType Application).Source
node scripts/configure.mjs --env-file .env --rg "$rgPath" --data "$env:USERPROFILE\.jev-context"
```

Explicit launcher environment values (such as `--rg` and `--data`) take precedence over the corresponding `.env` values. After changing launcher paths, refresh/reinstall the plugin from its local marketplace and restart the server. A per-call `repository_root` always takes precedence over legacy `--root`; the fallback is not a filesystem restriction. Multiple projects can share the server without binding it to one checkout. Each recipient must generate their own launcher; do not distribute a machine-specific `.mcp.json`.

## Tool contract

`search_code` requires `question` and `query`. In the default global setup, also supply `repository_root` on every call:

- `repository_root`: absolute current workspace/repository directory; required unless a legacy root fallback exists. Codex supplies this from task context. Paths with spaces are passed as structured arguments.

The root must exist and be a directory. The server resolves its canonical path for retrieval and telemetry. For tasks with multiple workspaces, issue separate searches with the appropriate root for each. It does not guess the project from the server's working directory.

Optional fields:

- `objective`: current information need, alongside the user's full question.
- `path`: repository-relative directory, default `.`; escapes outside the selected repository root are rejected.
- `globs`: up to 12 ripgrep include/exclude globs.
- `regex`: false by default, so a query is treated literally; shell execution is never used.
- `case_sensitive`: false by default.
- `context_lines`: 0–30, default 8.
- `max_candidates`: 1–1,000, default 100; set per search to change the passage limit.
- `mode`: `filtered` (default), `baseline`, or `shadow`.
- `min_yes_probability`: 0–1; overrides the environment default for this search. Comparison is strict: `0.50` excludes an exact 50/50 result; `0.33` admits a 0.40 Yes probability even when No wins. Zero still excludes an exact zero; one admits nothing.

`filtered` returns passages above the threshold. `baseline` returns all admitted candidates and makes **no Jev calls**. `shadow` classifies but returns the baseline; its paired reduction is hypothetical and its actual payload saving is zero. The baseline shares candidate chunking, query, exclusions, caps, and formatting with filtered mode; it is **not** arbitrary native grep output. Scored responses include each returned passage's `yes_probability`, the effective threshold, and counts of withheld passages in score bands `[0, 0.33]`, `(0.33, 0.50]`, `(0.50, 0.75]`, and `(0.75, 1]`. Band counts contain only passages still withheld at the effective threshold.

Passages retain source paths, line numbers, source text, and stable content IDs. Nearby matches merge; chunks are bounded to 120 lines/12,000 characters. Search respects ignore files, does not follow symlinks, excludes files over 1 MiB, and bounds each ripgrep phase to 15 seconds/16 MiB. An independent file listing from the repository root enforces ignore rules even when include globs or an explicit subdirectory would override them. The configured telemetry directory is also excluded before classification. This extra listing adds latency, and repositories exceeding its limits fail closed. Candidate-cap and oversized-line omissions are explicit. A ripgrep error or overflow returns an error rather than a silently partial success. These search limits are not Jev savings.

Jev is asked one independent Choice question per passage, with Yes/No rubrics (`relevance-binary-v2`). Raw judgments are preserved independently of the selection threshold. The threshold is not sent to Jev. Binary probabilities are not interchangeable with the older three-way Yes/No/Unknown scores, and the thresholds are not evaluated guarantees of accuracy. `TYPESAFE_MODEL` defaults to `jev-latest`; pin a version for longitudinal experiments. `JEV_CONTEXT_CONCURRENCY` is 1–8, default 4. Each API call times out after 15 seconds.

The passage limit is a ceiling, not a target: only admitted matches are classified. A limit of 1,000 can make up to 1,000 paid Jev calls in filtered/shadow mode. Concurrency stays at four by default. Slow large searches can exceed the generated launcher's 600-second tool timeout, and many retained passages can produce a response too large for the host's context. The existing ripgrep size/time bounds still apply. Prefer narrower queries or smaller limits when practical; increasing the passage cap does not guarantee complete repository coverage.

Any failed classification makes the entire search an error with **no source text returned**. Successful API usage within that failed run is retained; unavailable usage is flagged, never assumed free. Error responses are counted, and failed runs are excluded from successful paired-savings totals. An empty filtered result explicitly says that no passages passed filtering; it does not assert an absence of evidence.

### Expand a saved retrieval

Call `expand_results` when the existing candidates may contain useful lower-scoring evidence. Supply:

```json
{
  "retrieval_id": "<original search retrieval_id>",
  "repository_root": "<absolute current repository path>",
  "previous_threshold": 0.50,
  "min_yes_probability": 0.33
}
```

This returns only passages with `0.33 < P(Yes) <= 0.50`, including the exact 0.50 boundary withheld by the original search. For a subsequent expansion to 0.20, use the same original ID, `previous_threshold: 0.33`, and `min_yes_probability: 0.20`. The previous threshold must be the lowest one already consumed and cannot exceed the original search threshold. The new threshold must be strictly lower. The plugin is stateless about conversation consumption: repeated or overlapping intervals return duplicate content and incur additional payload tokens.

Each expansion gets its own `retrieval_id` for accounting, with `source_retrieval_id` pointing to the original search. Expansion reads local saved candidates and scores; it does not rerun ripgrep, fetch current source, or call Jev. The response includes the snapshot timestamp. Verify current files before editing. Keep the original record available for later expansions and audits. Repository identity is checked, but the server still runs with the host's filesystem permissions.

Legacy ternary, baseline, shadow, failed, and expansion records cannot be expanded; run a fresh binary filtered search. An absent or corrupt record is an error, not evidence of no matches. If the search omitted candidates due to its cap or used the wrong vocabulary, change the search instead of merely lowering its threshold. For missing code around an existing passage, use `expand_context`. The same score-expansion operation is available through `node src/cli.mjs expand --input expansion.json` with a JSON object like the one above. Use the same telemetry directory as the original search (`--data` if customized); no API key is required.

### Expand source context

`expand_context` fills gaps outside a returned passage, without a Jev call or relevance filter. Supply the original binary filtered search's `retrieval_id`, a returned `candidate_id`, and the absolute `repository_root`. An optional `anchor_line` selects a line within that saved passage (default: its first matching line).

For example, save the following as `context.json`, replacing the placeholders with values from a successful search:

```json
{
  "retrieval_id": "<original search retrieval_id>",
  "candidate_id": "<returned passage id>",
  "repository_root": "<absolute current repository path>",
  "mode": "function",
  "max_lines": 120,
  "max_chars": 12000
}
```

A passage returned by `expand_results` can also be used: take its `id` as `candidate_id` and the response's `source_retrieval_id` as the original search ID. Do not use an expansion response's own `retrieval_id` or an expanded context result's ID as the seed.

- `mode: function` (default) locates the containing GDScript/Python function using conservative indentation and string/comment handling. Other languages and anchors outside a recognized function use an explicitly labeled surrounding-line fallback. This is a lexical helper, not a full parser.
- `mode: surrounding` uses `before_lines` and `after_lines` around the anchor, each defaulting to 40 (0–150 allowed).
- `max_lines` defaults to 120 (1–300 allowed); `max_chars` defaults to 12,000 (100–24,000 allowed). Oversized ranges are trimmed around the anchor. Inspect `selection`, `requested_range`, and `truncated`; an oversized anchor line errors rather than returning partial source.

The tool reads the **current local file**, checks that the original passage still matches at its original line numbers, and rechecks ignore rules, exclusions, symlinks, repository boundaries, and the 1 MiB file limit. If the original passage moved or changed, run a fresh search. Nearby code may have changed even if the anchor passage is unchanged; the response includes the read time and file/content hashes and does not attach a relevance probability.

Context expansion does not automatically follow dependencies or rescore code. Use it for a missing branch or nearby definition; use a focused search for a dependency in another file. Repeated/overlapping context counts in full. Receipts use the same zero incremental baseline as score expansion, and `report --verify` checks persisted context without requiring current source to remain unchanged. Context records use `operation: expand_context` and save `record.json` plus `actual.txt`. CLI equivalent: `node src/cli.mjs expand-context --input context.json`. Use the original search's telemetry directory (`--data` if customized); no API key is required.

## What the token metrics mean

For each call, let `B` be the token count of `baseline.txt`, `F` of `filtered.txt`, and `A` of `actual.txt`:

- `paired_tokens_saved = B - F`.
- `paired_reduction_pct = 100 × (B - F) / B`.
- `actual_vs_baseline_tokens_saved = B - A`; zero for shadow/baseline modes.
- Suite reduction is `100 × (sum(B) - sum(F)) / sum(B)`, **not** an average of percentages.

Counts include the entire saved response text: JSON structure, paths, IDs, counts, notices, and selected code. They use pinned `tiktoken` 1.0.22 with explicit `o200k_base` by default (`JEV_CONTEXT_ENCODING=cl100k_base` is also supported). They are exact for those saved strings under that encoding. **The tokenizer used internally by the current Codex model is not verified. These are not exact host-context or billed token counts.** Tool transport framing, injected tool definitions/skill instructions, the model's tool-call generation, and subsequent turns are outside this payload metric. Tool arguments are counted separately as `tool_arguments_tokens`.

Expansion receipts have a **zero incremental baseline** and negative savings equal to the complete expansion response token count. Subtract that added context from the original search's savings; do not count the original unfiltered baseline again. Every actual expansion response counts, even a repeated or empty interval. Reports separate `search`, `expand`, and `expand_context` groups; sum their signed savings only within the same encoding. Expansion groups have no percentage reduction on their own. `report --verify` checks expansion payloads and selections against their saved parent search; an unavailable parent prevents verification. Failed expansions remain errors with unavailable savings and recorded response tokens.

With receipts enabled, completed search responses include a top-level `token_savings` receipt. The tool description and skill instruct Codex to append its `footer` to the final answer, for example: “Jev Context: saved 611 retrieval tokens (37.5%; o200k_base).” This example is illustrative, not a measurement for your current task. Multiple calls are combined by unique retrieval ID and encoding with a weighted percentage. Negative savings are reported as added tokens, and baseline/shadow responses report zero actual savings. Recorded search errors report savings as unavailable; protocol validation failures may have no receipt. Final-answer presentation is guided by the skill; the MCP server cannot force the host model to render a footer.

When enabled, both comparison payloads include their receipts. Counts are recalculated until the embedded receipt numbers match the complete saved strings; if self-referential counts cycle, a nonnumeric "unavailable" receipt is returned while exact telemetry remains available locally. Receipt overhead is also recorded separately. `report --verify` checks embedded numbers, and reports group receipt-bearing payloads separately from older payload formats. The model's final-answer footer itself is outside these tool-response counts.

Records also include UTF-8 byte counts, payload/candidate SHA-256 hashes, exact requests without credentials, all judgments/probabilities, model versions returned by TypeSafe, API input/output usage, per-candidate latency, retrieval time, Jev wall time, and total processing time. Total processing time includes payload writes but excludes writing the final record and MCP transport. Reports group different repositories, modes, sources, tokenizer versions, prompts, requested models, thresholds, run modes, and payload formats separately. Negative savings are preserved.

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

The standard label report evaluates individual searches and excludes expansion records. To measure recovery across searches and expansions, evaluate the union of returned source ranges against the task's anchors and include every expansion response in token costs. A targeted replay of known gaps tests recovery capability; it does not establish that Codex will autonomously identify those gaps or choose the same expansions.

## Data handling

Filtered/shadow searches send the question, objective, search query, and code passages to `https://api.typesafe.ai/v1/systemone`. Baseline and both expansion tools make no TypeSafe API calls. Score expansion reads saved passages; context expansion reads current local source. Both return code to Codex and persist their responses locally. The tool does not upload an entire repository. `.env*`, common key files, ignored files, dependency directories, and `.jev-context` are excluded, but this is not a secret scanner: secrets embedded in ordinary source can still be transmitted.

Telemetry is local under `~/.jev-context/<run-id>/` by default, outside project checkouts. `JEV_CONTEXT_DATA_DIR` or launcher `--data` overrides this. Existing logs are not moved. Successful runs record their canonical repository root; summaries group by repository and CSV exports include the root. Successful search directories contain `record.json`, `baseline.txt`, `filtered.txt`, and `actual.txt`. Expansions contain `record.json` and `actual.txt` and refer to the original search record. Failed runs may contain only the error record and actual response. **These files contain original code and user questions, including withheld passages.** Keep this directory private and out of version control; add any custom data directory to ignore rules. Raw snapshots support expansion and reproducible audits; no separate cache is required. API key values are never logged.

### Storage limit and automatic cleanup

Each telemetry directory has a fixed **200 MB (200,000,000 bytes)** limit for managed run files. Before and after searches and expansions, the plugin checks storage and, at or above the limit, removes the oldest search groups until usage falls below it. A group is the original search plus all its saved score/context expansions. Age is the original search's creation time; expanding an old search does not make it newer. There is no age expiration or retention setting in this MVP.

Filesystem leases protect operations in progress, including the parent of an active expansion, across plugin processes. In-flight writes can temporarily exceed the limit; cleanup runs again on completion. If a single completed group exceeds the cap, it can be removed immediately. The returned response remains available to the caller, but its retrieval ID will no longer support expansion or audit. Run a fresh search when a saved retrieval has been pruned. Reports cover only retained records.

Cleanup deletes only recognized flat run directories, never follows symlinks, and leaves unrelated files and unrecognized/corrupt records alone. Those files, exported reports, and filesystem allocation overhead are outside the managed-byte cap. Each custom `--data` directory has its own limit. Pruning occurs on tool use, not on a background timer. A short `.storage-lock` coordinates filesystem changes; if a process crashes while holding it, subsequent operations fail with recovery instructions. Remove that lock directory only after stopping every Jev process using the telemetry directory. Abandoned operation leases are cleared once their owner process is no longer running.

The server runs with the host's filesystem permissions. The API configuration is environment-controlled. The repository root is supplied per call; filesystem access follows host permissions, not a fixed repository allowlist. This is a retrieval tool, not a security boundary against a malicious repository or other tools reading files directly.

## Development and publication

Run `node --test test/*.test.mjs` before pushing. The suite runs offline without API keys or live Jev calls. Configure the local commit guard once per clone with `git config core.hooksPath .githooks`; it checks indexed files for excluded outputs, common credential patterns, and local user paths. Run `node scripts/check-publish.mjs` manually to inspect the exact commit contents. When `TYPESAFE_API_KEY` is in the environment, the guard also checks for that exact value without printing it. This targeted guard is not a comprehensive secret scanner.

Credentials (`.env*`, except the blank `.env.example`), generated `.mcp.json`, local `jev-context.settings.json`, raw telemetry, reports, CSV/JSONL outputs, and dependencies stay local. Only benchmark **definitions** and manually reviewed label definitions belong in source control. Never force-add generated run records or response payloads. Custom output locations must also be ignored.

Before publishing, stage only intended source/documentation changes and inspect `git diff --cached --stat` and `git diff --cached --check`. Run the publication check against that exact index with the local key loaded, when available:

```powershell
node --env-file=.env scripts/check-publish.mjs
```

Use the path to your existing environment file if it lives elsewhere; never copy its contents into Git. The guard checks all indexed files, including files force-added despite ignore rules, and reports filenames without printing matched secrets. Publish the reviewed source and documentation while keeping credentials, telemetry, and machine-specific configuration private. Before making an existing repository public, review its Git history too: the index guard does not check earlier commits. Do not bypass the guard or include raw `runs.csv`, response snapshots, generated reports, credentials, or machine-specific launchers in a commit. Local preference changes also regenerate the tracked skill; review that diff so personal settings are not unintentionally published as shared defaults.

## Sources

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)
- [Choice](https://docs.typesafe.ai/primitives/choice) and [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)
- [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [MCP server SDK](https://modelcontextprotocol.io/docs/develop/build-server)
- [tiktoken](https://github.com/openai/tiktoken)
