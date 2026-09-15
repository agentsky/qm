# Organization layers

A private source fork can keep its deployment material under `deploy/layers/<org>/`.
Core code may change independently to implement the organization's desired behavior.
Public source checkouts keep private deployment material in a separate private
repository. See [the README](../../README.md#customize-your-instance) for both paths.

Upstream qm keeps only this shared README here. Organization layers never travel
upstream; `upstream-pr` checks that boundary when a contribution is requested.

## Creating a layer

A layer is a Helm values overlay plus whatever org-specific material the chart and the
agent need:

```text
deploy/layers/<org>/
  values.yaml              the Helm values overlay; committed, no secret values
  .gitignore               keeps .env and any rendered secret values out of Git
  secrets.env              local secret values; never committed
  sandbox/                 org tools and skills for agent computers
  plugins/<name>/          org-specific service images
```

Keep `values.yaml` free of secret values: put the non-secret shape there (image
repository and tag, `publicUrl`, ingress hosts, per-service replicas and resources) and
supply `secretEnv` from your cluster's secret store or a gitignored local file at install
time.

Deploy a layer by passing it to Helm after the chart's own defaults:

```bash
helm upgrade --install qm deploy/helm --namespace qm \
  -f deploy/layers/<org>/values.yaml
```

For a separate deployment repository, substitute its path. To deploy images built from
this checkout rather than the published release, run
[`scripts/deploy-helm.sh`](../../scripts/deploy-helm.sh) with your registry prefix first.

## Nearby directories

`deploy/<service>/` holds the service image builds and `deploy/helm/` the chart itself.
Neither is a place for organization material.

## The rule

Nothing under `deploy/layers/` may reach upstream qm: not the values, not the sandbox
tools, not the infrastructure coordinates, and not the names of systems or people that
appear inside them. Secrets never enter Git at all, in this directory or any other. They
belong in the cluster's encrypted secret store, with local values only in a gitignored
file.
