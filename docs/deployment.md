# Distribution and self-hosted deployment

## Choose the distribution route

| Route | Build location | Authentication | Current support |
| --- | --- | --- | --- |
| npm install from Git commit | Target server, through `prepare` | Git credentials if source is private | Ready; no registry needed |
| npm tarball | Build machine/CI | Access to the transferred artifact | Ready; prebuilt JavaScript |
| GitHub Packages | Build machine/CI | Registry token and package read permission | Documented future publishing option |
| npm registry | Build machine/CI | npm account/package permissions | Not published |

The repository is currently public. `private: true` in package.json blocks npm
publication, not Git reads or tarball creation. To keep source distribution
confidential, repository visibility/access must be configured separately. Nothing
in this refactor changes repository visibility or publishes a package.

Allowing a GitHub repository as a trusted source in a host is not authentication.
The service account running installation also needs Git read access. A private
GitHub Packages package has its own registry permissions, independent of whether
a host trusts a repository.

## Install a pinned Git source

Install Node 22.19+ and Git on the target server. Install and authenticate Multica
against the intended Multica server as the agent's OS user. Install either OMP or
Pi separately; Workgraph does not install a harness into the application.

```bash
mkdir -p "$HOME/workgraph-install"
cd "$HOME/workgraph-install"
npm init -y
npm install --save-exact 'git+https://github.com/br-ws-r/workgraph.git#<full-commit-sha>'
omp plugin link "$PWD/node_modules/@br-ws-r/workgraph"
# For Pi:
# pi install "$PWD/node_modules/@br-ws-r/workgraph"
```

