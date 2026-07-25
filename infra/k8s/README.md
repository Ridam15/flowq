# FlowQ — raw Kubernetes manifests

Plain `kubectl apply -f` manifests, useful for a fresh GKE cluster or a
local kind/minikube. For a real deployment you'll want the
[Helm chart](../helm/flowq/README.md) instead.

## Apply order

```bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
cp secret.example.yaml secret.yaml   # then edit, base64-encode real values
kubectl apply -f secret.yaml
kubectl apply -f redis.yaml
kubectl apply -f postgres.yaml
kubectl apply -f api.yaml
kubectl apply -f worker.yaml
kubectl apply -f dashboard.yaml
```

## Image tags

All Deployments reference `gcr.io/PROJECT_ID/flowq-{api,worker,dashboard}:latest`.
Replace `PROJECT_ID` with your GCP project ID before applying:

```bash
sed -i '' 's|PROJECT_ID|my-project-123|g' api.yaml worker.yaml dashboard.yaml
```

## Monitoring

`monitoring.yaml` ships only the FlowQ-specific bits (ServiceMonitor +
adapter rule). The base Prometheus stack is installed via Helm — see
[DEPLOY.md](../../DEPLOY.md).

## Files

| File                                | What it creates                             |
| ----------------------------------- | ------------------------------------------- |
| `namespace.yaml`                    | `flowq-prod` namespace                      |
| `configmap.yaml`                    | Non-secret env (Redis/Postgres host, ports) |
| `secret.example.yaml`               | Template for `secret.yaml` (gitignored)     |
| `redis.yaml`                        | Redis StatefulSet + headless Service        |
| `postgres.yaml`                     | Postgres StatefulSet + headless Service     |
| `api.yaml`                          | API Deployment + Service + Ingress          |
| `worker.yaml`                       | Worker Deployment + custom-metric HPA       |
| `dashboard.yaml`                    | Dashboard Deployment + Service + Ingress    |
| `monitoring.yaml`                   | FlowQ ServiceMonitor                        |
| `monitoring-values.yaml`            | Helm values for `kube-prometheus-stack`     |
| `prometheus-adapter-values.yaml`    | Helm values for `prometheus-adapter`        |
