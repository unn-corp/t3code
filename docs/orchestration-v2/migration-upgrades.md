# Migration upgrades

The fork keeps its published migration IDs through 96. The upstream release
uses IDs 36–58 for a different sequence, so a database upgraded from upstream
cannot be migrated by comparing only the highest ID. On startup, the server
recognizes the pinned upstream ledger, matches those completed migrations by
name, and moves their ledger records to the fork IDs. It then applies the
fork-only migrations in the gaps before recording the already-present V2 and
webhook schema at fork IDs 95–98.

The same reconciler handles older fork preview databases that recorded V2 at
53 or 54. It preserves their V2 import state and applies the missing fork
migrations in one transaction. Unknown or conflicting histories fail before
they are changed. Keep this compatibility logic covered by
`reconcileV2PreviewMigration.test.ts` when adding migrations or changing the
upstream/fork manifest relationship.
