# `flowq` Helm chart

Single chart that installs the FlowQ control plane (API + workers +
dashboard) and, optionally, in-cluster Redis and Postgres.

## Quick install

```bash
# create namespace + install with default values (in-cluster deps,
# dev API key, the works)
helm upgrade --install flowq ./infra/helm/flowq \
    --namespace flowq-prod --create-namespace \
    --set image.registry=gcr.io/my-project \
    --set image.tag=$(git rev-parse --short HEAD)
```

## Production install

Use `values-prod.example.yaml` as a template:

```bash
cp infra/helm/flowq/values-prod.example.yaml my-values.yaml
# edit my-values.yaml to point at Memorystore + Cloud SQL,
# pre-create the Secret via External Secrets, etc.

helm upgrade --install flowq ./infra/helm/flowq \
    --namespace flowq-prod --create-namespace \
    -f my-values.yaml
```

## Values

The full reference lives in [`values.yaml`](./values.yaml). The most
commonly overridden ones:

| Value                                | Default                          | Purpose                                      |
| ------------------------------------ | -------------------------------- | -------------------------------------------- |
| `image.registry`                     | `gcr.io/PROJECT_ID`              | Image registry shared by all FlowQ services  |
| `image.tag`                          | `""` → `Chart.AppVersion`        | Per-image tag override                       |
| `secrets.apiKey`                     | `dev-api-key-change-me`          | API_KEY (Bearer token)                       |
| `secrets.create`                     | `true`                           | Set false to manage secret externally        |
| `redis.enabled` / `postgres.enabled` | `true` / `true`                  | Disable to use Memorystore / Cloud SQL       |
| `api.ingress.host`                   | `api.flowq.example.com`          | Public hostname for the API                  |
| `dashboard.ingress.host`             | `flowq.example.com`              | Public hostname for the dashboard            |
| `dashboard.apiUrl`                   | `https://api.flowq.example.com`  | URL the BROWSER calls (NOT cluster-internal) |
| `worker.hpa.minReplicas` / `max`     | `2` / `10`                       | HPA bounds                                   |
| `worker.hpa.targetAverageValue`      | `100`                            | Target queue depth per worker pod            |

## What gets created

Every chart install produces:

```
namespace/{flowq-prod}                                       (optional)
configmap/{release}-config
secret/{release}-secrets                                     (optional)
service/{release}-redis,    statefulset/{release}-redis      (optional)
service/{release}-postgres, statefulset/{release}-postgres   (optional)
service/{release}-api,       deployment/{release}-api,       ingress/{release}-api
deployment/{release}-worker, hpa/{release}-worker
service/{release}-dashboard, deployment/{release}-dashboard, ingress/{release}-dashboard
servicemonitor/{release}-api                                 (optional)
```

## Uninstall

```bash
helm uninstall flowq -n flowq-prod
# PVCs created by the StatefulSets are NOT deleted by Helm — drop them
# explicitly if you want to wipe state:
kubectl -n flowq-prod delete pvc -l app.kubernetes.io/instance=flowq
```

## Validate before applying

```bash
helm lint ./infra/helm/flowq
helm template flowq ./infra/helm/flowq -f my-values.yaml > /tmp/flowq.yaml
kubectl apply --dry-run=client -f /tmp/flowq.yaml
```
