# AppRunner

Control plane for Flutter project archives and their build/test runs.

Upload a project archive or pull one from GitHub, hand a private key to a public
GitHub Actions runner, and watch it walk three gates in order:

```
flutter test  →  ios build  →  firebase xctest
```

A closed gate stops everything downstream. The interface says so explicitly:
stages after a failure read *not reached*, never *pending*.

Runs can also launch the built app on an iOS simulator and capture its first
screen. AppRunner stores the PNG with the run and previews it in the browser.

The pipeline lives in a separate public repository so macOS runners are free
and no project source is ever public. You supply your own copy of it and name
it in `CI_REPO`.

## Running it

Copy `.env.example` to `.env` and fill it in; `compose.yaml` reads it.
`.env` is gitignored because every value in it is a secret.

### Rotating a secret

`ADMIN_PASSWORD` is re-applied to the operator account on every boot, so
changing it in `.env` and redeploying is the whole rotation procedure.

On Asgard specifically, editing the `.env` file is not sufficient: the control
plane keeps a materialised copy of the service environment, so the new value
only reaches the container after a `service_config_update` as well. Verify a
rotation took effect by checking that the *old* password is rejected — a
deployment that fails while pulling its base image leaves the previous
container, and its previous secrets, happily running.

Rotating `ENCRYPTION_KEY` makes any stored GitHub token unreadable. Reconnect
GitHub in Settings afterwards; nothing else is affected.

| Variable | Meaning |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seeded operator account. The password is re-applied on every boot, so rotating it here is enough. |
| `SESSION_SECRET` | Signs session cookies. |
| `ENCRYPTION_KEY` | Encrypts stored GitHub tokens at rest. |
| `CI_REPO` / `CI_WORKFLOW` / `CI_REF` | The pipeline repository to dispatch. |
| `CI_DISPATCH_TOKEN` | GitHub token with `actions:write` on `CI_REPO`. |
| `FIREBASE_DAILY_QUOTA` | Free-tier device tests per day. Defaults to 5. |

Locally:

```bash
npm install
ADMIN_PASSWORD=… SESSION_SECRET=… ENCRYPTION_KEY=… COOKIE_SECURE=false npm start
```

## The CI API

The runner authenticates with a bearer key created in Settings. It scopes to
one operator's projects and nothing else.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/ci/resolve` | Metadata for the archive to build. |
| `GET /api/v1/ci/archive` | The archive itself. |
| `POST /api/v1/ci/runs/:id/start` | Claim a run and record its GitHub run URL. |
| `POST /api/v1/ci/runs/:id/stage` | Move one gate to running, passed, failed, or skipped. |
| `POST /api/v1/ci/runs/:id/events` | Append a progress line. |
| `POST /api/v1/ci/runs/:id/logs` | Upload a build log. |
| `POST /api/v1/ci/runs/:id/artifacts` | Upload build artifacts. |
| `POST /api/v1/ci/runs/:id/artifacts/from-github` | Pull a build artifact or an atomic named screenshot set from Actions. |
| `POST /api/v1/ci/runs/:id/finish` | Close the run. |

`resolve` and `archive` accept `?project=<slug>` for a specific project,
`?run=<id>` for a run's pinned archive, or nothing at all — which returns the
newest archive the key's owner has uploaded.

## Data

Everything lives on one volume: SQLite at `/data/apprunner.sqlite`, archives
under `/data/archives`, build output under `/data/artifacts`.

## Design

The interface is built on a Cursor-derived design system package. `public/app.css` opens with that package's `:root` token
block pasted verbatim, per its usage contract; every rule after it references
`var(--token)` and nothing else.
