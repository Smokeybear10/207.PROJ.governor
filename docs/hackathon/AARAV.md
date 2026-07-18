# Aarav — Rules and Tasks

Working agreements Aarav has set for this repo, plus his granular task list.
AI agents working on Aarav's behalf follow everything in this file.

## Rules

1. Everyone pushes straight to `main`. Always `git pull --rebase` before every
   push.
2. One commit per change. Small, self-contained commits, pushed immediately.
3. Do not modify teammates' files. Aarav's areas: `vscode-extension/`,
   `docs/hackathon/`, and frontend files only when explicitly asked.
4. The dashboard is not the MVP. The MVP is the budget-control API + CLI:
   - `POST /v1/jobs` creates a governed budget
   - `POST /v1/jobs/:id/responses` submits work through the governor
   - `GET /v1/jobs/:id` shows spending, reservations, remaining budget
   - `GET /v1/jobs/:id/responses/:requestId` retrieves a stored result
   - `POST /v1/jobs/:id/finalize` accepts or rejects the final output
   - Flow: CLI → job/workflow → governed executor → governor core → OpenAI
     client. Live calls: start the server with `OPENAI_API_KEY`, then create
     the job.
5. Anything user-facing must be pitchable to investors. Judging criteria:
   technical complexity (covered), pitch, idea quality, investability, track
   fit. Every hour of work should serve the weak four.
6. Keep the truth boundary: synthetic and live data stay clearly labeled.
7. Discord announcements and team decisions get saved as md files in
   `docs/hackathon/` so AI agents have context.

## Aarav's tasks

### 1. VS Code extension (primary, new)

The governor should live where developers work. The extension surfaces
which workflow steps are SAFE / WATCH / AT_RISK and lets you drive the
governor API without leaving the editor.

- [x] Scaffold `vscode-extension/` (package.json, tsconfig, src/extension.ts,
      README with F5 run instructions)
- [x] Setting: `tokenGovernor.apiBaseUrl` (default `http://127.0.0.1:8787`)
- [x] Command: `Governor: Health Check`
- [x] Command: `Governor: Create Job` (prompts for budget in USD, POSTs
      /v1/jobs, remembers the job as active)
- [x] Command: `Governor: Set Active Job` (pick a known job or paste an id)
- [x] Status bar item: committed / budget for the active job, colored by the
      core's risk thresholds (WATCH 70%, AT_RISK 90%), polling every 2s
- [x] Job panel webview: budget bar, accounting breakdown, per-response
      status flags so you can see which steps to look into
- [x] Command: `Governor: Submit Selection Through Governor` (POSTs the
      editor selection to /v1/jobs/:id/responses)
- [x] Command: `Governor: Finalize Pending Response`
- [x] Moved the sidebar into a vertical Activity Bar webview view
      (Governor icon, `Open Job View`) instead of a wide editor panel
- [x] API contract smoke-tested against the live local server: job create,
      job show, and submit-response (correctly refuses with
      `PROVIDER_NOT_CONFIGURED` when no key is set, which the extension's
      error handling already catches as a warning, not a crash)
- [ ] Press F5 yourself, confirm the sidebar renders and the status bar
      updates live (needs a real VS Code GUI, can't be done headless)
- [ ] Repeat against a live `OPENAI_API_KEY` run with Aryan once he has one
      going, to get a real (non-refused) trace through the extension
- [ ] Screenshot the sidebar + status bar for the pitch
- Done means: create a job, submit work, and watch spend + risk update in the
  status bar, live in front of a judge.

### 2. Done

- [x] Restore `server/artifacts/` swallowed by `.gitignore`
- [x] Hackathon announcements + strategy docs
- [x] Intervention checklist (docs/hackathon/INTERVENTIONS.md)
- Dashboard work is handed off; no more dashboard changes from Aarav.

### 3. Stretch — reassign, don't duplicate

Evaluation runner (score frozen runs against sealed ground truth, cost per
successful task) was listed here as a fallback. If Aryan has actually
picked this up, drop it from Aarav's list entirely — confirm with him so
nobody builds it twice.