Use an approved full commit, replacing the placeholder. The Git dependency's
`prepare` hook builds TypeScript. npm installs build-time dependencies temporarily
for that step; the installed runtime retains only Zod and TypeBox. Do not disable
lifecycle scripts for a source install that has no `dist/`. A built tarball can be
installed with `--ignore-scripts` instead. npm documents the Git prepare behavior
in its [installation reference](https://docs.npmjs.com/cli/commands/npm-install).

Source installation relies on npm installing the development dependencies
(including TypeScript and Node/host types) **before** running `prepare`. The
Git-install smoke test in CI checks that ordering. If an installation policy or
another package manager blocks those dependencies or build scripts, use the
prebuilt tarball route; the source tree alone is not a production artifact.

Preserve this application's package.json and package-lock.json. Re-deployment
uses `npm ci` from those files; it still needs Git access and build dependencies
for source installation. Source pins fix Workgraph code; use a built artifact
when the build itself must be performed once from the repository lockfile.

For private Git access, a read-only deploy key is suitable for one source:

```bash
# The key is provisioned separately, has read access to this repository only,
# and is readable only by the service user. Verify github.com's host key first.
export GIT_SSH_COMMAND='ssh -i /path/to/workgraph-deploy-key -o IdentitiesOnly=yes'
npm install --save-exact 'git+ssh://git@github.com/br-ws-r/workgraph.git#<full-commit-sha>'
```

HTTPS with a configured Git credential helper is another option. Never put
credentials into dependency URLs, shell history, package.json or lockfiles. See
[GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).

OMP's plugin manager also supports Git sources, but uses Bun installation
semantics. The tested deployment route here builds/installs with npm first, then
links the built directory. It avoids relying on Bun's trust/build handling for a
new source. `omp plugin link` registers the directory in the invoking user's
plugin state; ensure this is the same environment/user as managed agent runs.
See [OMP's plugin manager contract](https://github.com/can1357/oh-my-pi/blob/v18.1.11/docs/plugin-manager-installer-plumbing.md).

For a one-off preflight directly from a trusted source, npm can also run the CLI:

```bash
npm exec --package='git+https://github.com/br-ws-r/workgraph.git#<full-commit-sha>' -- workgraph doctor
```

This is not a daemon or a replacement for installing the extension into OMP/Pi.

## Build and transfer a tarball

On the build machine, at the approved commit:

```bash
npm ci
npm run check
npm pack
sha256sum br-ws-r-workgraph-0.1.0.tgz
```

`npm pack` includes compiled code, declarations, documentation and metadata.
Tests, scripts, node_modules, local databases and real environment files are excluded; `.env.example` is included.
Transfer the tarball and its checksum through the deployment system. On the target:

```bash
cd "$HOME/workgraph-install"
npm install --save-exact --ignore-scripts /path/to/br-ws-r-workgraph-0.1.0.tgz
omp plugin link "$PWD/node_modules/@br-ws-r/workgraph"
# Or: pi install "$PWD/node_modules/@br-ws-r/workgraph"
npx --no-install workgraph doctor
```

Keep the artifact accessible wherever a lockfile uses that tarball path. A tarball
still needs npm access or a populated package cache for its runtime dependencies;
it is not a bundled offline executable. Until releases have distinct versions,
record the Git commit and tarball checksum alongside version `0.1.0`.

## Optional future private GitHub Packages publishing

This PR deliberately contains no publishing workflow. To adopt a registry later:

1. Assign a release version and remove `private: true` in a reviewed release change.
2. Add `publishConfig.registry` pointing to `https://npm.pkg.github.com`.
3. Publish with a credential authorized for `write:packages`, then confirm the
   package's visibility and access. GitHub initially creates packages as private.
4. Grant target users read access and configure their npm registry authentication.

Example user-level `.npmrc` for the install account:

```ini
@br-ws-r:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Supply a personal access token (classic) with `read:packages` and the appropriate
account/package access; organizations may also require SSO authorization. A
repository read token or source allowlist alone is insufficient. In Actions,
`GITHUB_TOKEN` access depends on the package's repository permissions. Consult
[GitHub's npm registry guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).

Then the installation source becomes `@br-ws-r/workgraph@<version>`. npm's own
private registry packages instead use npm permissions/billing, not GitHub
repository grants. Do not switch distribution source silently in deployment files.

## Self-hosted operations

Workgraph shares the agent process. Provision Multica, Cognee, their databases,
TLS and inference separately using their supported deployment tooling. There is
no Workgraph container, HTTP service or generated host-specific stack to maintain.

Use a service environment file based on [`.env.example`](../.env.example), with
permissions restricted to the service account. Configure the launcher to pass
these settings to every agent. Workgraph does not read dotenv files itself.
Managed task/agent/run identifiers are supplied per run by Multica; do not persist
one task's identity in a shared service environment file.

For Cognee, verify this API contract at your pinned server release:

| Request | Required behavior |
| --- | --- |
| `GET /health` | Reachable health endpoint |
| `POST /api/v1/remember` | Multipart file, `datasetName`, repeated `node_set`, `custom_prompt`, `chunk_size`, `run_in_background=false`; JSON `status: completed` |
| `POST /api/v1/recall` | JSON dataset filter, CHUNKS, node names, top_k; list of entries containing `text` |

An older server with only add/search/cognify endpoints needs upgrading or an
explicit transport adapter; Workgraph does not guess alternate routes. Use
Cognee's [REST deployment guide](https://docs.cognee.ai/guides/deploy-rest-api-server)
for authentication and storage configuration. Bearer tokens are supplied by the
operator; Workgraph does not store passwords or refresh tokens automatically.
Restart the harness after rotating a token.

Persist `WORKGRAPH_DATA_DIR` on local disk owned by the agent user (for example
`/var/lib/workgraph`, provisioned by your deployment tooling). Use restrictive
permissions and encrypted backups as appropriate for the records stored there.
SQLite files and WAL are not coordination storage for multiple servers or NFS;
see [SQLite WAL constraints](https://sqlite.org/wal.html). Multiple agent processes
on one host can share the directory. Multiple hosts can share semantic Cognee
memory, but their exact timelines and queues are separate.

Keep each data directory associated with one Multica deployment and one Cognee
endpoint/tenant. Do not point an existing queue at an unrelated backend or tenant:
queued records intentionally replay to the configured transport. Workgraph does
not persist or enforce endpoint ownership in schema v3. Use a fresh directory for
an independent installation, and separate Cognee tenants/instances where workspace
slugs could overlap. Moving the same deployment uses the backup procedure below.

A reverse proxy must accept bounded multipart uploads and allow synchronous
Cognee ingestion within your chosen timeout. The default recall timeout is short;
self-hosted cold starts may need a larger value. TLS errors and redirects are
errors, not reasons to turn off certificate checks. Graph extraction may duplicate
records after ambiguous timeouts because Cognee does not guarantee the supplied
idempotency key. Startup, settlement, new writes and graceful shutdown retry pending work; there is no
periodic retry while every harness is stopped or idle.

## Acceptance check

After installing the approved package in the actual service environment:

1. Run `multica version`, `multica auth status`, and `workgraph doctor --online`.
   Confirm the expected workspace slug and dataset. Health alone is insufficient.
2. Start `omp --initiative <test-root-identifier>` (or the Pi equivalent) and check
   `initiative_memory_status` for the correct scope and configured backend.
3. Remember one harmless sourced test decision with a unique stable identifier.
   Check `initiative_timeline` until its semantic delivery is `delivered`.
4. Recall the decision from a fresh harness process. Check identifier, source and
   workspace provenance, not just free-form generated text.
5. In an isolated test environment, interrupt Cognee connectivity, remember another
   test record, and confirm it remains pending. Restore connectivity and trigger a
   later write or graceful shutdown; confirm delivery and persistence after restart.
6. Verify a managed task resolves to its actual issue/root and that an unscoped chat
   cannot write. Repeat on the harnesses the target server actually uses.

This check needs operator-provided infrastructure and credentials. The automated
suite uses real local HTTP and SQLite but does not assert compatibility with every
remote Cognee version or run a paid agent inference session.

## Backup, upgrade and recovery

For an upgrade, stop new managed launches, let existing harnesses shut down, and
back up the whole data directory before replacing the package. Do not copy only
the `.db` file while writers are active: committed data may still be in the WAL.
For online backup use SQLite's backup tooling with an operationally verified
procedure. Preserve Cognee's backing stores separately; local SQLite is not a
backup of the entire semantic graph.

Install the new pinned source/artifact, retain the previous lockfile/artifact for
rollback, restart the harness and rerun acceptance checks. This release retains
schema v3 and the `workgraph-workspace-v3.db` name. It does not migrate older
pre-release schemas/datasets. Node and Bun can open the same v3 file.

A workspace slug rename changes the dataset name for new processes. Already
queued records are delivered to the dataset derived from their stored slug. Old
semantic history is not automatically moved or searched in the new dataset;
plan an explicit Cognee migration if that history should remain discoverable.

If activity reconciliation reports a failed baseline or a truncated history gap,
inspect Multica availability/history and the affected issue before recovery.
A failed initial baseline remains failed after restart. Do not routinely delete
state to make the warning disappear. Once the missing period has been investigated
and accepting a new baseline is an explicit operating decision, stop all writers,
back up the database, and clear only that workspace/issue's baseline state:

```sql
BEGIN IMMEDIATE;
DELETE FROM multica_activity_seen
WHERE workspace_id = '<verified-workspace-uuid>' AND issue_id = '<verified-issue-uuid>';
DELETE FROM multica_activity_state
WHERE workspace_id = '<verified-workspace-uuid>' AND issue_id = '<verified-issue-uuid>';
COMMIT;
```

Restart a scoped harness to establish a fresh baseline. This preserves existing
Workgraph events but does **not** reconstruct the missing period. There is no
automatic backfill or destructive memory tool. Investigate pending delivery errors
separately; backend HTTP errors report status codes without retaining raw response
bodies.
