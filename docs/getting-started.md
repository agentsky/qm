# Deploy QM for an organization

QM runs on Kubernetes. The chart in [`deploy/helm/`](../deploy/helm) deploys core and the
surface services (web UI, admin, portal, the optional `auth` sign-in broker, and the
egress proxy) from one values file.

## Prerequisites

- A Kubernetes cluster and `kubectl` context you can deploy into, plus Helm 3.
- A Postgres database reachable from the cluster. Core keeps every durable store there;
  supply its URL as `secretEnv.DATABASE_URL`.
- Service images. Either use the signed images the release workflow publishes to
  `ghcr.io/yc-software/qm` (`image.repository` and `image.tag`), or build and push your
  own from this checkout with [`scripts/deploy-helm.sh`](../scripts/deploy-helm.sh).
- Optional: an ingress controller and cert-manager, if you want the chart to publish the
  portal on a hostname with TLS. Without them, reach the portal by port-forward.
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

Sign-in defaults to the built-in `auth` broker, which emails a one-time link: set
`AUTH_EMAIL_FROM` to a verified sender and supply `RESEND_API_KEY`. Disable the `auth`
service to use an external identity provider instead; that provider must register the
exact `<publicUrl>/auth/callback` redirect.

Connector OAuth clients and the optional Slack bot token pair are entered in the admin
surface once the portal is up. They are encrypted in durable storage and never belong in
a values file.

The QM repository has no production deployment workflow: each deployment runs in the
operator's own cluster. Keep your values file and any org-specific tools, skills, and
images in `deploy/layers/<org>/` in a private source fork, or in a separate private
repository — see [`deploy/layers/README.md`](../deploy/layers/README.md).
