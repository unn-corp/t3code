# Shared team projects

The team service uses a dedicated Clerk application for identity and its own
team roster and project memberships for authorization. One dedicated service
represents one team. Team owners administer the roster and access every project;
ordinary members access only projects explicitly assigned to them. It does not exchange team credentials for
personal environment pairing credentials. Agents and provider accounts stay on
each teammate's local machine. The shared service stores project collaboration
state; it does not run coding agents or accept provider credentials.

Configure the service through process environment. The Docker deployment reads
the secret key from `/run/secrets/clerk_secret_key`:

| Variable                        | Value                                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| `T3_TEAM_CLERK_SECRET_KEY`      | Server secret from the dedicated Clerk application.              |
| `T3_TEAM_CLERK_PUBLISHABLE_KEY` | Publishable key from that same application.                      |
| `T3_TEAM_ORIGINS`               | Comma-separated exact client origins, including scheme and port. |
| `T3_TEAM_OAUTH_ISSUER`          | HTTPS issuer origin for the dedicated Clerk instance.            |
| `T3_TEAM_OAUTH_CLIENT_ID`       | Public OAuth client with Device Authorization Grant enabled.     |
| `T3_TEAM_CREATORS`              | Comma-separated Clerk user IDs for initial team owner bootstrap. |

Keep the secret key outside source control. Configure the corresponding client
origins in Clerk. Dedicated `t3 team-service` startup requires nonempty valid
authentication configuration and fails clearly when it is missing. Normal local
T3 keeps Teams optional. `T3_TEAM_CREATORS` bootstraps the initial team owners
only while the service has no owners; it is not a dynamic project-creator
allowlist. Every roster member can create projects. Existing project members are
backfilled as ordinary team members, so configure the initial owner IDs when
upgrading. Removing or demoting a configured owner does not automatically promote
them again once an owner is established.
For worktree development, use the actual client origin reported by the dev runner.

Enable the public OAuth client's `openid profile email offline_access` scopes
and consent. No client secret is used. The personal T3 server discovers the
issuer's device, token, and revocation endpoints and pins the service, issuer,
and client binding alongside its private account credential. Configure both
OAuth variables to enable native account sign-in.

