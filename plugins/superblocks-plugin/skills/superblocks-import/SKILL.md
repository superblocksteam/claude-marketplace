---
name: superblocks-import
description: >
  Import, migrate, or port an existing app (React, Replit, Lovable, v0, Streamlit,
  a zip on disk, or files in the conversation) into Superblocks. Use when the
  user has existing source and wants it as a Superblocks application — not when
  they are only editing an app that already exists in Superblocks.
---

# Superblocks import (host director)

You plan and slice. **Superblocks writes** the application through Builder MCP
(`start_app` / `edit_app`). Do not invent Superblocks `client/` or `server/`
files on the laptop. Superblocks already has its own in-sandbox migration
skillset; your job is to ask for the right slices.

## Choose the source path

When source files are already visible in this conversation, call
`upload_artifact` with `files: [{ path, content }]`. Keep their original
relative paths; do not write or zip them first. Pass the returned `artifact` to
`start_app` in `artifacts` and ask Superblocks to migrate the attached source.

When the source is a readable tree on disk, inventory it locally, then use
`start_app` and `edit_app`. Do **not** zip or upload it; send focused prompts
grounded in the files you read.

For a zip when there is **no readable tree**, call `upload_artifact` with
`filePath` (never `zipBase64`), then pass its `artifact` to `start_app` in
`artifacts`. Archives over 50 MB are rejected.

Keep the returned artifact and application IDs. To resume, reuse the same
artifact ID with `edit_app` and the same application ID. Do not upload the
source again, and do not call `start_app` again.

Replit / Lovable / v0: clone or export onto this machine first. Do not ask
the live-edit environment to fetch those clouds.

## Slice order

1. Inventory locally (routes, env keys, ORMs, `fetch`/`axios`, tests). Keep
   the source app running if you can. Map secrets from `.env.example` — never
   paste production `.env` into `edit_app`.
2. `list_integrations`. Reuse an existing datasource (`find_apps_by_integration`)
   before `create_integration`.
3. `start_app` a short fullstack scaffold with named integrations. For an
   uploaded source, include the artifact and ask Superblocks to migrate it.
   One planner: `start_app` always plans and takes no mode, so if you already
   have an ordered slice list, call `ask_user` to put that first plan to them
   and wait for their answer. Only if they approve, call `edit_app` with
   `planAction: "approve"` instead of planning it again. Do not run a second
   “migrate everything” plan.
   Approval is the exception: `planAction: "approve"` builds the pending plan.
   After that, mode is per call and never sticks: every `edit_app` below plans
   unless it passes `mode: "BUILD"`, so send it on each slice.
4. One backend operation per `edit_app`, then `check_app_progress` until
   `testApi` activity exists. There is no MCP SQL tool.
5. One UI route per `edit_app`, wired to APIs that already passed.
6. Auth, jobs, leftovers last.
7. After each slice, `get_application_structure` (and `get_app` URLs). Ground
   the next prompt in what Superblocks actually wrote. `list_knowledge` /
   `get_knowledge` for org playbooks.

If `start_app` errors, follow its returned recovery instructions using its
application ID. Retry with `edit_app` unless `pendingAction` is
`"start_new_app"`; then call `start_app` once with `replacesApplicationId`
set to the failed application ID. Use `list_applications` only when no ID was
returned.

## Primitive map (not Next.js)

- Backend operations are **named APIs** in a registry, not URL routes.
- Each UI page is a Superblocks page using `useApi` / `useApiData` /
  `executeApi` from the fullstack template — not Next App Router, not the
  source app’s QueryClient.
- Datasources are **org integrations** (UUIDs). Credentials live there, not
  `process.env` in generated code. Auth is platform user context; drop the
  source login stack unless Superblocks asks otherwise.

## `edit_app` prompt shape

Ask Superblocks to implement **this slice** as fullstack (APIs vs pages vs
integrations). Tell it to follow its third-party migration skillset. Cite
paths you already read and quote only the small source excerpt a slice needs.

## Do not

- Open `/code-mode/applications/edit/:id` during a Gateway turn (steals the
  editor peer).
- `browser_evaluate` JWTs; `browser_close` / Playwright `--isolated` between
  IdP and retry.
- Dump `.env` or production data into prompts.
