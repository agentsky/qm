#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/deploy/helm"
RELEASE="${K3S_E2E_RELEASE:-qm}"
NAMESPACE="${K3S_E2E_NAMESPACE:-qm-e2e}"
IMAGE_REPO="${K3S_E2E_IMAGE_REPO:-qm}"
IMAGE_TAG="${K3S_E2E_IMAGE_TAG:-e2e}"
PUBLIC_URL="${K3S_E2E_PUBLIC_URL:-http://qm.e2e.local}"
POSTGRES_IMAGE="${K3S_E2E_POSTGRES_IMAGE:-postgres:16-alpine}"
LOG_DIR="${K3S_E2E_LOG_DIR:-$ROOT/.k3s-e2e-logs}"
CORE_LOCAL_PORT="${K3S_E2E_CORE_PORT:-18080}"
WEB_LOCAL_PORT="${K3S_E2E_WEB_PORT:-18081}"
ROLLOUT_TIMEOUT="${K3S_E2E_ROLLOUT_TIMEOUT:-300s}"

SERVICES=(core web-ui egress-proxy)
PORT_FORWARD_PIDS=()

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  SUDO="sudo"
fi

mkdir -p "$LOG_DIR"

log() {
  printf '==> %s\n' "$*" >&2
}

fail() {
  printf 'k3s-e2e: %s\n' "$*" >&2
  exit 1
}

dump_diagnostics() {
  log "dumping diagnostics to $LOG_DIR"
  {
    echo "### kubectl get all -n $NAMESPACE"
    kubectl get all -n "$NAMESPACE" -o wide 2>&1 || true
    echo
    echo "### kubectl get events -n $NAMESPACE"
    kubectl get events -n "$NAMESPACE" --sort-by=.lastTimestamp 2>&1 || true
    echo
    echo "### kubectl describe -n $NAMESPACE"
    kubectl describe pods,deployments,services -n "$NAMESPACE" 2>&1 || true
    echo
    echo "### pod logs"
    for pod in $(kubectl get pods -n "$NAMESPACE" -o name 2>/dev/null || true); do
      echo "--- $pod (current)"
      kubectl logs -n "$NAMESPACE" "$pod" --all-containers --tail=500 2>&1 || true
      echo "--- $pod (previous)"
      kubectl logs -n "$NAMESPACE" "$pod" --all-containers --tail=200 --previous 2>&1 || true
    done
  } | tee "$LOG_DIR/diagnostics.log" >&2
}

stop_port_forwards() {
  for pid in ${PORT_FORWARD_PIDS[@]+"${PORT_FORWARD_PIDS[@]}"}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  PORT_FORWARD_PIDS=()
}

teardown() {
  if [[ "${K3S_E2E_KEEP:-0}" == "1" ]]; then
    log "K3S_E2E_KEEP=1 — leaving namespace $NAMESPACE in place"
    return
  fi
  log "tearing down namespace $NAMESPACE"
  helm uninstall "$RELEASE" --namespace "$NAMESPACE" --wait --timeout 120s >/dev/null 2>&1 || true
  kubectl delete namespace "$NAMESPACE" --ignore-not-found --timeout=180s >/dev/null 2>&1 || true
}

on_exit() {
  local status=$?
  stop_port_forwards
  if [[ $status -ne 0 ]] && command -v kubectl >/dev/null 2>&1; then
    dump_diagnostics
  fi
  if command -v helm >/dev/null 2>&1 && command -v kubectl >/dev/null 2>&1; then
    teardown
  fi
  exit "$status"
}
trap on_exit EXIT

cluster_reachable() {
  command -v kubectl >/dev/null 2>&1 && kubectl cluster-info >/dev/null 2>&1
}

adopt_k3s_kubeconfig() {
  [[ -f /etc/rancher/k3s/k3s.yaml ]] || return 1
  $SUDO chmod 644 /etc/rancher/k3s/k3s.yaml
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  cluster_reachable
}

ensure_cluster() {
  if cluster_reachable; then
    log "using the cluster kubectl already reaches"
  elif adopt_k3s_kubeconfig; then
    log "adopted the existing k3s kubeconfig"
  else
    log "installing k3s"
    curl -sfL https://get.k3s.io | $SUDO sh -s - --disable traefik ||
      fail "could not fetch or run the k3s installer from https://get.k3s.io"
    adopt_k3s_kubeconfig || fail "k3s installed but kubectl cannot reach the cluster"
  fi
  kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
  command -v k3s >/dev/null 2>&1 || fail "k3s is required to import locally built images into containerd"
}

ensure_helm() {
  if command -v helm >/dev/null 2>&1; then
    log "helm already installed"
    return
  fi
  log "installing helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  command -v helm >/dev/null 2>&1 || fail "helm install did not put helm on PATH"
}

import_image() {
  local image="$1"
  log "importing $image into k3s containerd"
  docker save "$image" | $SUDO k3s ctr images import -
}

build_images() {
  for svc in "${SERVICES[@]}"; do
    local image="$IMAGE_REPO/$svc:$IMAGE_TAG"
    log "building $image from deploy/$svc/Dockerfile"
    docker build --build-arg GIT_SHA="$IMAGE_TAG" -t "$image" -f "$ROOT/deploy/$svc/Dockerfile" "$ROOT"
    import_image "$image"
  done
  log "pulling $POSTGRES_IMAGE"
  docker pull "$POSTGRES_IMAGE"
  import_image "$POSTGRES_IMAGE"
}

