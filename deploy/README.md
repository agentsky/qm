# Deployment

`deploy/<service>/Dockerfile` builds the service images the Helm chart runs: `core`,
`web-ui`, `admin`, `portal`, `auth`, and `egress-proxy`. The release workflow
[`.github/workflows/release-package.yml`](../.github/workflows/release-package.yml) builds
and cosign-signs each one into `ghcr.io/yc-software/qm`;
[`scripts/deploy-helm.sh`](../scripts/deploy-helm.sh) builds and pushes the same set to
your own registry and then installs the chart.

[`sandbox-base/`](./sandbox-base/) and [`sandbox-local/`](./sandbox-local/) build the agent
computer images: the shared base toolset, and the local Docker sandbox stacked on top of
it for `SANDBOX_BACKEND=local`. See [`sandbox-base/README.md`](./sandbox-base/README.md).

[`helm/`](./helm/) is the chart itself. [`docs/getting-started.md`](../docs/getting-started.md)
covers the prerequisites and the values you must set.

Nothing here is a production deployment, and none of it contains cloud account,
workspace, or organization credentials. The one exception is [`layers/`](./layers/), which
is empty in qm itself: a private fork keeps its organization's values file and deployment
material there, and that material never travels back upstream.

## Topology

The public portal is the only Internet-facing service. It authenticates users
over OIDC and proxies the private Web UI and admin surfaces. Core, Postgres, and
agent computers stay private. The optional Slack surface runs inside core over
outbound Socket Mode.

By default the OIDC provider is the `auth` service qm deploys for itself: a
sign-in broker that emails a one-time link. It is private like every other
non-portal service — the portal republishes only its two browser-facing routes
under `/idp/`, so the issuer and the sign-in pages live on the portal's own
origin while the token, userinfo, and JWKS calls stay on the private network.
The self-hoster supplies an admin address, a verified sender, and a Resend key
or SMTP credentials. Core receives the same `RESEND_API_KEY`
and `AUTH_EMAIL_FROM`, which let admins email invitations to external users from
the admin Users tab or by chatting with QM; both are optional on core, and
without them the invitation is still created and the sign-in link is shared by
hand. Disabling the `auth` service hands
sign-in back to an external identity provider, which then has to register the
exact `<publicUrl>/auth/callback` redirect.

Connector OAuth clients and the optional Slack bot token pair are entered at
the authenticated admin connector URL. Secrets are
encrypted in durable storage and are never committed to a values file.
The agent advertises only connectors whose admin configuration is enabled.
