# Deploy Phi to GCP: one Docker container on a VM, projects on a persistent disk

## Context

Phi runs only on the user's Mac (127.0.0.1, `phi init` / `bun dev`). The user wants to reach
it from anywhere by deploying it to Google Cloud.

Decisions taken with the user:

- **Single user.** It stays a personal tool, now behind Google sign-in.
- **Compute Engine VM + persistent disk.** Projects live on a persistent disk, a real
  filesystem. latexmk, texlab, SyncTeX, mtime-based save conflicts, atomic renames and the
  trash all keep working unchanged.

Cloud Run with a bucket was rejected: there is no POSIX filesystem, so a sync layer would be
needed, plus cold starts of a 2 GB TeX image. Filestore was rejected on cost.

The app's security model assumes a local machine:

- a Host/Origin check against `127.0.0.1:<port>`;
- any absolute path can be opened as a project;
- dev-mode bundling.

The work is therefore about 40% app hardening, 30% packaging and 30% infrastructure.

## Target architecture

```
Browser ──HTTPS──▶ Global external Application Load Balancer (managed cert, your domain)
                     │  IAP: Google sign-in, only your account (roles/iap.httpsResourceAccessor)
                     ▼  backend timeout 3600 s (SSE chat stream + LSP WebSocket)
            VM e2-medium, Container-Optimized OS, no external IP (egress via Cloud NAT)
              └─ docker: phi image (Bun + TeX Live + texlab), non-root, port 3000
                   └─ /data  ← persistent disk "phi-data" (pd-balanced 20 GB, daily snapshots)
                        ├─ projects/<name>/...   (+ .latex-agent/ threads, trash)
                        └─ home/.latex-agent/settings.json  (provider keys, 0600)
```

- **Firewall:** port 3000 is open only to the load balancer and health-check ranges
  (35.191.0.0/16, 130.211.0.0/22). SSH (22) is open only from the IAP range (35.235.240.0/20).
- **Cost:** about $45–50/month. VM ~$25, LB forwarding rule ~$18, disk + snapshots ~$3,
  NAT ~$2.

## Phase 1: app changes (server + web)

1. **Config** (`apps/server/src/config.ts`, `loadConfig`). New environment variables:
   - `HOST`: default `127.0.0.1`; `0.0.0.0` in the container.
   - `PUBLIC_ORIGIN`: e.g. `https://phi.example.com`.
   - `PROJECTS_DIR`: e.g. `/data/projects`.
   - `IAP_AUDIENCE` and `ALLOWED_EMAIL`.
   - `NODE_ENV=production`.

   Unset means today's local behavior, unchanged. `phi` and `bun dev` are unaffected.

2. **Security** (`apps/server/src/routes/security.ts`). `isAllowed` accepts the local origins
   plus `PUBLIC_ORIGIN`, and its Host.
   - **IAP check.** New `verifyIap(req)` requires the `x-goog-iap-jwt-assertion` header when
     `IAP_AUDIENCE` is set. It verifies ES256 against Google's JWKS
     (`https://www.gstatic.com/iap/verify/public_key-jwk`, cached) using WebCrypto, so no
     dependency. It checks `aud`, `exp`, issuer `https://cloud.google.com/iap`, and the email
     against `ALLOWED_EMAIL`.
   - **Where it applies.** `guard()` calls it, and so does the WebSocket upgrade in
     `routes/lsp.ts`, which already uses `isAllowed`.
   - **Why both IAP and this check:** if the firewall is ever misconfigured, requests that
     bypass IAP are still refused.
3. **Health check.** Unguarded `GET /healthz` → `200 ok`, with no data, for the load balancer.
   `/api/health` stays guarded.
4. **Production bundling** (`apps/server/src/index.ts`): `development: false` when
   `NODE_ENV=production`. The frontend is then bundled once, minified, with no HMR socket.
   Also use `hostname: config.host`.
5. **Projects confined to `PROJECTS_DIR`** (`apps/server/src/project.ts`, `checkProjectPath`).
   When it is set, a project must be a direct child folder of it. Otherwise the server could
   open `/` or `/etc` as a project. Paths inside projects already go through
   `resolveInProject`.