deploy_postgres() {
  log "deploying postgres into $NAMESPACE"
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl apply -n "$NAMESPACE" -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
        - name: postgres
          image: $POSTGRES_IMAGE
          imagePullPolicy: IfNotPresent
          env:
            - name: POSTGRES_PASSWORD
              value: postgres
            - name: POSTGRES_DB
              value: qm
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres", "-d", "qm"]
            initialDelaySeconds: 5
            periodSeconds: 5
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
      volumes:
        - name: data
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector:
    app: postgres
  ports:
    - name: postgres
      port: 5432
      targetPort: 5432
YAML
  kubectl rollout status -n "$NAMESPACE" deployment/postgres --timeout="$ROLLOUT_TIMEOUT"
}

secret() {
  openssl rand -hex 24
}

deploy_chart() {
  CORE_SIGNING_SECRET="$(secret)"
  local capability_secret portal_identity_secret connector_secret_key skill_signing_secret
  capability_secret="$(secret)"
  portal_identity_secret="$(secret)"
  connector_secret_key="$(secret)"
  skill_signing_secret="$(secret)"

  log "installing the chart as $RELEASE in $NAMESPACE"
  helm upgrade --install "$RELEASE" "$CHART" \
    --namespace "$NAMESPACE" --create-namespace \
    --set image.repository="$IMAGE_REPO" \
    --set image.tag="$IMAGE_TAG" \
    --set image.pullPolicy=Never \
    --set services.admin.enabled=true \
    --set publicUrl="$PUBLIC_URL" \
    --set secretEnv.DATABASE_URL="postgres://postgres:postgres@postgres.$NAMESPACE.svc.cluster.local:5432/qm" \
    --set secretEnv.CORE_SIGNING_SECRET="$CORE_SIGNING_SECRET" \
    --set secretEnv.CAPABILITY_SECRET="$capability_secret" \
    --set secretEnv.PORTAL_IDENTITY_SECRET="$portal_identity_secret" \
    --set secretEnv.CONNECTOR_SECRET_KEY="$connector_secret_key" \
    --set secretEnv.SKILL_SIGNING_SECRET="$skill_signing_secret" \
    --set secretEnv.SANDBOX_BACKEND=local \
    --set secretEnv.ADMIN_GRANTS="e2e@example.com:org_admin" \
    --set env.HARNESS=mock \
    --set env.NODE_ENV=production \
    --set env.DEPLOY_PROVIDER=docker \
    --wait=false
}

wait_rollouts() {
  local deployments
  deployments="$(kubectl get deployments -n "$NAMESPACE" -o name)"
  [[ -n "$deployments" ]] || fail "the chart rendered no deployments"
  for deployment in $deployments; do
    log "waiting for $deployment"
    kubectl rollout status -n "$NAMESPACE" "$deployment" --timeout="$ROLLOUT_TIMEOUT"
  done
}

service_for() {
  local name
  name="$(kubectl get svc -n "$NAMESPACE" -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$1" -o name)"
  [[ -n "$name" ]] || fail "the chart rendered no $1 service"
  printf '%s' "$name"
}

start_port_forward() {
  local target="$1" local_port="$2" remote_port="$3"
  kubectl port-forward -n "$NAMESPACE" --address 127.0.0.1 "$target" "$local_port:$remote_port" \
    >>"$LOG_DIR/port-forward.log" 2>&1 &
  PORT_FORWARD_PIDS+=($!)
  for _ in $(seq 1 60); do
    if curl -sS -o /dev/null "http://127.0.0.1:$local_port/healthz" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  fail "port-forward to $target never accepted a request"
}

expect_status() {
  local url="$1" want="$2" got
  got="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
  [[ "$got" == "$want" ]] || fail "GET $url returned $got, expected $want"
  log "GET $url -> $got"
}

signed_turn() {
  local base="$1" path="/v1/turns" body timestamp canonical signature response
  body='{"surface":"k3s-e2e","actor":{"externalId":"e2e-user"},"conversation":{"kind":"dm","threadRef":"k3s-e2e"},"text":"k3s e2e ping"}'
  timestamp="$(date +%s)"
  canonical="$(printf 'POST\n%s\n%s' "$path" "$body")"
  signature="v0=$(printf 'v0:%s:%s' "$timestamp" "$canonical" | openssl dgst -sha256 -hmac "$CORE_SIGNING_SECRET" -r | cut -d' ' -f1)"
  response="$(curl -sS -X POST "$base$path" \
    -H 'content-type: application/json' \
    -H "x-timestamp: $timestamp" \
    -H "x-signature: $signature" \
    --data-binary "$body")"
  printf '%s\n' "$response" >"$LOG_DIR/turn.log"
  grep -q 'You said: k3s e2e ping' <<<"$response" || fail "mock turn did not round-trip: $response"
  log "mock turn round-tripped through POST $path"
}

verify() {
  start_port_forward "$(service_for core)" "$CORE_LOCAL_PORT" 8080
  expect_status "http://127.0.0.1:$CORE_LOCAL_PORT/healthz" 200
  signed_turn "http://127.0.0.1:$CORE_LOCAL_PORT"

  start_port_forward "$(service_for web-ui)" "$WEB_LOCAL_PORT" 8080
  expect_status "http://127.0.0.1:$WEB_LOCAL_PORT/healthz" 200
  expect_status "http://127.0.0.1:$WEB_LOCAL_PORT/admin/" 200
}

command -v docker >/dev/null 2>&1 || fail "docker is required to build the images the chart runs"
command -v openssl >/dev/null 2>&1 || fail "openssl is required to mint e2e secrets"
command -v curl >/dev/null 2>&1 || fail "curl is required"

ensure_cluster
ensure_helm
build_images
deploy_postgres
deploy_chart
wait_rollouts
verify
stop_port_forwards

log "k3s e2e passed"