In the dedicated Clerk instance's OAuth applications > Settings > Access token
format, select Opaque access tokens so logout can revoke access immediately.
Previously issued JWT access tokens remain valid until expiry; revoking their
refresh grant does not provide immediate access-token revocation. See
[Clerk's token format guidance](https://clerk.com/docs/guides/configure/auth-strategies/oauth/how-clerk-implements-oauth#access-token-format).

Set `T3_TEAM_SERVICE_URL` on each teammate's T3 environment to the Teams service
origin to offer sign-in without entering an address. Saved account bindings take
precedence over this default; changing it never redirects existing credentials.
In T3 Settings > Connections > Teams, select the environment, choose **Sign in to
Teams**, and approve the displayed code at the verification link. For a custom
service or an unconfigured environment, enter the origin under **Advanced**. The
selected environment stores and refreshes the account; its administrative
`access:write` permission is required to sign in, cancel, or disconnect. HTTPS
service origins are supported, with explicit loopback HTTP permitted for local
development. Disconnect clears local credentials and attempts issuer revocation;
if revocation cannot be confirmed, revoke the grant through the account portal.

For the Mothership deployment, use `https://t3teams.unnportal.io` as the service
origin and include that exact origin in `T3_TEAM_ORIGINS`. Run Compose with both
`compose.yaml` and `compose.https.yaml`, setting `T3_TEAM_IMAGE` to the reviewed
image digest, and install `infra/team-service/traefik.yml`
in the existing proxy's watched dynamic configuration directory. The proxy
terminates HTTPS and secure WebSockets; port 3910 remains loopback-only on the
host. Verify certificate validity, HTTP-to-HTTPS redirection, and rejection of
unauthenticated project requests before switching clients. These settings publish
the collaboration service, not a personal T3 environment.

The Teams service domain and the OAuth issuer are separate bindings. Clerk
development instances keep their `clerk.accounts.dev` approval domain. A custom
Clerk approval domain requires a production instance and its DNS configuration.
Switching instances also changes user identities and OAuth credentials; preserve
project memberships through an explicitly verified identity migration. Clients
already signed in to the loopback service must disconnect and sign in to the
HTTPS service explicitly rather than redirecting stored credentials automatically.

Use the native command palette to open, create, or share a project after joining
the team. `/spaces` remains a service management interface with the same roster
and project permissions. Every member can create projects and select existing
teammates as contributors or viewers. The project creator and team owners can
change those assignments; the creator remains protected while on the team.
Project-owner labels do not confer team administration.

Only team owners invite outsiders, change owner/member team roles, or remove team
members. The team must retain at least one owner. Manage team invitations in
T3 Settings > Connections > Teams after the initial account connection. Invitees
receive a Clerk email invitation valid for seven days. Configure the dedicated
Clerk instance's Access mode as Invite-only to block public account registration.
After accepting the email, invitees sign in to T3 using the invited verified email;
team membership is added automatically. Owners assign projects after they join.
Canceling or reissuing an invitation revokes its pending Clerk signup link. If
email delivery fails, the invitation remains visible; cancel it or retry inviting
that email. Existing accounts are not deleted when an invitation is canceled. Joining a team alone grants no project access.
Use Refresh team access to reload account capabilities, roster, and projects.
Owners see all team projects; members see only explicit assignments. Team removal
or owner demotion invalidates implicit access as well as active shared streams.
Cloud agent controls in older clients are refused by the server.

Native shared-project connections expose only the authorized project's thread
views and discussions. Their private state is stored below the service's
`userdata/team-native` directory and must be included in backups alongside the
membership database. Persist the service's state volume across container replacement. Member removal, role changes, session revocation, and credential
expiry close active native connections.

The personal server can link a local project and explicitly publish selected
threads through a private WebSocket bridge. Linking publishes no existing chats.
Publication snapshots only the current message history and then sends bounded,
acknowledged updates; provider sessions, credentials, attachments, checkpoints,
and host execution controls remain local. Agent status is member-reported.

Publication stops on an account change, loss of project access, root change, or
destructive thread-history reset. A reset or new sign-in requires deliberate
unlinking and relinking before publishing again. This creates a new publication;
it does not overwrite the previous shared history. Unlinking retains both the
local checkout and shared history. Existing local agents keep running when
sharing stops. Known contributors can continue local work during a network
outage; viewers cannot start work through linked-project controls.

The backend now provides shared Git transfer and explicit working-file synchronization.
Share uploads the reviewed branch's reachable committed history; it does not
commit or upload the index, ignored files, or unrelated branches. Open downloads
a real checkout and applies the current shared working tree. Fetch stores shared
history under a separate Teams ref without resetting the working tree. Publishing
a subsequent commit requires a fast-forward from the expected shared commit.

File synchronization is disabled initially. Enabling it covers tracked files and
shared files; new untracked or ignored local files require explicit inclusion.
Protected file classes remain excluded even if tracked. Existing local differences become
conflicts. Conflicting versions require an explicit checked resolution, and
permission loss or account changes stop access without stopping local agents.
Renames use checked file changes; newly named untracked files must be included.
A shared directory-to-file change removes only obsolete empty directories. If
local child files remain, synchronization reports a directory conflict; move those
files before resolving the shared version.
Original inodes replaced by incoming changes remain below the checkout's
`.t3-team-sync` directory, with adjacent `.path` files recording their original
relative names. This private recovery directory is never uploaded. Review and
remove obsolete backups manually; its 1,024-backup limit stops further replacement
rather than deleting recovery data automatically.

The initial file implementation supports Linux T3 hosts only, including Linux
remote environments used from web or desktop clients. Windows and macOS shared
file operations return an explicit unsupported-platform error; personal projects
are unaffected. Tests exercised Linux. File operations use pinned Linux directory
descriptors to reject intermediate symlink substitution. This does not change the
permissions or sandbox of an agent running locally.

Transfer limits are 512 MiB per Git bundle, 1 MiB per working file, 64 MiB for a
materialized Git tree, 10,000 files, 4 MiB of path metadata, 250,000 imported Git
objects, 1 GiB of expanded history, 64 MiB per historical blob, and 500,000
historical tree entries. Git verification has a 120-second aggregate time budget
and at most two concurrent transfers. Linux hosts require `/usr/bin/prlimit`;
Git children run with CPU, address-space, file-size, and core-dump limits.
Conflicts page one proposal at a time, with at most 64 MiB of unresolved payloads;
resolved payloads are cleared while receipts remain idempotent. Symlinks, submodules, alternate/shallow/partial
repositories, nested project roots, and reserved/private file classes are rejected.
Temporary Git verification uses the persistent data volume, not `/tmp`; backups
must include `userdata/team-repositories` as well as the membership and native
project databases. Aborted transfers clean their staging; abandoned incomplete
uploads expire after ten minutes when another transfer begins. Local preflight verifies the selected history before creating cloud metadata.
Protected paths, including `.env.example`, and unsupported or oversized history
require a sanitized branch or reduced history; retrying unchanged history cannot
fix them. A later failed initial transfer can leave a visible shared project;
retry initialization rather than assuming remote creation was rolled back.

Normal saves exchange manifest deltas and dirty files over the private WebSocket.
The service retains 1,000 versions of manifest changes; older cursors resnapshot.
Periodic reconciliation handles missed filesystem notifications. Native web and
desktop project actions, normal local-provider chat, safe shared read views, project
discussions, and membership controls use the personal server's private bridge.
Remote, relay, and tunnel clients use their existing prepared environment transport;
no cloud grant is delivered to the renderer. Presence heartbeats reuse the project's
persistent scoped connection, with bounded sessions and expiry. Publication intent
is saved before local creation, completed only after its durable receipt, and can
be retried independently of a successful agent turn. Stopping publication retains
cloud history. Shared attachments and the native React Native Teams interface are
not implemented; mobile's shared runtime commands and outbox reject peer execution.
Local agents retain their normal operating-system permissions.
The dedicated service has no personal pairing, provider, shell, filesystem,
dashboard, MCP, relay, preview, or local account administration routes. Root
redirects to `/spaces`; unavailable personal routes return 404. The container
requires only its Clerk secret and persistent collaboration data volume. See
the [container guide](../../infra/team-service/README.md) for setup and replacement.
