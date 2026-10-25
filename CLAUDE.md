# BookKeeper

Quotes, invoices, projects and payment-reminder app (React + Vite, Supabase, Netlify Functions, Capacitor iOS) for Mworx Group and MT Management.
Full context: docs/AI_CONTEXT.md

## AI documentation — read first, keep current

This repository keeps a shared knowledge base for every AI assistant (Claude, ChatGPT/Codex, Cursor):

- `docs/AI_CONTEXT.md` — what the application is, how it is built and deployed, data model, integrations, business rules.
- `docs/AI_HANDOFF.md` — current status, work in progress, bugs, next tasks.

**Before starting work:** read both files.

**After completing any significant task** (new feature, behaviour change, schema or migration, new integration, deployment/config change, notable bug fix):

1. Update `docs/AI_CONTEXT.md` if the architecture, features, data model, integrations or deployment changed.
2. Update `docs/AI_HANDOFF.md`: move finished work into "Recently completed features", refresh work in progress, outstanding bugs, pending tests and recommended next tasks, set "Date of last update", and add a line to the update log.
3. Commit the documentation changes in the same commit or pull request as the code they describe.
4. Push, so the latest documentation is on GitHub.

Rules for these files:
- Verify against the code; never invent. Mark anything unconfirmed as **Unverified**.
- Never include API keys, passwords, tokens, service-role keys, connection strings or env var values — name the variable only.
- Never include guest, client or other personal or confidential information.
- This repository is public — anything committed here is world-readable.
