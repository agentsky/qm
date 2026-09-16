# Deploy QM for an organization

QM runs on Kubernetes. The chart in [`deploy/helm/`](../deploy/helm) deploys core, which
hosts the Slack integration and the HTTP API, and the egress proxy, from one values file.

## Prerequisites

- A Kubernetes cluster and `kubectl` context you can deploy into, plus Helm 3.
- A Postgres database reachable from the cluster. Core keeps every durable store there;
  supply its URL as `secretEnv.DATABASE_URL`.
- Service images. Either use the signed images the release workflow publishes to
  `ghcr.io/yc-software/qm` (`image.repository` and `image.tag`), or build and push your
  own from this checkout with [`scripts/deploy-helm.sh`](../scripts/deploy-helm.sh).
- Optional: an ingress controller and cert-manager, if you want core published on a
  hostname with TLS. An ingress is what lets Slack reach core over HTTP, what webhook
  senders post to, and what serves published apps. Slack's Socket Mode does not need one;
  without an ingress, reach core by port-forward.
- A sandbox backend. `SANDBOX_BACKEND=local` runs agent computers as Docker containers
  next to core; the hosted backends (e2b, modal, smolmachines, agent37) need their own
  API key. See [`deploy/sandbox-base/README.md`](../deploy/sandbox-base/README.md).

## Deploy

Write a values file with your own secrets — never commit it:

```yaml
image:
  repository: ghcr.io/yc-software/qm
  tag: <release-sha>

publicUrl: https://qm.example.com

ingress:
  enabled: true
  hosts: [qm.example.com]
  className: nginx
  clusterIssuer: letsencrypt-prod

secretEnv:
  DATABASE_URL: postgres://...
  ANTHROPIC_API_KEY: sk-ant-...
  CORE_SIGNING_SECRET: <random 32+ bytes>
  CAPABILITY_SECRET: <random 32+ bytes>
  PORTAL_IDENTITY_SECRET: <random 32+ bytes>
  CONNECTOR_SECRET_KEY: <random 32+ bytes>
  SKILL_SIGNING_SECRET: <random 32+ bytes>
  ADMIN_GRANTS: you@example.com
  SANDBOX_BACKEND: local
```

Then install or upgrade:

```bash
helm upgrade --install qm deploy/helm \
  --namespace qm --create-namespace \
  -f my-values.yaml
```

[`deploy/helm/values.yaml`](../deploy/helm/values.yaml) lists every key, including the
per-service `services.<name>` blocks that control replicas, resources, and whether a
service is enabled at all. Secrets are scoped per service — see
[`docs/helm-per-service-secrets.md`](./helm-per-service-secrets.md).

## After the first install

The chart exposes `core` on the ingress and ships no identity provider. Core establishes
a browser-borne caller from a signed `x-portal-identity` header it verifies with
`PORTAL_IDENTITY_SECRET`, so signing anyone in requires putting something in front of core
that authenticates the user and mints that header. Until you do, core cannot sign anyone
in.

`AUTH_ALLOWED_EMAILS` still says who may be invited, and `AUTH_EMAIL_FROM` with
`RESEND_API_KEY` lets admins email those invitations; neither authenticates anyone.

Connector OAuth clients and the optional Slack bot token pair are set through core's
authenticated admin API. They are encrypted in durable storage and never belong in a
values file.

The QM repository has no production deployment workflow: each deployment runs in the
operator's own cluster. Keep your values file and any org-specific tools, skills, and
images in `deploy/layers/<org>/` in a private source fork, or in a separate private
repository — see [`deploy/layers/README.md`](../deploy/layers/README.md).
