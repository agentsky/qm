# One Secret per workload in the Helm chart

We run qm on Kubernetes through `deploy/helm/`. Every pod gets every secret. The chart renders `values.yaml` `secretEnv` into one `Secret` and attaches it to each Deployment with `envFrom`. The portal pod faces the Internet and holds `ANTHROPIC_API_KEY`, `DATABASE_URL`, `CONNECTOR_SECRET_KEY`, `SKILL_SIGNING_SECRET`, `CAPABILITY_SECRET`, and the Admin-role `PORTER_DEPLOY_API_TOKEN`. It reads none of them. The web-ui pod reads three of the 29 values and holds all of them. A portal compromise is also a database, model-billing, and Porter-project compromise.

The routing exists on every other target. The CLI's secret specs name the service that owns each secret, and `secretsForService` decides what each ECS task definition receives. `docs/porter.md` copies the same routing by hand for `porter apply --secrets`. The chart uses neither, and the CLI has no Kubernetes target that could feed it.

What we propose

Keep `secretEnv` as it is: one flat map of values. Add a list of key names per declared service under `services.<name>.secrets`. Ship defaults that record which process reads which key. The chart renders one `Secret` per Deployment, named `<fullname>-<service>-env`, from a named template. The Secret holds the union of the host's list and its embedded component's list (auth into portal, admin into web-ui). The Deployment attaches that Secret first, then the workload's own `services.<name>.envFrom`, then the embedded component's, then the shared top-level `envFrom`. Kubernetes resolves a duplicate key to the last entry, so the shared list still wins, as it does today. The shared list stays as the documented escape hatch.

The chart fills `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `OIDC_ALLOWED_EMAILS` from the `AUTH_*` values when the `OIDC_*` value is unset. That rule moves into the portal Secret unchanged. It must not depend on whether the embedded broker is enabled. An external-OIDC deployment with the broker disabled relies on it today for its email allow-list and its client credentials.

Because each Secret comes from a named template, the checksum annotation hashes one workload's Secret instead of the whole file. Rotating a key only the portal carries, such as `AUTH_SIGNING_JWK`, rolls the portal alone.

A non-empty `secretEnv` value that no enabled workload consumes fails the render and names the key. Consumed means listed by the workload, or read as the source of an alias the workload emits. This removes the habit of adding a key to the map and expecting it everywhere, without breaking the alias case above.

The defaults come from reading the code, not from the values file. They route every secret name the code reads, including the alternative harness credentials `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_AUTH_CREDENTIAL`, `CODEX_ACCESS_TOKEN`, and `CODEX_AUTH_CREDENTIAL`. The current template forwards any key an operator adds, so a Slack-enabled release already carries `SLACK_BOT_TOKEN` through `secretEnv` without the values file naming it, and the defaults route those too. They also route the non-secret settings the stock values file carries in `secretEnv`: `PUBLIC_API_URL`, `SANDBOX_BACKEND`, `DEPLOY_PROVIDER`, the Porter URL, project and cluster IDs, and image names, the two apps domains, `AUTH_ALLOWED_EMAILS`, `AUTH_EMAIL_FROM`, and `ADMIN_GRANTS`. A stock release therefore upgrades without a values change.

Reading the code turned up three facts. The egress-proxy authz reads `CAPABILITY_SECRET` and `CORE_SIGNING_SECRET`. It reads `DATABASE_URL` only as a fallback audit sink when no core relay is configured, and the chart always configures one. The CLI does not know that service exists. When app publishing is configured, core reads `PORTAL_SESSION_SECRET` as the fallback for an undeclared `DEPLOY_APPS_SESSION_SECRET`, so the portal's cookie key reaches core until an operator sets the dedicated one. Web-ui reads `DEPLOY_APPS_DOMAIN` for its frame-ancestors policy, and a missing value degrades silently.

Migration

One `helm upgrade`. Every pod rolls once, because its Secret is new, and comes back with a subset of what it had. An operator carrying a key outside the defaults through `secretEnv` gets a render failure naming it and moves it to `env` or to that service's list. The probes do not catch a lost key: only core has an HTTP health path, and every process treats a missing key as optional. The render check is the safety net. `helm rollback` restores the single Secret. The chart version goes to 0.3.0.

Verification

CI renders the chart nowhere today. This ships with a `helm lint` and `helm template` check. It asserts one Secret per Deployment with the expected keys, and the portal Secret free of the six keys above. It asserts exactly one chart-rendered `secretRef` per Deployment, naming that workload's own Secret. It runs the alias fixtures with the broker disabled, and it asserts that an unused key fails with its name. A second check scans the code for environment reads whose names contain `TOKEN`, `SECRET`, `KEY`, `PASSWORD`, or `CREDENTIAL`. It fails on any name that is neither routed nor on a short exclusion list of non-secrets, so a new credential read cannot go unrouted.

What this does not do

It changes nothing any process reads. It adds no ServiceAccounts and picks no secret store. An `ExternalSecret` per workload fits the same shape later. Rendering the lists from the CLI's spec list is the right end state. That needs a Kubernetes emitter and one shared spec between `cli/src/secrets.ts` and `src/deployment/secret-schema.ts`, and this change should not wait for it. This is the first step of a larger proposal to replace static secrets with federated credentials, which we will send separately.

Happy to build it. It is a chart-only change with a test.