6. **Create a project from the browser.** `phi init` can't run remotely.
   - Move `listTemplates` / `copyTemplate` from `apps/cli/src/templates.ts` into
     `apps/server/src/services/templates.ts`; the CLI imports it from there.
   - New routes:
     - `GET /api/templates`;
     - `GET /api/projects` (folders in `PROJECTS_DIR`);
     - `POST /api/projects {name, template}`: validates the name (`[A-Za-z0-9 _-]{1,64}`),
       creates the folder, copies the template, then calls `projects.open`.
   - Shared types go in `packages/shared/src/api.ts`.
   - **Web** (`components/Project/ProjectPicker.tsx`): in cloud mode, `GET /api/project` adds
     `managed: true`, and the picker shows a list of projects plus "New project" (name and
     template, using the template names and descriptions). The absolute path field stays
     local-only. Use shadcn components that are already installed.
7. **Download a project as .zip.** New `GET /api/project/archive` that streams the open
   project, without `.latex-agent/` or build artifacts, using `listFiles`. It adds the
   dependency `fflate` 0.8.2: small and dependency-free; Bun has no built-in zip writer.
   A button goes next to the project name. (Importing a .zip is out of scope; uploads of
   images and PDFs already exist.)
8. **Docs.** CLAUDE.md "Security" gains: "Binds 127.0.0.1 unless HOST is set, which is only
   for the container behind IAP; then every request needs a valid IAP token." SPEC gains a
   new section 9, Deployment, covering these behaviors.

## Phase 2: container

1. **`Dockerfile`** at the repo root, multi-stage.
   - **Build stage:** `oven/bun:1.4.3-debian` running `bun install --frozen-lockfile`. All
     dependencies are kept: `bun-plugin-tailwind` is needed at run time for the HTML import.
   - **Runtime stage:** `debian:bookworm-slim` with:
     - TeX: `latexmk texlive-latex-extra texlive-fonts-recommended texlive-science
texlive-bibtex-extra biber texlive-pictures` (about 1.5 GB);
     - texlab 5.26.0 from its pinned GitHub release (x86_64 Linux tarball);
     - Bun copied from the build stage;
     - the app source and `templates/`.
   - **User and environment:** user `phi` (uid 1000); `HOME=/data/home`, `HOST=0.0.0.0`,
     `PORT=3000`, `PROJECTS_DIR=/data/projects`, `NODE_ENV=production`.
   - **Health:** `HEALTHCHECK` on `/healthz`.
   - **Command:** `bun apps/server/src/index.ts`.
   - `findTexBinary`, `findTexlab` and synctex find their binaries on PATH, so no code change
     is needed there.
2. **`.dockerignore`:** `node_modules`, `.env`, `.git`, `sample-project` build output,
   `**/.latex-agent`.
3. **Build for amd64.** The Mac is arm64, so the image is built by Cloud Build, not locally.
   `deploy/gcp/cloudbuild.yaml` pushes to Artifact Registry
   `REGION-docker.pkg.dev/PROJECT/phi/phi:<git-sha>`.

## Phase 3: GCP infrastructure (`deploy/gcp/`)

gcloud scripts, idempotent where gcloud allows. No Terraform: one VM doesn't justify a new
tool.

