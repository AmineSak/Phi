#!/usr/bin/env bash
# One-time GCP setup for Phi (SPEC 9): a VM running the container, its persistent disk, and an
# HTTPS load balancer with IAP in front. Safe to run again: existing resources are kept.
# Usage: deploy/gcp/setup.sh   (reads deploy/gcp/phi.conf; see deploy/gcp/README.md)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=/dev/null
source "$HERE/phi.conf"
: "${PROJECT:?} ${REGION:?} ${ZONE:?} ${DOMAIN:?} ${EMAIL:?}"
MACHINE_TYPE=${MACHINE_TYPE:-e2-medium}
DISK_SIZE=${DISK_SIZE:-20GB}
SA="phi-vm@${PROJECT}.iam.gserviceaccount.com"

step() { printf '\n== %s\n' "$*"; }
# Runs the create command unless the describe command finds the resource.
ensure() {
  local describe=$1 create=$2
  if eval "$describe" >/dev/null 2>&1; then echo "exists: $describe"; else eval "$create"; fi
}

gcloud config set project "$PROJECT" >/dev/null

step "APIs"
gcloud services enable compute.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iap.googleapis.com

step "Artifact Registry (container images)"
ensure "gcloud artifacts repositories describe phi --location=$REGION" \
  "gcloud artifacts repositories create phi --repository-format=docker --location=$REGION"

step "Service account for the VM (pulls images, writes logs)"
ensure "gcloud iam service-accounts describe $SA" \
  "gcloud iam service-accounts create phi-vm --display-name='Phi VM'"
gcloud artifacts repositories add-iam-policy-binding phi --location="$REGION" \
  --member="serviceAccount:$SA" --role=roles/artifactregistry.reader >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role=roles/logging.logWriter >/dev/null

step "Persistent disk with daily snapshots (kept 14 days)"
ensure "gcloud compute resource-policies describe phi-daily --region=$REGION" \
  "gcloud compute resource-policies create snapshot-schedule phi-daily --region=$REGION \
     --daily-schedule --start-time=03:00 --max-retention-days=14 --on-source-disk-delete=keep-auto-snapshots"
ensure "gcloud compute disks describe phi-data --zone=$ZONE" \
  "gcloud compute disks create phi-data --zone=$ZONE --size=$DISK_SIZE --type=pd-balanced \
     --resource-policies=phi-daily"

step "Outbound internet without a public IP (model APIs): Cloud NAT"
ensure "gcloud compute routers describe phi-router --region=$REGION" \
  "gcloud compute routers create phi-router --network=default --region=$REGION"
ensure "gcloud compute routers nats describe phi-nat --router=phi-router --region=$REGION" \
  "gcloud compute routers nats create phi-nat --router=phi-router --region=$REGION \
     --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges"

step "Firewall: port 3000 from the load balancer only; SSH from IAP only"
ensure "gcloud compute firewall-rules describe phi-allow-lb" \
  "gcloud compute firewall-rules create phi-allow-lb --network=default --direction=INGRESS \
     --allow=tcp:3000 --source-ranges=130.211.0.0/22,35.191.0.0/16 --target-tags=phi"
ensure "gcloud compute firewall-rules describe phi-allow-iap-ssh" \
  "gcloud compute firewall-rules create phi-allow-iap-ssh --network=default --direction=INGRESS \
     --allow=tcp:22 --source-ranges=35.235.240.0/20 --target-tags=phi"

step "VM (Container-Optimized OS, no public IP)"
CLOUD_INIT=$(mktemp)
trap 'rm -f "$CLOUD_INIT"' EXIT
sed "s/__REGION__/$REGION/g" "$HERE/cloud-init.yaml" > "$CLOUD_INIT"
ensure "gcloud compute instances describe phi --zone=$ZONE" \
  "gcloud compute instances create phi --zone=$ZONE --machine-type=$MACHINE_TYPE \
     --image-family=cos-stable --image-project=cos-cloud --no-address --tags=phi \
     --service-account=$SA --scopes=cloud-platform --shielded-secure-boot \
     --disk=name=phi-data,device-name=phi-data,mode=rw,auto-delete=no \
     --metadata-from-file=user-data=$CLOUD_INIT"

step "Load balancer backend: instance group, health check, backend service"
ensure "gcloud compute instance-groups unmanaged describe phi-group --zone=$ZONE" \
  "gcloud compute instance-groups unmanaged create phi-group --zone=$ZONE && \
   gcloud compute instance-groups unmanaged add-instances phi-group --zone=$ZONE --instances=phi"
