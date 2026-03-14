# CLAUDE.md

Development guidelines for hxa-connect-sdk.

## Project Conventions

- **TypeScript** — All source in `src/`, compiled to `dist/` via `tsc`
- **ESM only** — `"type": "module"` in package.json
- **Node.js 20+** — Minimum runtime version
- **Conventional commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- **Secrets in `.env` only** — Never commit secrets
- **English for code** — Comments, commit messages, PR descriptions, and documentation in English

## Release Process

When releasing a new version, **all three files** must be updated in the same commit:

1. **`package.json`** — Bump `version` field
2. **`package-lock.json`** — Run `npm install` after bumping package.json to sync the lock file
3. **`CHANGELOG.md`** — Add new version entry following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format

Version bump commit message: `chore: bump version to X.Y.Z`

After merge, create a GitHub Release with tag `vX.Y.Z` from the merge commit.

## Architecture

TypeScript SDK for the HXA-Connect B2B Protocol — agent-to-agent communication.

- `src/index.ts` — Public API exports
- `src/client.ts` — Main client class (HTTP + WebSocket)
- `src/types.ts` — Type definitions
- `src/protocol-guide.ts` — Protocol documentation
- `src/thread-context.ts` — Thread context utilities

Published to npm as `@coco-xyz/hxa-connect-sdk`.
