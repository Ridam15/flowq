{{/*
Expand the name of the chart.
*/}}
{{- define "flowq.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name.
*/}}
{{- define "flowq.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Chart label.
*/}}
{{- define "flowq.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every resource.
*/}}
{{- define "flowq.labels" -}}
helm.sh/chart: {{ include "flowq.chart" . }}
app.kubernetes.io/name: {{ include "flowq.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: flowq
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels for a sub-component (api / worker / dashboard / redis / postgres).
Usage: {{ include "flowq.selectorLabels" (dict "context" $ "component" "api") }}
*/}}
{{- define "flowq.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flowq.name" .context }}
app.kubernetes.io/instance: {{ .context.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Component labels = common + selector labels.
*/}}
{{- define "flowq.componentLabels" -}}
{{ include "flowq.labels" .context }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Resolve `<registry>/<repository>:<tag>` for a service. Falls back through
service-level → chart-level → appVersion for the tag, and through
service-level → chart-level for pullPolicy.

Usage:
  image: {{ include "flowq.image" (dict "context" $ "svc" .Values.api) }}
*/}}
{{- define "flowq.image" -}}
{{- $registry := .context.Values.image.registry -}}
{{- $repo := .svc.image.repository -}}
{{- $tag := default (default .context.Chart.AppVersion .context.Values.image.tag) .svc.image.tag -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry $repo $tag -}}
{{- else -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}
{{- end -}}

{{- define "flowq.imagePullPolicy" -}}
{{- default .context.Values.image.pullPolicy .svc.image.pullPolicy -}}
{{- end -}}

{{/*
Resolved Redis host. If `redis.enabled` is true we point at the in-cluster
service; otherwise we use the user-supplied `redis.host`.
*/}}
{{- define "flowq.redisHost" -}}
{{- if .Values.redis.enabled -}}
{{ printf "%s-redis" (include "flowq.fullname" .) }}
{{- else -}}
{{ required "redis.host is required when redis.enabled=false" .Values.redis.host }}
{{- end -}}
{{- end -}}

{{- define "flowq.postgresHost" -}}
{{- if .Values.postgres.enabled -}}
{{ printf "%s-postgres" (include "flowq.fullname" .) }}
{{- else -}}
{{ required "postgres.host is required when postgres.enabled=false" .Values.postgres.host }}
{{- end -}}
{{- end -}}

{{/*
Secret name (chart-managed or external).
*/}}
{{- define "flowq.secretName" -}}
{{- default (printf "%s-secrets" (include "flowq.fullname" .)) .Values.secrets.name -}}
{{- end -}}

{{/*
ConfigMap name.
*/}}
{{- define "flowq.configMapName" -}}
{{ printf "%s-config" (include "flowq.fullname" .) }}
{{- end -}}
