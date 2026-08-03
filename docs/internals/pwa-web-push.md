# PWA Web Push

> For maintainers. This document describes the two relay delivery paths. The
> installed-PWA path is intentionally **not** a T3 Connect feature.

T3 Code has two distinct ways to deliver Web Push. They share the relay's
delivery queue and the `relay_web_push_subscriptions` table, but their identity,
authorization, and lifecycle rules are deliberately different. Do not collapse
them into one path or make an installed PWA require a Clerk account.

| Path                    | Audience                                      | Identity                                        | Relay API group |
| ----------------------- | --------------------------------------------- | ----------------------------------------------- | --------------- |
| Anonymous installed PWA | A particular Home Screen/browser installation | Random installation ID plus local bearer secret | `pwa`           |
| Account relay delivery  | A signed-in T3 Connect client                 | Clerk-backed relay client identity              | `client`        |

## 1. Anonymous installed-PWA path

This is the path used by **Notifications on this device** in the hosted web
app. It is for iOS/iPadOS Home Screen installs (iOS/iPadOS 16.4 or later) and
other standards-based installed PWAs. It does not read a Clerk token, does not
create a T3 Connect link, and must not be affected by T3 Connect sign-out.

### Browser flow

1. `apps/web/src/main.tsx` starts `registerPwaServiceWorker()` from
   `apps/web/src/pwa.ts`. Registration is bounded: a worker that fails to
   activate within five seconds is reported as a worker failure, never as an
   indefinitely pending preview.
2. `PwaNotificationSettings` in
   `apps/web/src/components/settings/SettingsPanels.tsx` fetches the public
   VAPID key from `GET /v1/pwa/web-push/config`.
3. The direct Enable interaction calls `PushManager.subscribe()` via
   `apps/web/src/agentNotifications/browserNotifications.ts`. This must remain
   in the user gesture; iOS may reject a subscription created after arbitrary
   asynchronous work. Permission approval can require a second Enable tap.
4. `apps/web/src/agentNotifications/pwaPushRelay.ts` creates and persists one
   random `installationId` and `installationSecret` in the PWA's local storage.
   It sends the Push API endpoint, key material, preferences, selected primary
   environment ID, and that installation credential to
   `PUT /v1/pwa/web-push/subscriptions`.
5. The relay stores a SHA-256 hash of the installation secret, never the raw
   secret. It uses the credential to authorize test and removal calls. Disabling
   notifications first unsubscribes locally, then performs remote cleanup on a
   best-effort basis. Local unsubscription is the safety boundary if the relay
   is offline.

`service-worker.js` contains no cache or session data. It accepts only a
validated root/test link or validated relative thread link, shows generic copy
unless the payload explicitly permits names, and opens/focuses the linked
thread on click.

### Relay and server flow

The anonymous endpoints are declared in `packages/contracts/src/relay.ts` and
handled by `infra/relay/src/http/Api.ts`:

- `GET /v1/pwa/web-push/config`
- `PUT /v1/pwa/web-push/subscriptions`
- `POST /v1/pwa/web-push/subscriptions/:subscriptionId/remove`
- `POST /v1/pwa/web-push/subscriptions/:subscriptionId/test`
- `POST /v1/pwa/environments/:environmentId/threads/:threadId/agent-activity`

For a server that has no T3 Connect environment credential,
`apps/server/src/relay/AgentAwarenessRelay.ts` uses the last endpoint. It signs
each activity state with its environment key. The PWA endpoint verifies the
signature, advances only the subscribed installations' per-thread baseline,
and queues transitions. It intentionally does **not** retain an anonymous
activity projection when no installation is subscribed.

`WebPushSubscriptions.transitionEnvironment` only emits a notification for a
newer state and only on these transitions: an actionable plan becomes
available, entering approval/input waiting, entering completed, or entering
failed. The initial state, replayed state, unchanged state, and stale state are
suppressed. Per-installation event toggles and privacy mode are evaluated before
the job is queued.

A reused browser endpoint is transferred within the installation upsert and
its old transition baseline is removed. This lets a removed/reinstalled Home
Screen app take ownership without delivering future notifications to the old
installation.

### Data model and delivery

The migration
`infra/relay/migrations/postgres/20260803000000_anonymous_pwa_web_push/migration.sql`
adds `environment_id`, `installation_id`, and `installation_secret_hash` to
`relay_web_push_subscriptions`. Anonymous rows use the opaque pseudo-owner
`pwa:<installationId>` solely to preserve the shared table's existing
non-null `user_id` column; it is not a user account.

`RelayWebPushDeliveryQueue` signs each queued job. The consumer uses VAPID and
the standard `web-push` package. Transient push-service errors retry through
Cloudflare Queues; a permanent `404` or `410` removes the subscription. The
queue also records idempotent delivery attempts.

## 2. Account/T3 Connect relay path

The older account path remains in place for authenticated relay clients and is
not the installed-PWA onboarding flow. Its endpoints are in the `client` group:

- `GET /v1/client/web-push/config`
- `PUT /v1/client/web-push/subscriptions`
- `DELETE /v1/client/web-push/subscriptions/:subscriptionId`
- `POST /v1/client/web-push/subscriptions/:subscriptionId/test`

These calls require the existing Clerk-backed relay client authentication. The
subscription is associated with `userId`, and the normal
`AgentActivityPublisher` fans out only through T3 Connect environment links and
their account-level notification preferences. Native APNs, Live Activities,
and Android behavior remain on this path and must not be changed while editing
the PWA flow.

The shared queue identifies the delivery kind as `web_push_notification`; the
APNs fields remain present for API compatibility, while Web Push status/reason
fields describe the browser delivery result.

## Hosting and release requirements

The hosted app must return actual static files, not the SPA fallback, for:

- `/service-worker.js`
- `/sw.js`
- `/manifest.webmanifest`
- `/sounds/*`

`apps/web/vercel.ts` places `{ handle: "filesystem" }` before the final
`/index.html` fallback. `.github/workflows/release.yml` verifies MIME type and
non-HTML response bodies on the alias it just updated. A PWA installed from an
older deployment that served HTML for the worker or manifest must be removed
and installed again after the release.

The production relay deploy requires these VAPID settings in the GitHub
`production` environment:

- variable `WEB_PUSH_VAPID_SUBJECT` (a `mailto:` or HTTPS contact URI)
- variable `WEB_PUSH_VAPID_PUBLIC_KEY`
- secret `WEB_PUSH_VAPID_PRIVATE_KEY`

`infra/relay/src/worker.ts` configures the Cloudflare worker with
`nodejs_compat`, the Web Push delivery queue, and its dead-letter queue. Do not
rotate only one VAPID key: rotating a key pair invalidates existing browser
subscriptions, so deploy a matched public/private pair and have installations
subscribe again.

## Operational troubleshooting

1. Confirm the deployed worker and manifest return their expected MIME types
   and are not HTML. This is the first check when iOS cannot subscribe or a
   local preview fails.
2. Check that the PWA is installed, served over HTTPS, and has notification
   permission. Safari's ordinary browser tab is not the iOS installed-PWA
   target.
3. Use **Remote test** from Notifications on this device. It queues a generic
   test for the local installation only.
4. Check the relay Web Push queue/dead-letter queue and delivery attempts for
   transient failures or `404`/`410` cleanup.
5. When testing a production change on iPhone/iPad, remove any old malformed
   install, install again from the newly released `app.t3.codes`, enable the
   switch, then test background delivery and a thread deep link.
