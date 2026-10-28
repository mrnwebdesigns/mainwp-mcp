# Deployment review — email address audit

Status: source implementation and fixtures under review. **No production
installation, MCP configuration switch, pilot inspection or live fleet audit is
authorized by this document.** Do not present fixture matches as client matches.

## Authoritative source / isolated branches

All three task branches are `codex/mainwp-email-address-audit-20261027`:

| Repository                                 | Task worktree                                                                     | Base                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `mrnwebdesigns/mainwp-mcp`                 | `/Users/khofmeyer/Development/MRN-worktrees/mainwp-email-audit-mcp-20261027`      | Configured MRN pin `5bf4f80faa2daf8c1fe135de2fcdc1863b7f897e`, official 1.5.1 plus existing MRN patches |
| `mrnwebdesigns/mrn-mainwp-operations-api`  | `/Users/khofmeyer/Development/MRN-worktrees/mainwp-email-audit-provider-20261027` | Current merged `bc78dd31482d782084de3294047b11f10caa1f9e`, provider 0.13.12                             |
| `mrnwebdesigns/mrn-stack-deployment-agent` | `/Users/khofmeyer/Development/MRN-worktrees/mainwp-email-audit-child-20261027`    | Current merged `6ce5a0a6e03341ddd436325cc6d0538f23a55687`, agent 0.3.3                                  |

These are shared Stack/provider/connector changes, explicitly authorized for
implementation in this chat. Canonical checkouts and unrelated task branches are
preserved. No change to the MRN monorepo/manifest or a client theme is needed.
Candidate versions are Dashboard **0.13.13** and Child **0.3.4**. Merge/release versions must be reconciled with concurrent work before packaging.
Only committed, QA-qualified immutable packages may enter production.

## Before requesting production approval

1. Finish the three task-scoped source reviews, tests and applicable MRN QA.
   Include inherited analyzer/dependency findings and every skipped runtime row.
2. Accept/commit/merge the exact source through normal repository gates, then
   qualify versioned Dashboard/Child ZIPs, contents manifests and SHA-256 values.
   Do not use a working-tree ZIP as an installed release. The production-only npm audit is clean. The full developer dependency audit retains baseline advisories; track those through the normal release/security process. No lockfile or pinned runtime was silently upgraded by this feature.
3. Build an immutable replacement MCP pin from the accepted commit, run the
   compatibility suites/fresh-process fixture, and prepare a rollback script.
   Preserve the current `5bf4f80…` pin. Prepare only the four named allowlist
   additions from `EMAIL-ADDRESS-AUDIT.md`; preserve every existing tool, namespace,
   confirmation flag, safe-mode setting and credential byte. No duplicate entry.
4. Resolve a small **explicit** pilot URL set with Kyle. A proposed first target
   is MRN's company site; this proposal does not select or authorize it. Record
   the exact Dashboard/child identities, installed baselines, package checksums,
   health checks, backup operations and rollback packages in the final review.
5. Request approval of that concrete Dashboard update, named child-agent pilot,
   local MCP pin/policy switch, and read-only pilot audit. The prior maintenance
   or private-storage approvals do not authorize these different packages.

## After that explicit approval

1. Verify `mainwp://status`: connected, authoritative host, nonzero catalog.
   Re-resolve exact Dashboard and pilot identities; use native scoped sync and
   confirm plugin baselines. Honor newly applicable verified site constraints.
2. Take a new labeled, remote-verified Updraft database backup **for each package
   write**, with its own valid native receipt. Use the existing reviewed package
   installer/checksum/confirmation path. Dashboard self-update uses its supported
   approved release path; any one-time authenticated upload limitation must be
   stated rather than bypassed through SSH or arbitrary snippets. A WAF exception
   is a separate review, never implicit in plugin approval.
3. Install the Dashboard provider **only on wpcontrol**, then verify installed
   version/files and both new abilities' closed schemas/annotations/permissions.
4. Install the child-agent package **only on approved pilot sites**, preserving
   activation and unrelated plugins/options. Independently verify installed
   hashes/version, public health and the native audit protocol. No maintenance
   guard enrollment, retention correction or deployment-storage write is part of
   this audit-reader upgrade.
5. Atomically switch the existing global `mainwp` entry to the qualified pin and
   apply only the approved four-tool policy additions with concurrent-edit guards
   and a non-secret policy backup. Keep settings `0600`; never print/copy the
   application password into backups, scripts or reports. If deployed elsewhere
   through an MRN Google gateway, its separate tool/role policy and artifact
   delivery must also be reviewed before claiming team availability.
6. Start a **fresh MCP process**. Verify all previous tools plus exactly four new
   tools, correct host, unchanged restrictions and correct read-only behavior.
   Restart/reconnect the existing MainWP server in Codex and Claude Code/Desktop
   Code mode as applicable; cached chats may retain the old catalog. A local pin
   switch alone does not prove the running client refreshed.
7. Audit the explicit small set. Independently compare matching configuration
   evidence through supported native readback on those sites, including at least
   a real form notification and inherited reference where present. Send no mail
   and make no form submission. Stop on a contract/permission/privacy failure.

## Fleet phase and requested address search

Only after pilot acceptance, prepare the full exact-site manifest from current
inventory. The latest read-only inventory check returned **106** sites; the
approved fleet manifest must use the then-current count and flag additions or
removals for review. Installing the reader across sites is a fleet **write** and
requires its own exact package/target approval and fresh per-site backups. Sites
where rollout is unavailable remain explicit unsupported/failed entries; never
use SSH or snippets to fill those gaps.

Once the Dashboard, reader distribution, MCP policy and client refresh are
authorized and verified, run:

```json
{ "address": "maintenance@mrnwebdesigns.com", "scope": "fleet" }
```

Resume bounded batches to `finished:true`. Review failures/incomplete coverage,
then export both JSON and CSV+coverage sidecar. Return a concise **verified
matching-site list**, distinguish enabled/current from disabled/historical
references, and show inspected/matched/unmatched/incomplete/failed counts. Explain
the limits of “every use.” There is no live matching-site list at source-review
time because the new providers are not installed.

## Rollback and distinct completion states

- Source implemented/tested: branches, diffs, fixture and QA evidence exist.
- Hosted deployed: correct Dashboard and named child package hashes read back.
- Tools available: refreshed client discovers exactly the approved catalog.
- Operationally verified: named pilot matches independently agree with native
  configuration and no write/mail operation occurred.
- Fleet delivered: current inventory scope reconciled, each site has an explicit
  coverage result, and downloadable real audit artifacts exist.

Roll back the local connector by restoring the prior pinned command/args and
non-secret policy fields atomically while preserving current credentials and
unrelated concurrent edits, then reconnect and rediscover tools. Dashboard and
Child package rollback use retained prior immutable ZIPs, fresh verified backups,
exact confirmation and installed/public proof. No settings migration or new
child-side audit state needs reversal. Local sanitized artifacts can be retained
or removed by the owner; no cloud/public report or remote credential was created.
