import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the release publishes signed images and never a package", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /npm pack/);
  assert.doesNotMatch(workflow, /npm publish/);
  assert.doesNotMatch(workflow, /verify:release/);
  assert.doesNotMatch(workflow, /prepare-release-manifest/);
  assert.doesNotMatch(workflow, /^ {2}package:$/m);
  assert.match(workflow, /^ {2}image:$/m);
  assert.equal(existsSync(".github/workflows/release-images.yml"), false);
  assert.equal(existsSync(".github/workflows/publish-cli.yml"), false);
});

test("the release is the sole sandbox-base publisher and bakes in the browser engine", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(
    workflow,
    /- name: sandbox-base\n\s+dockerfile: deploy\/sandbox-base\/Dockerfile\n\s+build-args: INSTALL_BROWSER_ENGINE=1\n/,
  );
  assert.ok(existsSync("deploy/sandbox-base/Dockerfile"));
  assert.match(workflow, /build-args: \$\{\{ matrix\.build-args \}\}/);
  assert.equal(existsSync(".github/workflows/publish-sandbox-base.yml"), false);
  assert.equal(existsSync(".github/workflows/publish-images.yml"), false);
});

test("every built image has a Dockerfile in the tree the Helm chart deploys from", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  const dockerfiles = [...workflow.matchAll(/^ +dockerfile: (\S+)$/gm)].map((m) => m[1] ?? "");
  assert.ok(dockerfiles.length >= 3);
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(release, new RegExp(`jq -e 'length == ${dockerfiles.length} and all\\(`));
  for (const dockerfile of dockerfiles) {
    assert.match(dockerfile, /^deploy\//, `${dockerfile} lives outside deploy/`);
    assert.ok(existsSync(dockerfile), `${dockerfile} is missing`);
  }
});

test("the release verifies the sandbox base digest is anonymously pullable", () => {
  const workflow = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.doesNotMatch(workflow, /anonymously pullable|DOCKER_CONFIG="\$probe"/);
  assert.match(workflow, /permissions:\s+contents: read\s+packages: write\s+id-token: write/);
  assert.match(
    workflow,
    /docker\/login-action@[^\n]+\s+with:\s+registry: ghcr\.io\s+username: \$\{\{ github\.actor \}\}\s+password: \$\{\{ github\.token \}\}/,
  );
  assert.match(workflow, /platforms: linux\/amd64\s+provenance: false/);
  assert.match(
    workflow,
    /image='ghcr\.io\/yc-software\/qm\/\$\{\{ matrix\.name \}\}@\$\{\{ steps\.build\.outputs\.digest \}\}'\s+cosign sign --yes "\$image"\s+cosign verify "\$image"/,
  );
  assert.ok(workflow.indexOf("docker/login-action") < workflow.indexOf("docker/build-push-action"));
  assert.ok(workflow.indexOf("docker/build-push-action") < workflow.indexOf("Sign exact image"));
});

test("one dispatchable workflow drives the whole release, main-only and in order", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/m);
  assert.match(workflow, /releases are cut from main; this run is on \$GITHUB_REF/);
  assert.doesNotMatch(
    workflow,
    /^ {4}if: github\.ref == 'refs\/heads\/main'$/m,
    "a non-main dispatch fails loudly instead of skipping every job and reporting green",
  );
  assert.match(
    workflow,
    /^ {2}images:\n[\s\S]*?needs: preflight\n[\s\S]*?uses: \.\/\.github\/workflows\/release-package\.yml$/m,
  );
  assert.match(workflow, /^ {2}release:\n[\s\S]*?needs:\n {6}- preflight\n {6}- images$/m);
  assert.doesNotMatch(workflow, /^ {2}cli:$/m);
  assert.doesNotMatch(workflow, /publish-cli\.yml/);
  assert.match(workflow, /concurrency:\n {2}group: release\n {2}cancel-in-progress: false/);
});

test("the release bumps its own version past every tag already released", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.doesNotMatch(workflow, /cli\/package\.json/);
  assert.doesNotMatch(workflow, /npm view/);
  assert.match(workflow, /matching-refs\/tags\/v/);
  assert.match(workflow, /sort -V \| tail -1/);
  assert.match(workflow, /version="\$major\.\$minor\.\$\(\(patch \+ 1\)\)"/);
  assert.match(workflow, /tag="v\$version"/);
  assert.match(workflow, /already exists; refusing to move it/);
  assert.ok(
    workflow.indexOf("already exists; refusing to move it") < workflow.indexOf("gh release create"),
    "the tag gate runs before anything is published",
  );
  assert.match(workflow, /gh release create "\$TAG"/);
  assert.match(workflow, /--generate-notes/);
  assert.match(workflow, /"images\.json#Pinned image digests"/);
});

test("the released images.json is assembled from the digests the image job signed", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const images = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(
    images,
    /name: qm-\$\{\{ matrix\.name \}\}-\$\{\{ github\.sha \}\}\n\s+path: qm-\$\{\{ matrix\.name \}\}\.image/,
  );
  assert.match(images, /if-no-files-found: error/);
  assert.match(release, /gh run download "\$GITHUB_RUN_ID"/);
  assert.match(release, /--pattern "qm-\*-\$GITHUB_SHA"/);
  assert.match(release, /\^ghcr\\\\\.io\/yc-software\/qm\/\[a-z-\]\+@sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(release, /no usable image digests were published for \$GITHUB_SHA/);
  assert.ok(
    release.indexOf("no usable image digests") < release.indexOf("git/refs"),
    "a run that lost a digest fails before the tag is created",
  );
});

test("the tag is created atomically at the released commit, never adopted from elsewhere", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(
    workflow,
    /gh api "repos\/\$GITHUB_REPOSITORY\/git\/refs" \\\n\s+-f ref="refs\/tags\/\$TAG" -f sha="\$GITHUB_SHA"/,
  );
  assert.match(workflow, /--verify-tag/);
  assert.doesNotMatch(
    workflow,
    /--target/,
    "--target only names a commit when gh creates the tag itself, so a tag another actor raced in would silently win",
  );
  assert.ok(
    workflow.indexOf("git/refs") < workflow.indexOf("gh release create"),
    "the ref is created before the release so a duplicate tag fails the run",
  );
});

test("only the tagging job may write to the repository", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  const writes = workflow.match(/^ {6}contents: write$/gm) ?? [];
  assert.equal(writes.length, 1);
  assert.match(workflow, /^ {2}release:\n[\s\S]*?permissions:\n {6}contents: write\n[\s\S]*?gh release create/m);
  assert.doesNotMatch(workflow, /packages: write\n {4}secrets: inherit/);
  assert.doesNotMatch(workflow, /secrets: inherit/);
});

test("images are signed from a main ref, so the pinned cosign identity keeps verifying", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  const images = readFileSync(".github/workflows/release-package.yml", "utf8");

  assert.match(release, /^on:\n {2}workflow_dispatch:$/m);
  assert.doesNotMatch(release, /^ {2}push:$/m);
  assert.match(release, /if \[ "\$GITHUB_REF" != refs\/heads\/main \]/);
  assert.match(images, /--certificate-identity='[^']*release-package\.yml@refs\/heads\/main'/);
});
