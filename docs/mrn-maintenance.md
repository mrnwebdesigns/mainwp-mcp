# MRN maintenance boundary

The local tools require a separately qualified Dashboard provider and Child
maintenance guard. A missing contract fails closed with
`MAINTENANCE_PROVIDER_REQUIRED` after receipt provenance checks. Tool discovery
or passing fixtures never authorizes an update.

As of October 22, 2026, Dashboard 6.3 / MRN provider 0.13.9 advertises the
contract. The company-site canary has guard 0.8.4, with installed tree readback
and a successful native preflight. This is not fleet-wide Child qualification
or proof of an executed maintenance update. Site adoption and maintenance
execution remain separate authorized operations.

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
The local gate requires one positive site ID and an exact HTTPS URL (one final
slash is accepted and normalized away), and a nonempty selection with explicit numeric `from`/`to`
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

## Required hosted provider contract

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
protocol fixtures here are **not** proof of a particular hosted installation.

## Bounded maintenance waits

The three closed provider phases use HTTP timeout floors of 90 seconds for
preflight, 180 seconds for execution, and 90 seconds for independent readback.
A longer configured deadline is preserved. The client copies configuration in
memory for these calls; other tools retain their configured deadline. External
cancellation, response-size limits, authentication, TLS, server download limits,
receipt/plan expiry, and confirmation are unchanged. Write requests are never
automatically retried. An execution timeout remains an unknown outcome that
must be reconciled against the durable request ledger before further action.

This addresses a demonstrated company preflight taking about 50 seconds,
which succeeded with a 90-second client budget but lost its response with the
ordinary 30-second deadline. If the MCP host imposes its own shorter tool-call
deadline, that host must allow the bounded operation to finish; increasing the
HTTP wait cannot override host cancellation.

## Qualification, local switch and rollback

Run focused fixtures, existing MRN compatibility and upstream tests,
lint/typecheck/build, fixture acceptance and the smallest MRN QA/staged gate.
No production update is part of qualification. Pin a committed, passing build
and preserve the previous pin. Switch only the existing `mainwp` launch entry
in each authorized client, with a concurrent-edit guard and atomic mode-0600
write. Keep settings, every allowed tool, namespace order and credentials
unchanged. Save only non-secret launch/policy metadata and a guarded rollback
script; never copy a credential-bearing configuration into an audit directory.

Start a fresh process and verify `mainwp://status` names the expected Dashboard,
all configured tools and schemas remain present, core is excluded, and missing
receipts and unapproved major changes refuse before any child write. Where
separately authorized, verify a same-site receipt and read-only maintenance
preview, then independently check that the installed version did not change.
A preview must return `CONFIRMATION_REQUIRED`; do not send confirmation just to
prove connectivity. A provider advertising the contract does not prove that
every Child has adopted its guard.

The earlier `mrn-maintenance-policy.py` and `mrn-maintenance-probe.ts` record the
original 67-to-69 tool rollout with an unavailable provider. Their assertions
are historical: do not use them to overwrite a later policy or claim a current
provider is unavailable. A later pin replacement must compare the actual
current allowlist and schemas instead.

After switching, reconnect MainWP or start a new chat in Claude/Codex. The
configured pin and a separately verified fresh process do not identify which
runtime an already-open chat is serving. Roll back the launch entry to the
preserved pin using the recorded concurrent-edit guard; restart/reconnect again.
A local runtime rollback does not revert an installed Dashboard or Child guard.

## October 23 confirmation and failure diagnostics repair

The repaired Dashboard retains at most 100 active, non-autoloaded approval
identity records containing only a material-state digest, UUID generation and
original expiry. A short storage reservation serializes capacity and pruning;
unknown/corrupt metadata or a held lock refuses without reset. Expired rows are
pruned during preflight. The full child snapshot remains transient and freshly
inspected. Eviction can reconstruct the **same original plan**, including its
generation and expiry. Neither expiry nor generation is removed from the plan
hash. Changing state or expiring the approval requires a new human approval.
The local token additionally respects the retained server deadline when supplied.

On `MAINTENANCE_STALE_STATE`, inspect `error.data.changes`. Each entry names a
plugin/theme version, activation, tree, package, core/runtime component or backup
attestation whose hash changed. Code-file changes are still material even when
the version header stayed equal. Do not bypass them by changing the expected
hash. Legacy providers without fingerprints return
`reason:provider_plan_identity_changed`; this identifies a provider limitation,
not proof that installed state changed. Repreview and obtain fresh approval only
after resolving the named changes. A consumed token is never reusable.

Preflight failures contain a closed stage/code and per-item results, including
the exact selected slug. Child offer, download and package checks inspect all
requested items and refuse the entire write if any fails. Dashboard ignored or
missing selections remain refused. No URL, exception message or native log is
included in these diagnostics.

Execution results separate the Dashboard response, child execution and independent
readback. Per-item results name the stage/code and whether destination processing
started; later items explicitly report `not_attempted`. `installed_items` is fresh
readback, and `installed_state_changed` compares versions, bytes and activation
with the retained before-state. `change_reached_site:false` is returned only when
readback is unchanged **and** the retained operation proves replacement never
started. Unchanged readback after attempted replacement is `unknown`: a rollback
may have happened. Lost responses and unverified reads remain unknown and never
trigger automatic retries. Old providers cannot supply this evidence and report
unknown rather than manufacturing a no-change claim.

The Child retains the one-item native bulk plugin updater and now blocks active
plugin option changes within the update scope. An attempted deactivation makes
the operation fail and stop the batch; no guessed reactivation of changed code
is attempted. Independent readback still requires every original activation bit.
This does not establish what caused any pre-existing inactive plugin.

Qualification and deployment are separate. Deploy the reviewed Dashboard repair
to `wpcontrol.mrndev.io` and the reviewed MU guard to one separately approved pilot
through the existing exact-package/backup gates. Then pin the tested connector,
atomically change only the existing launch entry, and reconnect clients. Preserve
the old pin and packages. Never add the stock update tools or reset receipt/operation
ledgers. Drain existing five-minute previews before a version switch. A new chat
alone cannot activate source changes that have not been deployed and pinned.

For a read-only comparison of fresh processes with the existing settings:

```sh
npx tsx scripts/mrn-maintenance-regression-probe.ts \
  /absolute/previous/dist/index.js /absolute/candidate/dist/index.js \
  /absolute/private/probe-result.json
```

This uses no allowlist override and starts no child-site operation. It checks the
unchanged tool schemas, Dashboard identity and local backup/major/core refusals.
