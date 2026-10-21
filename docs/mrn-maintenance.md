# MRN maintenance boundary

This change adds a **local client gate**, not a deployed maintenance provider.
The installed Dashboard 6.3 / MRN provider 0.13.8 cannot satisfy its execution
contract. **Plugin and theme maintenance is not restored yet.** The new tools
fail closed with `MAINTENANCE_PROVIDER_REQUIRED` after receipt provenance checks.
Do not treat tool discovery or passing fixtures as permission to run updates.

## Provenance and policy

The October 12 code-edit pilot constructed the allowlist from read tools and
named MRN pilot operations. Kyle approved that policy at 23:19 UTC; the local
settings write occurred at 23:26 UTC. Session evidence is in
`rollout-2026-10-08T09-16-22-01a11ba8-621b-7fc3-8cfc-433a976215b6.jsonl`,
records 10583, 10708 and 11092. The corresponding non-secret proposal and applied
record are under the provider repository's ignored
`reports/deployment-2026-10-12/` directory. This was a local settings change,
not a tracked MRN/MCP source commit. Routine updates were omitted by the
read-tools-plus-pilot construction; no separate maintenance ban was found.
The October 15 upgrade appended seven Knowledge tools and retained that policy.
Kyle separately approved revising the exclusion in this task.

`safeMode:false` remains because the reviewed existing code operations require
it. Safe mode true blocks both those operations and Dashboard 6.3 stock updates,
which now advertise `destructive:true`. Confirmation, namespace order, all 67
existing tools, credential bytes, and upload limits remain unchanged. Exactly
two local tools are opted in:

- `mrn_mainwp__maintenance_plugins_v1`
- `mrn_mainwp__maintenance_themes_v1`

No stock update, batch, core, delete, activate, deactivate, or install tool is
added. Existing previously allowed tools remain present. There is no fallback
from these tools to stock updates, arbitrary API calls, PHP, SQL, SSH or package
installation. Safe mode or an explicit block still prevents the local tool.

## Why a local stock wrapper cannot safely execute

Stock `update_site_plugins_v1` and `update_site_themes_v1` accept a site and
slugs, but no receipt or expected versions. The Child updater refreshes offers
with `wp_update_plugins()` immediately before selecting packages. The MCP's
upstream update-plan documentation explicitly permits a newer offer to replace
the previewed version. Checking leading digits locally, then sending slugs,
cannot prevent an unreviewed major update in that interval.

The existing custom optional/Stack plugin updates validate a same-site server
receipt, use a two-hour transient, compare fresh inventory/preconditions, and
verify pinned packages. They cover their restricted MRN packages, not general
plugins or themes. They do not exclude leading-digit changes. Their Updraft
receipt issuer accepts generic completion text; the existing read-only backup
history explicitly returns `remote_objects_verified:false`. Neither is an
independent remote-object check. No mutation, cleanup, or Code Snippet is used
to obtain that missing evidence.

## Local contract and examples

Obtain a receipt through the existing `mrn_mainwp__get_database_backup_status_v1`
in this **same MCP process and principal**. Receipts are retained only as
identity-scoped hashes with bounded wall-clock and monotonic expiry. A restart
requires a new status read. Caller-supplied text is never trusted as receipt
provenance. The server must independently validate and consume the receipt too.

Read the exact URL and current versions with existing MainWP discovery tools.
The local gate requires one positive site ID, canonical exact HTTPS URL without
a trailing slash, and a nonempty selection with explicit numeric `from`/`to`
versions. Unknown versions, downgrades, duplicate or expanded selections, core
inputs, and implicit all-sites/all-items requests fail closed.

```json
{
  "site_id": 123,
  "site_url": "https://example.com",
  "items": [{ "slug": "example/example.php", "from": "6.35", "to": "6.36" }],
  "backup_receipt": { "site_id": 123, "nonce": "012345abcdef", "receipt": "<issued receipt>" }
}
```

For themes use the theme tool and a theme stylesheet slug. Major theme updates
are refused. Major plugin updates require one explicit override for each exact
plugin/version pair; there is no blanket `allow_major` boolean:

```json
{
  "major_overrides": [
    {
      "slug": "example/example.php",
      "from": "6.35",
      "to": "7.0",
      "reason": "Kyle explicitly approved this exact plugin upgrade."
    }
  ]
}
```

