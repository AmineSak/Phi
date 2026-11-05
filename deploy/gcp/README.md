# Deploying Phi to Google Cloud

This runs your own Phi on Google Cloud, reachable from any browser at `https://<your domain>`
after a Google sign-in that only your account passes. It stays a single-user Phi: one VM, one
container, your projects on a disk.

```
Browser ──HTTPS──▶ Load balancer (Google-managed certificate for your domain)
                     │  IAP: Google sign-in, only your account
                     ▼
               VM (Container-Optimized OS, no public IP; internet out via Cloud NAT)
                 └─ Phi container (Bun, TeX Live, texlab), port 3000
                      └─ /data ← persistent disk "phi-data", snapshotted daily
                           ├─ projects/<name>/       your projects
                           └─ home/.latex-agent/     settings and provider keys
```

Phi itself checks every request: API calls must carry IAP's signed header for your account, so
a request that bypassed the load balancer is refused too.

**Cost:** roughly $45–50 a month: the VM (e2-medium) ~$25, the load balancer ~$18, the disk and
its snapshots ~$3, Cloud NAT ~$2. Model API usage is billed by your provider.

## Prerequisites

1. A Google Cloud project with billing enabled, and the
   [gcloud CLI](https://cloud.google.com/sdk/docs/install) signed in (`gcloud auth login`).
2. A domain or subdomain you control, e.g. `phi.example.com`, to point at Phi.
3. The OAuth consent screen and an OAuth client for the sign-in page (once, in the console):
   1. **APIs & Services → OAuth consent screen**: user type _External_ (or _Internal_ in a
      Google Workspace organization), app name "Phi", your email; add your account as a test
      user.
   2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type _Web
      application_. Note the client ID and secret.
   3. After `setup.sh` has run, add this authorized redirect URI to the client:
      `https://iap.googleapis.com/v1/oauth/clientIds/<CLIENT_ID>:handleRedirect`.

   In a Google Workspace organization you can skip the OAuth client and let Google manage it
   (leave `OAUTH_CLIENT_ID` empty); with a personal Gmail account, create it.

## Set up (once)

```sh
cp deploy/gcp/phi.conf.example deploy/gcp/phi.conf
$EDITOR deploy/gcp/phi.conf      # project, region, domain, your email, OAuth client
deploy/gcp/setup.sh
```

`setup.sh` creates, and on later runs keeps:

- the APIs, an Artifact Registry repository for the image, and a service account for the VM;
- the disk `phi-data` (20 GB) with daily snapshots kept 14 days;
- Cloud Router + Cloud NAT, so the VM reaches the model APIs without a public IP;
- firewall rules: port 3000 only from the load balancer, SSH only through IAP;
- the VM `phi` (Container-Optimized OS) which mounts the disk and runs the container at boot;
- the HTTPS load balancer (static IP, managed certificate, HTTP→HTTPS redirect) with IAP,
  and access for your account only;
- Phi's settings on the VM: `PUBLIC_ORIGIN`, `IAP_AUDIENCE`, `ALLOWED_EMAIL`.

It ends by printing the IP address. Create a DNS **A record** for your domain pointing to it;
the certificate turns ACTIVE 15–60 minutes after the record resolves
(`gcloud compute ssl-certificates describe phi-cert --global`).

## Deploy

```sh
deploy/gcp/deploy.sh
```

It builds the image with Cloud Build (on amd64, from your working tree), tags it with the
current commit, and restarts the VM's container on it. Then open `https://<your domain>`, sign
in, create a project from a template, and add a provider key in Settings.

- **Update:** commit, then `deploy/gcp/deploy.sh` again.
- **Roll back:** `deploy/gcp/deploy.sh <older commit>`. Images already built are reused.
- **Logs:** `gcloud compute ssh phi --zone=<zone> --tunnel-through-iap --command='docker logs phi'`.
- **Try it without DNS**, through an IAP tunnel to your machine:
  `gcloud compute start-iap-tunnel phi 3000 --local-host-port=localhost:3000 --zone=<zone>`.
  The API then expects IAP's header and refuses the tunnel's requests; this is only a check
  that the container is up (`curl localhost:3000/healthz`).

## Your data

- **Projects** are folders on the disk. In the app, the project menu offers **Download as
  .zip**; uploads (images, PDFs) go through the file tree.
- **Backups** are the daily disk snapshots. To restore one: stop the VM, create a disk from
  the snapshot (`gcloud compute disks create phi-data-restored --source-snapshot=<snapshot>
--zone=<zone>`), detach `phi-data`, attach the restored disk with device name `phi-data`,
  and start the VM.
- **Provider keys** you enter in Settings are stored on the disk (readable by Phi only,
  encrypted at rest by Google Cloud), never sent to the browser.

## Removing it

Delete, in this order: the forwarding rules (`phi-https-rule`, `phi-http-rule`), the proxies
(`phi-https`, `phi-http`), the URL maps (`phi-map`, `phi-redirect`), the certificate and the IP,
the backend service and health check, the instance group, the VM, then the disk `phi-data` and
its snapshots once you have downloaded your projects.

## How it fits together

| File                          | Role                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `Dockerfile`                  | The image: Bun, TeX Live from Debian, texlab, the app; runs as user `phi`. |
| `deploy/docker-entrypoint.sh` | Creates `/data/projects` and `/data/home`, then drops to `phi`.            |
| `deploy/gcp/setup.sh`         | One-time infrastructure, idempotent.                                       |
| `deploy/gcp/cloud-init.yaml`  | VM boot: mounts the disk, runs the image named in metadata.                |
| `deploy/gcp/deploy.sh`        | Build with Cloud Build, point the VM at the new image, restart.            |
| `deploy/gcp/cloudbuild.yaml`  | The Cloud Build step.                                                      |

In the container Phi runs with `HOST=0.0.0.0`, `PROJECTS_DIR=/data/projects`,
`NODE_ENV=production`, plus the three settings from `setup.sh`. Projects can only be the folders
of `PROJECTS_DIR` and are created from templates in the browser (SPEC 9).
