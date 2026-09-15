# One Secret per workload in the Helm chart

We run qm on Kubernetes through `deploy/helm/` and noticed that every pod gets every secret. The chart renders `values.yaml` `secretEnv` into a single `Secret` and attaches it with an unconditional `envFrom` to each Deployment, so the Internet-facing portal pod holds `ANTHROPIC_API_KEY`, `DATABASE_URL`, `CONNECTOR_SECRET_KEY`, `SKILL_SIGNING_SECRET`, `CAPABILITY_SECRET`, and the Admin-role `PORTER_DEPLOY_API_TOKEN`, none of which it reads. The web-ui pod reads two of the 29 values and holds all of them. A portal compromise is a database, model-billing, and Porter-project compromise in one step.

The routing already exists everywhere else. The CLI's secret specs name the service each secret belongs to and `secretsForService` decides what each ECS task definition receives; `docs/porter.md` hand-copies the same table for `porter apply --secrets`. The chart ignores both, and the CLI has no Kubernetes target that could feed it.

What we propose

Keep `secretEnv` exactly as it is, one flat map of values, and add a list of key names per declared service under `services.<name>.secrets`, with defaults that encode who reads what. The chart renders one `Secret` per Deployment named `<release>-<service>-env`, holding the union of the host's list and its embedded component's list (auth into portal, admin into web-ui), and attaches only that one. The three `OIDC_*` aliases the chart fills from the `AUTH_*` values move into the portal Secret alone, which is the same rule the CLI expresses with `envName`. The checksum annotation hashes the workload's own Secret, so rotating the portal's cookie key rolls the portal and nothing else. A non-empty `secretEnv` value that no enabled service lists fails the render naming the key, which is the habit this removes: adding a key to the map and expecting it everywhere.

The defaults come from reading the code rather than the current values file, and they turned up two things worth knowing. The egress-proxy authz reads `DATABASE_URL`, `CAPABILITY_SECRET`, and `CORE_SIGNING_SECRET`, and the CLI does not know that service exists. And core reads `PORTAL_SESSION_SECRET` as the fallback for an undeclared `DEPLOY_APPS_SESSION_SECRET`, so the portal's cookie key reaches core until an operator sets the dedicated one.

Migration is one `helm upgrade` with no values change. Every pod rolls once because its Secret is new, and each comes back with a strict subset of what it had. An operator who put a custom key into `secretEnv` for a plugin service gets a render failure naming it and adds it to that service's list. `helm rollback` restores the single Secret. The chart version goes to 0.3.0.

The repository renders the chart nowhere in CI, so this ships with a `helm lint` and `helm template` check that asserts one Secret per Deployment, the portal Secret free of the six keys above, every `envFrom` naming its own Secret, and an unrouted key failing with its name.

What this does not do

It changes nothing any process reads, adds no ServiceAccounts, and picks no carrier: an `ExternalSecret` per workload slots into the same shape later. Rendering the lists from the CLI's spec list is the right end state and needs a Kubernetes emitter and a shared spec between `cli/src/secrets.ts` and `src/deployment/secret-schema.ts`; this should not wait for that. It is the first step of a larger proposal to replace the static secrets with federated credentials, which we will send separately once it has been exercised here, and which needs this in place first.

Happy to build it. It is a chart-only change with a test, and it lands independently of anything else.
