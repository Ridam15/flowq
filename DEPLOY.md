# FlowQ — Deployment guide (GCP / GKE)

End-to-end walkthrough for going from a clean GCP project to a running
FlowQ stack on GKE, with Prometheus + Grafana + custom-metric autoscaling
and a CI/CD pipeline that rebuilds and rolls out on every push to `main`.

---

## 0. What you're building

```
                    ┌────────────────────────────────────────────────────────┐
                    │                  GKE cluster (flowq-prod ns)           │
   user / browser ──┼─► Ingress ─► flowq-dashboard ─► (config.js → API URL) │
                    │                                                        │
   producers ───────┼─► Ingress ─► flowq-api  ─┐                            │
                    │                          │                            │
                    │   ┌──────────────────────┴──────────┐                 │
                    │   │  Redis (StatefulSet or          │                 │
                    │   │  Memorystore — both supported)  │                 │
                    │   └──────────────────────┬──────────┘                 │
                    │                          ▼                            │
                    │              flowq-worker (Deployment, HPA 2-10)      │
                    │                          │                            │
                    │   ┌──────────────────────┴──────────┐                 │
                    │   │  Postgres (StatefulSet or       │                 │
                    │   │  Cloud SQL — both supported)    │                 │
                    │   └─────────────────────────────────┘                 │
                    │                                                        │
                    │   ServiceMonitor → Prometheus → Grafana                │
                    │   Prometheus Adapter → external.metrics.k8s.io         │
                    │     (powers worker HPA on flowq_queue_depth)           │
                    └────────────────────────────────────────────────────────┘
```

You'll need:
- `gcloud` ≥ 470, `kubectl` ≥ 1.28, `helm` ≥ 3.14
- A GitHub repo with Actions enabled
- A GCP project with billing enabled

---

## 1. Bootstrap GCP

```bash
export GCP_PROJECT_ID=my-flowq-prod
export GCP_REGION=us-central1
export CLUSTER_NAME=flowq-prod

# Set the active project + default region
gcloud config set project "$GCP_PROJECT_ID"
gcloud config set compute/region "$GCP_REGION"
```

Enable the APIs we need:

```bash
gcloud services enable \
    container.googleapis.com \
    artifactregistry.googleapis.com \
    iamcredentials.googleapis.com \
    iam.googleapis.com \
    sts.googleapis.com \
    compute.googleapis.com
```

(Optional, recommended) create the Artifact Registry that will replace
GCR's `gcr.io` host:

```bash
gcloud artifacts repositories create flowq \
    --repository-format=docker \
    --location="$GCP_REGION" \
    --description="FlowQ container images"

# Use this hostname in CI:
echo "${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/flowq"
```

---

## 2. Provision a GKE cluster

A regional autopilot cluster is the lowest-friction option:

```bash
gcloud container clusters create-auto "$CLUSTER_NAME" \
    --region "$GCP_REGION" \
    --release-channel=regular
```

If you'd rather drive a standard cluster with explicit node pools:

```bash
gcloud container clusters create "$CLUSTER_NAME" \
    --region "$GCP_REGION" \
    --release-channel=regular \
    --num-nodes=2 \
    --machine-type=e2-standard-4 \
    --enable-ip-alias \
    --workload-pool="${GCP_PROJECT_ID}.svc.id.goog" \
    --addons=HorizontalPodAutoscaling,HttpLoadBalancing
```

Wire your local `kubectl` to it:

```bash
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$GCP_REGION"
kubectl get nodes
```

---

## 3. Set up Workload Identity Federation for GitHub Actions

This is the modern, key-less way for the CI to talk to GCP. Replace
`YOUR_GH_ORG/your-repo` with the repo this code lives in.

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')

# 1. Create the service account that CI will impersonate
gcloud iam service-accounts create flowq-deployer \
    --display-name="FlowQ CI deployer"
export DEPLOY_SA="flowq-deployer@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

# Grant just the roles it needs
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/container.developer"
gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
    --member="serviceAccount:${DEPLOY_SA}" \
    --role="roles/artifactregistry.writer"

# 2. Workload identity pool + provider
gcloud iam workload-identity-pools create github-pool \
    --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-provider \
    --location=global \
    --workload-identity-pool=github-pool \
    --display-name="GitHub OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='YOUR_GH_ORG/your-repo'"