1. **`setup.sh`**, run once, with variables `PROJECT`, `REGION`, `ZONE`, `DOMAIN` and `EMAIL`:
   1. Enable APIs: compute, artifactregistry, cloudbuild, iap.
   2. Create the Artifact Registry repo.
   3. Create disk `phi-data` (20 GB pd-balanced) and a snapshot schedule (daily, keep 14).
   4. Create Cloud Router + Cloud NAT (egress to model APIs and GitHub without an external
      IP).
   5. Create firewall rules (LB/health-check ranges → 3000; IAP range → 22).
   6. Create the VM: e2-medium, COS image, `--no-address`, the disk attached, and a service
      account with `roles/artifactregistry.reader`. Its `cloud-init` user-data does three
      things:
      - formats and mounts the disk at `/mnt/disks/data` the first time;
      - creates `projects/` and `home/` owned by uid 1000;
      - installs a systemd unit `phi.service` that runs `docker run --restart=always
-p 3000:3000 -v /mnt/disks/data:/data --read-only --tmpfs /tmp
--env-file /mnt/disks/data/phi.env <image>`.

      COS supports cloud-init; `create-with-container` is deprecated.

   7. Create the unmanaged instance group with named port `http:3000`, the health check
      (`/healthz`), and the backend service (HTTP, timeout 3600 s, IAP enabled).
   8. Create the URL map, the managed SSL cert for `DOMAIN`, the HTTPS proxy, a static IP, and
      the forwarding rule on 443; also an HTTP→HTTPS redirect.
   9. Grant `roles/iap.httpsResourceAccessor` to `user:$EMAIL`.
   10. Print the A record to create for `DOMAIN`, and the `IAP_AUDIENCE`
       (`/projects/<number>/global/backendServices/<id>`) that goes into `phi.env`.
2. **`deploy.sh`**, run per release:
   1. `gcloud builds submit --config deploy/gcp/cloudbuild.yaml` with the git SHA as tag.
   2. `gcloud compute ssh phi --tunnel-through-iap`, which pulls the new tag, updates
      `phi.env` (image tag) and runs `systemctl restart phi`.
3. **Secrets.** Provider keys are entered in Settings and stored on the persistent disk
   (0600, encrypted at rest by GCP). Optionally they come from `phi.env`; Secret Manager is
   not needed for one user.
4. **`deploy/gcp/README.md`.** Covers:
   - prerequisites: gcloud, a domain, and the OAuth consent screen, which is created once in
     the console;
   - setup, deploy, rollback (deploy a previous SHA);
   - restore a snapshot;
   - costs;
   - a cheaper no-load-balancer variant: `gcloud compute start-iap-tunnel phi 3000
--local-host-port=localhost:3000`, about $27/month. It uses the local Host/Origin
     checks unchanged.

## Tests

- `config.test.ts`: the new variables are parsed and defaulted (local behavior is unchanged
  when they are unset).
- `security.test.ts` (extended):
  - `PUBLIC_ORIGIN` is accepted and other origins are refused;
  - `verifyIap` uses an ES256 key generated in the test plus an injected JWKS fetcher, and
    covers: valid; wrong audience; expired; another email; missing header; bad signature;
  - the LSP upgrade also requires IAP.
- `project.test.ts` (extended): with `PROJECTS_DIR`, outside paths, `..`, and the directory
  itself are refused; children are accepted.
- `routes/projects.test.ts`: list; create from a template (bad name 400, existing 409, unknown
  template 400); the created project is opened.
- `routes/archive.test.ts`: the zip holds sources, not `.latex-agent/` or `.aux`.
- `/healthz` is reachable without Origin or Host checks.
- A DOM test for the managed picker (list, new project form).
- CLI tests keep passing after `templates.ts` moves.

## Verification

1. `bun run typecheck`, `bun test`.
2. **Container, locally.**
   - Run `docker buildx build --platform linux/amd64 -t phi .` (or a native arm64 build for a
     quick check). Then `docker run -p 3000:3000 -v $PWD/.tmp-data:/data -e
PUBLIC_ORIGIN=http://localhost:3000 phi`.
   - In the scripted Puppeteer harness:
     - create a project from the "paper" template;
     - compile with the container's latexmk and see the PDF;
     - check SyncTeX;
     - check `\cite{` completion from the container's texlab;
     - run an agent message (faux provider via env);
     - download the zip.
   - Restart the container; the projects and settings are still there.
3. **GCP.**
   1. `setup.sh` + `deploy.sh`.
   2. Before DNS and the certificate: `start-iap-tunnel` smoke test.
   3. After the certificate is ACTIVE:
      - an incognito window gets Google sign-in; your account is in, another account gets
        a 403 from IAP;
      - `curl` straight to the VM's internal IP from another VM gets a 401 (no IAP JWT);
      - an agent run longer than 30 s streams to completion (backend timeout);
      - the LSP WebSocket connects;
      - compile works.
   4. `gcloud compute instances reset phi`: the projects are still there.
   5. Next day: the snapshot exists.
