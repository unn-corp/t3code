# Teams collaboration service container

This image starts `t3 team-service`, a separate collaboration-only runtime.
Clerk verifies identity, and team roster plus project memberships authorize shared thread views,
discussions, and activity. Every agent, provider account, and provider credential
stays on each teammate's local machine. The service has no personal pairing,
host RPC, local account administration, terminal, dashboard, MCP, relay, or
preview routes. The persistent volume also stores passive shared Git history and
working files. Native T3 clients access them through their private account bridge.

Provision as the dedicated non-root deployment account:

```sh
install -d -m 0700 /home/notorious/t3-team-service-dev
python3 infra/team-service/bootstrap.py /home/notorious/t3-team-service-dev
```

Bootstrap creates a private deployment `.env` and an empty Clerk secret
placeholder. It preserves configured values and existing secrets. It does not
read or modify SSH configuration, keys, workers, or authorizations. Existing
obsolete worker secrets on a deployed host can remain; this profile does not
mount them.

Configure the public Clerk key and exact allowed client origins in `.env`.
Put the corresponding secret key in `secrets/clerk_secret_key`, mode `0400` or
`0600`. Startup fails if the secret, publishable key, or origins are missing or
invalid. Each dedicated service represents one team. Set `T3_TEAM_CREATORS` to
initial team owner Clerk user IDs. This bootstraps owners only while the service
has no established owners; it is not an ongoing project-creator allowlist.
Existing project members upgrade into ordinary team membership. All team members
can create projects, and owners see all projects. Only owners invite new people
to the team or administer owner/member roles. Project creators and team owners
assign existing teammates to individual projects as contributors or viewers.
Manage invitations and assignments in T3 after one-time sign-in. Set Clerk's
Access mode to Invite-only. Owner-issued invitations send a Clerk email with a
single-use signup link that expires after seven days. Invited verified accounts
join the team automatically when signing in to T3.
Configure both `T3_TEAM_OAUTH_ISSUER` and `T3_TEAM_OAUTH_CLIENT_ID` for native
Device Authorization Grant sign-in, as described in the
[operations guide](../../docs/operations/team-projects.md).

Build and start from the repository root with the existing deployment env file:

```sh
docker compose --env-file /home/notorious/t3-team-service-dev/.env -f infra/team-service/compose.yaml build app
docker compose --env-file /home/notorious/t3-team-service-dev/.env -f infra/team-service/compose.yaml up -d --no-build
```

The build uses pinned Node `24.21.0-bookworm-slim` digest
`0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` and pnpm
`11.10.0`. Runtime staging copies the exact lockfile-installed dependency
closure, application assets, LICENSE, NOTICE, and third-party notices; it never
installs fallback packages. The Docker context excludes credentials and state.
Git and Linux `prlimit` support verified passive project storage.

Set `T3_TEAM_UID` and `T3_TEAM_GID` to the existing nonzero deployment file owner
(the current deployment uses `1007`). Use the same values for image build and
Compose so existing volume ownership and secret readability remain compatible.
The container uses a read-only root, dropped capabilities, no-new-privileges,
and CPU, memory, and process limits. Mount only the Clerk secret and persistent
`team-data` volume. Do not mount provider credentials, a Docker socket, or a host
home directory.

The listener is published only at host `127.0.0.1:3910`. Root redirects to
`/spaces`; unavailable personal routes return 404. `/api/team/config` must report
`enabled: true` for the health check to pass. The nonsensitive startup receipt is
`Teams collaboration service is ready.` Readiness does not establish a successful
live Clerk login.

Preserve the existing named `team-data` volume across replacement. It contains
the membership database and private native project databases under
`/data/userdata/team-native`, and Git/files under `/data/userdata/team-repositories`.
Back up these together. Replacing a container does
not require removing the volume or any existing deployed secrets.

After building, `python3 infra/team-service/smoke.py` verifies the bundle, NOTICE,
startup separation, persistence, migrations, required config failures, and
container restrictions using synthetic configuration and disposable offline
containers. It exposes no ports and performs no real Clerk sign-in or provider
execution. Run it as the deployment account whose UID owns the secret file.