# 3. Allow the GitHub repo to impersonate the service account
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-pool/attribute.repository/YOUR_GH_ORG/your-repo"
```

---

## 4. Configure GitHub Actions

In the GitHub repo, go to **Settings → Secrets and variables → Actions →
Variables** and add:

| Variable           | Example value                                                    |
| ------------------ | ---------------------------------------------------------------- |
| `GCP_PROJECT_ID`   | `my-flowq-prod`                                                  |
| `GCP_PROJECT_NUMBER` | (the number you exported above)                                |
| `GCP_REGION`       | `us-central1`                                                    |
| `GKE_CLUSTER`      | `flowq-prod`                                                     |
| `GKE_LOCATION`     | `us-central1`                                                    |
| `WIF_POOL`         | `github-pool`                                                    |
| `WIF_PROVIDER`     | `github-provider`                                                |
| `DEPLOY_SA`        | `flowq-deployer@my-flowq-prod.iam.gserviceaccount.com`           |
| `GAR_HOSTNAME`     | `us-central1-docker.pkg.dev` (or `gcr.io` if you skipped step 1) |
| `HELM_RELEASE`     | `flowq`                                                          |
| `HELM_NAMESPACE`   | `flowq-prod`                                                     |
| `HELM_VALUES_FILE` | `infra/helm/flowq/values-prod.example.yaml`                      |

The first push to `main` after this will:
1. Run the test suite.
2. Build and push three images: `flowq-api`, `flowq-worker`, `flowq-dashboard`.
3. `helm upgrade --install` against your GKE cluster.

---

## 5. Bootstrap secrets in the cluster

For a quick start (NOT for prod), you can let the chart create the
Secret with literal values:

```bash
helm install flowq ./infra/helm/flowq \
    --namespace flowq-prod --create-namespace \
    --set secrets.create=true \
    --set secrets.apiKey="$(openssl rand -hex 32)" \
    --set secrets.postgresPassword="$(openssl rand -hex 16)"
```

For production, manage the Secret out-of-band — the cleanest path on GKE
is the **Secrets Store CSI driver** pointed at GCP Secret Manager:

```bash
# 1. Install the CSI driver + GCP provider
gcloud container clusters update "$CLUSTER_NAME" --region "$GCP_REGION" \
    --update-addons=ConfigConnector=DISABLED \
    --update-addons=GcpFilestoreCsiDriver=DISABLED   # noop, just here to show the pattern

helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm install csi secrets-store-csi-driver/secrets-store-csi-driver \
    --namespace kube-system --set syncSecret.enabled=true

kubectl apply -f https://raw.githubusercontent.com/GoogleCloudPlatform/secrets-store-csi-driver-provider-gcp/main/deploy/provider-gcp-plugin.yaml

# 2. Stash secrets in GSM
echo -n "$(openssl rand -hex 32)" | gcloud secrets create flowq-api-key --data-file=-
echo -n "$(openssl rand -hex 16)" | gcloud secrets create flowq-pg-password --data-file=-

# 3. Create a SecretProviderClass (sample at:
#    https://secrets-store-csi-driver.sigs.k8s.io/) that mirrors GSM keys
#    into a k8s Secret named `flowq-secrets` with keys API_KEY and POSTGRES_PASSWORD.

# 4. In your values file, point the chart at it:
#    secrets:
#      create: false
#      name: flowq-secrets
```

---

## 6. Install monitoring (Prometheus + Grafana + Adapter)

```bash
# Base stack — Prometheus operator, kube-state-metrics, Grafana
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm upgrade --install kube-prom prometheus-community/kube-prometheus-stack \
    --namespace monitoring --create-namespace \
    -f infra/k8s/monitoring-values.yaml

# Adapter that feeds flowq_queue_depth to the HPA
helm upgrade --install prom-adapter prometheus-community/prometheus-adapter \
    --namespace monitoring \
    -f infra/k8s/prometheus-adapter-values.yaml

# Sanity check — should list flowq_queue_depth
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | jq .
```

Import the FlowQ dashboard into Grafana:

```bash
kubectl create configmap flowq-grafana-dashboard \
    --namespace monitoring \
    --from-file=flowq.json=infra/grafana/dashboard.json \
    --dry-run=client -o yaml | \
  kubectl label --local -f - grafana_dashboard=1 -o yaml --dry-run=client | \
  kubectl apply -f -