Only a qualified server preflight produces an executable preview. Show that
exact preview to the user. Repeat its identical request with `confirm:true`,
`user_confirmed:true`, and `confirmation_token` after explicit human approval.
The local token expires in at most five minutes, binds all request values and
the server plan hash, and is consumed synchronously before any awaited work.
Changed state requires a new preview. Logs contain request/plan identities,
never receipts or arbitrary provider response content. Partial, lost-response,
and readback failures never become success or trigger automatic retries.

## Required hosted provider work — NOT implemented or deployed here

Three dedicated, reviewed abilities must advertise
`meta.mrn_maintenance_contract = mrn-maintenance-exact-versions-remote-updraft-v1`:

1. `mrn-mainwp/preflight-maintenance-v1`: POST, non-destructive. Accept the
   structured normalized request from `src/mrn-maintenance.ts`. Resolve the
   exact site/URL, enforce the user's site/update permissions, fresh-sync it,
   respect ignored updates, independently inspect its native labeled DB-only
   backup and remote objects using the existing Updraft storage connection,
   validate the unexpired same-site stored receipt, and retain a frozen plan.
   Return `contract`, `ready:true`, `site_id`, `site_url`, `kind`, exact sorted
   `items`, `input_sha256`, `plan_sha256`, and `backup`. The input digest is SHA256
   of JSON.stringify of the normalized request in the client's declared order.
   Backup fields are `provider:"updraftplus"`, `site_id`, `nonce`,
   `receipt_sha256` (SHA256 of JSON.stringify of the opaque receipt string),
   `database_only:true`, `remote_verified:true`, `completed_at`, `expires_at`.
   Times are UTC epoch milliseconds; expiry must be within two hours of actual
   backup completion. A status read cannot renew the backup's age.
2. `mrn-mainwp/execute-maintenance-v1`: destructive POST, non-idempotent transport.
   Accept the same request plus `plan_sha256`, unique UUID `request_id`,
   `confirm:true`. Under a same-site lock validate current permissions, frozen
   plan, receipt, backup remote evidence and every expected version again.
   The authenticated Child **must enforce expected versions and target package
   versions at the upgrader boundary**, not after installation. Refuse a missing
   Child guard. Consume the backup nonce once across all callers/processes.
   Preserve unrelated plugins/themes, active states, core, and ignored updates.
   Retain an idempotent durable request ledger even on ambiguous outcomes;
   retries must reconcile, never repeat a write. Return the contract, site ID,
   exact URL, request ID, plan hash and `status:"complete"` only on full success.
3. `mrn-mainwp/read-maintenance-state-v1`: read-only GET, non-destructive.
   Independently read fresh authenticated Child state for exact site/kind/slugs,
   `request_id` and `plan_sha256`; require the matching retained before-state.
   Return `contract`, `site_id`, `site_url`, `kind`, the same `request_id` and
   `plan_sha256`, sorted `items` as
   `{slug,version}`, `unrelated_unchanged:true`, and `core_unchanged:true` only
   when independently verified against the retained before-state. Failure to
   prove these invariants is a partial/unverified result.

All backup-receipt inputs must be write-only in the hosted schemas. Public
helpers stay outside the MCP allowlist; the compiled local gate can invoke
only these exact three helper names under its own existing policy boundary.
Merely adding the contract string to an old updater does not implement it.
Native provider/Child qualification is mandatory before deployment; the
protocol fixtures here are **not** proof of that future implementation.

## Qualification, local switch and rollback

Run focused fixtures, the Python policy tests, existing MRN compatibility and
upstream tests, lint/typecheck/build, and the smallest MRN QA/staged gate. No
production update is part of qualification. Pin a committed, passing build;
preserve the previous pin. `scripts/mrn-maintenance-policy.py apply --pin <pin>
--evidence <owner-only-directory>` changes only the launch pin and two exact
allowlist additions. It uses mode-0600 atomic writes with concurrent-edit
guards and stores only non-secret policy/launch metadata. The generated
`rollback.py` refuses subsequent policy changes and preserves credential bytes.

Use `scripts/mrn-maintenance-probe.ts` to launch fresh old/new processes, compare
all existing schemas, and prove the exact 67-to-69 discovery delta, receipt and
major refusals, and core exclusion without any child-site request. The probe
also requires the installed provider to report execution unavailable. This is
an explicit current limitation, not a successful update/deployment claim.

After a local switch reconnect MainWP in existing chats. A new tool list does
not repair the missing hosted contract. A separately authorized provider/Child
implementation, native QA, verified backups, deployment, and installed readback
are still required before a maintenance session can perform updates.
