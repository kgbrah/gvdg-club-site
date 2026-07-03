# CLAUDE.md — gvdg-club-site

**Multi-agent repo. Read [AGENTS.md](AGENTS.md) before deploying or branching — it is the mandatory
coordination protocol.**

TL;DR:
- **Never deploy by hand.** Use `./scripts/gvdg-deploy.sh` (it locks, runs a freshness gate, and stamps a
  version marker). `wrangler pages deploy` / `wrangler deploy` run directly will clobber other sessions.
- **Deploy only a clean, committed HEAD** that **contains the currently-live commit** — you may only move
  gvdgclub.com forward, never sideways/backward. The guard enforces this; if it aborts, reconcile with
  `origin/main`, don't force past it.
- **`main` is the single integration branch** for gvdgclub.com. Don't deploy a fork that has diverged from
  `main` — merge into `main` and reconcile there first.
- Check what's live: `./scripts/gvdg-deploy.sh --status` or `curl -s https://gvdgclub.com/version.json`.

Production greenvillediscgolf.com (GitHub Pages) is separate and is not touched by the dev deploy commands.
