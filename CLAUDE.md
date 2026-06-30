# gvdg-club-site

Static club site (HTML/CSS/JS via GitHub Pages). No build step; edit HTML directly. Companion Cloudflare Worker handles dynamic bits.

<!-- SAW_PROJECT_START -->
## SAFe Agentic Workflow (SAW)

This repo uses the SAFe Agentic Workflow. Ticket prefix **`GVDG`**, main branch **`main`**.

- **Branches**: `GVDG-<n>-<short-desc>` for feature work.
- **Commits**: `type(scope): description [GVDG-<n>]`; rebase-first, linear history.
- **Flow**: small, PR-gated changes; verify acceptance criteria before marking work done.
- **Harness (installed globally for Claude Code, Codex, and Hermes)**:
  - Claude commands: `/saw:start-work`, `/saw:pre-pr`, `/saw:end-work`, `/saw:release`, `/saw:retro`, `/saw:quick-fix`, …
  - Model-invoked skills: `safe-workflow`, `spec-creation`, `pattern-discovery`, `security-audit`, `testing-patterns`, …
  - SAFe agent profiles: `bsa`, `system-architect`, `qas`, `rte`, `security-engineer`, …
- Claude soft reminders (non-blocking) live in `.claude/settings.local.json`.

See the global `safe-workflow` skill for the full git workflow.
<!-- SAW_PROJECT_END -->
