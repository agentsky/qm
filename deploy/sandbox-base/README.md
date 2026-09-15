# Sandbox base image

`deploy/sandbox-base/Dockerfile` builds the shared sandbox **base image**: a minimal
generic toolset (the coding-agent CLIs, AWS CLI v2, the baked Python venv at
`/opt/agent-venv`, and the optional agentic browser engine behind the
`INSTALL_BROWSER_ENGINE` build arg).

Where the image is used:

- **Signed releases.** `.github/workflows/release-package.yml` builds and signs it as
  `ghcr.io/<org>/qm/sandbox-base` alongside the service images.
- **Local docker sandboxes.** `scripts/local-sandbox-build.sh` builds it as
  `qm-sandbox-base:dev`, then stacks `deploy/sandbox-local/Dockerfile` on top to
  produce `qm-sandbox-local:latest` for `SANDBOX_BACKEND=local`.

Hosted sandbox backends (smolmachines, e2b, modal, agent37) do **not** boot this image:
they boot their platform's stock image, and tool descriptors and skills arrive through
the deployment-layer sync.

Deployment-specific tools are NOT baked here. `deploy/sandbox-base/tools/x-api` is
copied into the image by the Dockerfile, and this directory's file list feeds the local
sandbox image fingerprint (`src/sandbox/local-sandbox.ts`), so adding a tool here
invalidates stale local images.