```

The Grafana sidecar picks the new ConfigMap up within ~30s. Reach the UI:

```bash
kubectl -n monitoring port-forward svc/kube-prom-grafana 3001:80
# open http://localhost:3001  (admin / change-me-please)
```

---

## 7. Deploy FlowQ

If you skipped CI and just want to apply manually:

```bash
helm upgrade --install flowq ./infra/helm/flowq \
    --namespace flowq-prod --create-namespace \
    --set image.registry="${GAR_HOSTNAME}/${GCP_PROJECT_ID}" \
    --set image.tag="$(git rev-parse --short HEAD)"
```

Wait for the rollout to complete, then ask the API for liveness:

```bash
kubectl -n flowq-prod port-forward svc/flowq-api 3000:3000 &
curl -s http://localhost:3000/health | jq .
```

You should see `{"status":"ok","redis":"ok","postgres":"ok",...}`.

---

## 8. DNS + TLS

The default chart ships an Ingress without a static IP or managed cert
(so it works out of the box on any cluster). For real traffic:

```bash
# 1. Reserve global static IPs
gcloud compute addresses create flowq-api       --global
gcloud compute addresses create flowq-dashboard --global

# 2. Point your DNS A records at the addresses
gcloud compute addresses describe flowq-api       --global --format='value(address)'
gcloud compute addresses describe flowq-dashboard --global --format='value(address)'

# 3. Create managed certificates
cat <<EOF | kubectl apply -f -
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: flowq-api-cert
  namespace: flowq-prod
spec:
  domains: [api.flowq.example.com]
---
apiVersion: networking.gke.io/v1
kind: ManagedCertificate
metadata:
  name: flowq-dashboard-cert
  namespace: flowq-prod
spec:
  domains: [flowq.example.com]
EOF

# 4. Re-deploy with the IP/cert annotations
helm upgrade flowq ./infra/helm/flowq \
    --namespace flowq-prod -f infra/helm/flowq/values-prod.example.yaml
```

Cert provisioning takes 10-30 minutes; track it with
`kubectl -n flowq-prod describe managedcertificate flowq-api-cert`.

---

## 9. Day-2 operations

```bash
# Roll out a new version manually
helm upgrade flowq ./infra/helm/flowq -n flowq-prod \
    --set api.image.tag=NEW-SHA --set worker.image.tag=NEW-SHA --set dashboard.image.tag=NEW-SHA

# Roll back to the previous release
helm rollback flowq -n flowq-prod

# Tail logs
kubectl -n flowq-prod logs -f deploy/flowq-api
kubectl -n flowq-prod logs -f deploy/flowq-worker

# Scale workers manually (HPA will fight you within 5 min)
kubectl -n flowq-prod scale deploy/flowq-worker --replicas=5

# Inspect HPA decisions
kubectl -n flowq-prod describe hpa flowq-worker
```

---

## 10. Tear down

```bash
helm uninstall flowq -n flowq-prod
kubectl -n flowq-prod delete pvc -l app.kubernetes.io/instance=flowq
helm uninstall kube-prom prom-adapter -n monitoring
gcloud container clusters delete "$CLUSTER_NAME" --region "$GCP_REGION"
```

---

## Troubleshooting

- **HPA stuck at `<unknown>/100`** — Prometheus Adapter doesn't know about
  the metric yet. Either no API pod has been scraped (check
  `kubectl -n monitoring logs deploy/kube-prom-prometheus-operator`)
  or the rule in `prometheus-adapter-values.yaml` doesn't match. Verify
  with `kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/flowq-prod/flowq_queue_depth" | jq .`.

- **Ingress shows `503` for several minutes after install** — the GCE
  Load Balancer needs to register backends. Watch
  `kubectl -n flowq-prod describe ingress flowq-api`. Once
  `backend services` show `HEALTHY`, traffic flows.

- **API pod CrashLoopBackoff with `ECONNREFUSED postgres:5432`** — Postgres
  StatefulSet is still initialising on first install. Give it 90s. If it
  persists, `kubectl -n flowq-prod logs sts/flowq-postgres` will tell you
  what's wrong (most often a PVC binding issue on a cluster without a
  default StorageClass).

- **Dashboard loads but every API call fails with 401** — `FLOWQ_API_KEY`
  in the dashboard pod doesn't match `API_KEY` in the API pod. Both come
  from the same Secret in the chart, but if you swapped to externally-
  managed secrets you need both to read the SAME key.