gcloud compute instance-groups set-named-ports phi-group --zone="$ZONE" --named-ports=http:3000
ensure "gcloud compute health-checks describe phi-health --global" \
  "gcloud compute health-checks create http phi-health --global --port=3000 --request-path=/healthz"
# 3600 s: the chat stream (SSE) and the completion WebSocket stay open for long stretches.
ensure "gcloud compute backend-services describe phi-backend --global" \
  "gcloud compute backend-services create phi-backend --global --protocol=HTTP --port-name=http \
     --health-checks=phi-health --global-health-checks --timeout=3600s --load-balancing-scheme=EXTERNAL_MANAGED && \
   gcloud compute backend-services add-backend phi-backend --global \
     --instance-group=phi-group --instance-group-zone=$ZONE"

step "HTTPS front end: static IP, managed certificate for $DOMAIN, HTTP → HTTPS redirect"
ensure "gcloud compute addresses describe phi-ip --global" \
  "gcloud compute addresses create phi-ip --global"
ensure "gcloud compute ssl-certificates describe phi-cert --global" \
  "gcloud compute ssl-certificates create phi-cert --domains=$DOMAIN --global"
ensure "gcloud compute url-maps describe phi-map --global" \
  "gcloud compute url-maps create phi-map --global --default-service=phi-backend"
ensure "gcloud compute target-https-proxies describe phi-https --global" \
  "gcloud compute target-https-proxies create phi-https --global --url-map=phi-map --ssl-certificates=phi-cert --global-ssl-certificates --global-url-map"
ensure "gcloud compute forwarding-rules describe phi-https-rule --global" \
  "gcloud compute forwarding-rules create phi-https-rule --global --address=phi-ip \
     --target-https-proxy=phi-https --ports=443 --load-balancing-scheme=EXTERNAL_MANAGED"
if ! gcloud compute url-maps describe phi-redirect --global >/dev/null 2>&1; then
  gcloud compute url-maps import phi-redirect --global --quiet --source=/dev/stdin <<'YAML'
name: phi-redirect
defaultUrlRedirect:
  httpsRedirect: true
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
YAML
fi
ensure "gcloud compute target-http-proxies describe phi-http --global" \
  "gcloud compute target-http-proxies create phi-http --global --url-map=phi-redirect --global-url-map"
ensure "gcloud compute forwarding-rules describe phi-http-rule --global" \
  "gcloud compute forwarding-rules create phi-http-rule --global --address=phi-ip \
     --target-http-proxy=phi-http --ports=80 --load-balancing-scheme=EXTERNAL_MANAGED"

step "IAP: Google sign-in in front of Phi, only $EMAIL allowed"
IAP_FLAG=enabled
if [[ -n "${OAUTH_CLIENT_ID:-}" ]]; then
  IAP_FLAG="enabled,oauth2-client-id=$OAUTH_CLIENT_ID,oauth2-client-secret=$OAUTH_CLIENT_SECRET"
fi
gcloud compute backend-services update phi-backend --global --iap="$IAP_FLAG"
gcloud iap web add-iam-policy-binding --resource-type=backend-services --service=phi-backend \
  --member="user:$EMAIL" --role=roles/iap.httpsResourceAccessor >/dev/null

step "Phi's settings on the VM (instance metadata)"
NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
BACKEND=$(gcloud compute backend-services describe phi-backend --global --format='value(id)')
ENV_FILE=$(mktemp)
cat > "$ENV_FILE" <<ENV
PUBLIC_ORIGIN=https://$DOMAIN
IAP_AUDIENCE=/projects/$NUMBER/global/backendServices/$BACKEND
ALLOWED_EMAIL=$EMAIL
ENV
gcloud compute instances add-metadata phi --zone="$ZONE" --metadata-from-file=phi-env="$ENV_FILE"
rm -f "$ENV_FILE"

IP=$(gcloud compute addresses describe phi-ip --global --format='value(address)')
cat <<DONE

Setup done. Next:
  1. Create a DNS A record: $DOMAIN → $IP
     (the certificate becomes ACTIVE 15-60 minutes after the record resolves)
  2. Build and start Phi:  deploy/gcp/deploy.sh
  3. Open https://$DOMAIN and sign in as $EMAIL
DONE
