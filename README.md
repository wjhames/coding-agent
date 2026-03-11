# coding-agent

Turn a coding task into a reviewable result from the terminal.

`coding-agent` can inspect a repo, build a plan, apply edits, run verification, pause for approval, resume later, and return machine-readable output for automation. The same runtime powers both the non-interactive CLI and the interactive shell.

## Why This Project Exists

This project explores what makes a CLI coding agent useful in practice:

- trustable local execution
- clear approval boundaries
- resumable sessions
- verification before calling work done
- a terminal UI that stays readable while the agent streams, uses tools, and waits for input

## What You Get

- Faster repository work from the terminal
  - inspect files, search code, edit files, run commands, and verify changes in one loop
- Better control over risky actions
  - file edits and shell commands can require approval instead of running silently
- Recoverable work
  - sessions persist to disk and can be resumed after pauses or interruptions
- Automation-friendly output
  - `--json` returns structured results for scripts and other tools
- One runtime for both modes
  - interactive mode and non-interactive mode use the same task engine

## Core Flow

1. Collect repo context and guidance.
2. Ask the model to investigate or act through tools.
3. Record plans, observations, changed files, and events.
4. Pause when approval is required.
5. Run verification commands after changes.
6. Persist the session and return a final result.

## Architecture

### Runtime

The runtime is the center of the project.

- `src/app/exec.ts`
  - task execution loop, tool orchestration, approvals, verification, persistence
- `src/runtime/api.ts`
  - shared entrypoints for CLI and interactive mode
- `src/session/`
  - session snapshots plus append-only event logs

### Tool Layer

The model does not touch the filesystem or shell directly. It works through explicit tools.

- `read_file`
- `list_files`
- `search_files`
- `apply_patch`
- `run_shell`
- `write_plan`

Tools validate input with Zod, enforce workspace boundaries, and return structured results.

### Trust Model

The runtime separates safe reads from risky actions.

- read-only inspection can run directly
- edits and side-effecting shell commands can require approval
- paused sessions persist the pending action and can resume later
- verification results are recorded with the session

### Interactive UI

The UI is an Ink client over the runtime.

- transcript-first layout
- streaming assistant output
- live activity block while the agent is working
- queued prompts during active runs
- app-managed scroll
- progressive markdown rendering for streamed and completed responses

## Features

- Interactive shell
- Non-interactive execution with `exec`
- Session resume with `resume`
- Session listing with `sessions`
- Environment diagnostics with `doctor`
- OpenAI-compatible provider support
- JSON output with `--json`
- Approval policies: `auto`, `prompt`, `never`
- Verification command inference and execution

## Example Usage

Start the interactive shell:

```bash
coding-agent
```

Run a task non-interactively:

```bash
coding-agent exec "fix the failing test"
```

Run a task and emit JSON:

```bash
coding-agent exec "explain this module" --json
```

Resume the latest paused session from interactive mode:

```bash
coding-agent resume
```

Resume a specific session:

```bash
coding-agent resume <session-id>
```

List recent sessions:

```bash
coding-agent sessions
```

Check configuration and provider readiness:

```bash
coding-agent doctor
```

## Configuration

Configuration lives in:

```text
~/.coding-agent/config.json
```

Example:

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "apiKey": "YOUR_API_KEY",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4.1-mini",
      "approvalPolicy": "prompt",
      "maxSteps": 50
    }
  }
}
```

Sessions are stored under:

```text
~/.coding-agent/sessions/
```

## Development

Requirements:

- Node.js 22+

Install dependencies:

```bash
npm install
```

Run the interactive app in development:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Typecheck:

```bash
npm run typecheck
```

Test:

```bash
npm test
```

Live smoke checks:

```bash
npm run smoke:inspect
npm run smoke:write
npm run smoke:pause-resume
```

## Project Structure

```text
src/cli/           command parsing and CLI entrypoints
src/runtime/       shared runtime contracts and API
src/app/           execution loop, approvals, verification, context
src/tools/         file, search, patch, and shell tools
src/llm/           OpenAI-compatible client and tool loop
src/session/       snapshots, event logs, reducers
src/interactive/   Ink UI, transcript model, markdown rendering
tests/unit/        unit and regression coverage
scripts/           smoke test helpers
```

## Current State

This project already supports the full local agent loop:

- inspect a repo
- plan work
- edit files
- run commands
- verify changes
- pause for approval
- resume sessions
- drive everything from JSON or the interactive shell

The remaining work is mostly polish:

- interaction edge cases
- real-world smoke usage
- tighter summaries and verification presentation
- more UI tuning from repeated use
