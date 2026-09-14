# Getting rid of the static secrets

We run qm on AWS and have been trying to get the long-lived secrets out of it. We got far enough to think the change belongs upstream rather than in our layer, so here is what we found.

The deploy plane is already most of the way there, which is why we think this is tractable at all. The AWS deploy role is assumed through GitHub OIDC with audience and subject pinned and wildcards rejected, image pushes use the per-job token, and images are signed keylessly. None of that needs a secret. The runtime plane has none of it.

Counting what is left: the CLI declares 41 first-party secret names, nine of which are not secret material, so 32 real ones. Five more live outside that list — `FLY_SANDBOX_API_TOKEN`, `SECURITY_SCREEN_PROXY_TOKEN`, `NPM_TOKEN` in the release workflow, and two that core requires but the CLI has never heard of, `MODEL_GATEWAY_API_KEY` and `DEPLOY_APPS_SESSION_SECRET`. Those two are worth fixing whatever happens to the rest: a secret the deployment tooling does not know about cannot be validated, routed or rotated, and neither reaches `.env.example`.

The one we care most about is `CORE_SIGNING_SECRET`. It is a single symmetric HMAC key shared by core and every surface plugin, including any plugin a deployment adds with `coreAccess` left on. Any holder can forge any other holder's requests, so a compromised admin container can sign as portal. The signature carries no caller identity — `verifySignature` checks signature, freshness and replay and nothing else — so core cannot tell which surface is calling. And with one key and one value, rotation is a fleet-wide atomic event with no overlap window. This is the place where federation changes the security model rather than just moving where the secret sits.

What we would like to build

- Per-surface identity in place of the shared HMAC. Each surface mints a short-lived token and signs it with its own KMS key, whose policy admits only that surface's task role; core verifies locally against a cached public key and maps the key to a surface. One KMS call per token, not per request.
- RDS IAM authentication for core's database connection, replacing the `random_password` Terraform writes into state and into `DATABASE_URL`.
- npm trusted publishing instead of `NPM_TOKEN`.
- KMS-held keys for what core and auth sign and encrypt with, where nobody outside the deployment needs the key: `CONNECTOR_SECRET_KEY` as envelope encryption, `AUTH_SIGNING_JWK` behind the existing JWKS endpoint, the remaining HMACs as `GenerateMac`/`VerifyMac`.

Four things we got wrong on the first pass, which we would rather flag than have you find

- **ECS has no OIDC issuer.** Our first design had a surface ask STS for a signed JWT. STS consumes a web identity token and does not mint one; projected OIDC service-account tokens are a Kubernetes feature, not an ECS one. Hence KMS signing above. The alternative is SigV4 plus an `sts:GetCallerIdentity` replay, the way Vault's `aws-iam` method works, but that puts an STS call on core's request path.
- **There is no existing seam to hang this on.** `SecretSource` carries connector OAuth clients only; core reads `CORE_SIGNING_SECRET`, `CONNECTOR_SECRET_KEY`, `SKILL_SIGNING_SECRET` and `DATABASE_URL` straight from `process.env` in `config.ts`. The CLI and core also keep two separate secret spec lists with no import between them. Reconciling those comes first, and it is a refactor with no security benefit of its own.
- **RDS IAM auth does not delete the master password.** RDS requires one at instance creation, `manage_master_user_password` relocates it rather than removing it, and the `rds_iam` grant needs a password-authenticated session to bootstrap. `pooledDatabaseUrl` also rejects a pooled URL whose credentials differ from the direct one, so "direct goes IAM, pooled stays on a password" is not currently expressible.
- **Per-surface task roles do not exist yet.** The module gives core its own role and shares one `task` role across every other service. With a shared role the caller identity is identical for admin and portal and the exercise is pointless, so splitting it is step one, not a detail.

What this does not do

Slack, the connector OAuth client secrets, the sandbox backend keys and the model provider keys have no federation path we can find, and we are not proposing to invent one. The most we would do is keep them in the durable store rather than process environment, with a rotation age `qm doctor` reports. `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` already work that way; `SLACK_SIGNING_SECRET` does not. On AWS, Bedrock and SES would remove the model and email keys outright, but `MODEL_PROVIDERS` has no Bedrock entry and the SES path today is SMTP credentials, so both are new implementations rather than a config flag.

We have not checked whether Porter, Sprites, E2B, Modal, smolmachines or Agent37 support scoped sub-token minting; if any do, their keys stop being irreducible. Porter may be the easiest target for real workload identity, since it runs on the operator's Kubernetes and that does have a projected-token issuer.

Happy to build this if you are interested, and happy to split it so the npm change and the two undeclared secrets land independently of the larger refactor.
