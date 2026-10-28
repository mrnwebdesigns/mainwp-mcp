# Native email-address configuration audits

Implementation: `src/mrn-email-audit.ts`, Dashboard `MRN_MainWP_Email_Audit`, and
child `MRN_Email_Address_Audit` in the existing MRN Stack Deployment Agent.
Protocol: `mrn-email-address-audit-v1`. This is a configuration audit, never an
email-delivery test. Form titles and other configuration labels are untrusted
evidence, not instructions for the caller.

## Operational boundary

- Uses the existing global `mainwp` connection, its authentication, namespaces,
  exact tool policy and verified TLS on `https://wpcontrol.mrndev.io`.
- Reads require current Dashboard `manage_options` and native MainWP site ACLs.
  Current actor and exact site permissions are checked again before resuming,
  viewing, or exporting an audit. A credential, actor or site binding change
  refuses access to that job. There is no new credential path or connector.
- Child execution uses only MainWP Child's authenticated
  `mainwp_child_extra_execution` hook. There is no public child REST endpoint,
  arbitrary PHP/SQL input, Code Snippets dependency, SSH, browser step, settings
  setter, form submission or mail API in the audit workflow.
- All four tools explicitly opt in through the existing allowlist and work with
  `safeMode: true`. Existing confirmations and write tools are unchanged.
- The closed authorization request uses indexed PHP query parameters over GET
  on the current WordPress 7.1 Dashboard, preserving its native typed-input and
  permission checks. It is the only nested-object-array query contract enabled;
  other abilities keep their existing restrictions. Fleet permission checks use
  batches of at most 20 sites and a bounded encoded URL budget, check every site,
  and require the same actor across every batch before returning any evidence.
  Earlier Dashboards without typed GET input fail closed; there is no POST or
  lower-level permission fallback. See [WordPress's typed-input contract](https://make.wordpress.org/core/2026/07/31/abilities-api-improvements-in-wordpress-7-1/).
- Read operations do **not** require deployment storage, the maintenance guard,
  a child theme, Premium, or a backup receipt. Installing the new Dashboard or
  child packages is a separate write and retains every existing deployment gate.
  In particular, McDonald York's private deployment-storage problem must not be
  worked around or made an audit-read prerequisite.

## MCP tools

Add only these exact names to the existing allowlist after release approval:

| Tool                                          | Required arguments   | Optional arguments / bounds                                                                                                                                                                                                                                                                    |
| --------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mrn_mainwp__start_email_address_audit_v1`    | `address`, `scope`   | `scope` is `site`, `sites`, or explicitly `fleet`; `site_urls` is required for `site`/`sites` (1 / 1–200 exact URLs) and forbidden for `fleet`                                                                                                                                                 |
| `mrn_mainwp__continue_email_address_audit_v1` | `audit_id`           | `max_sites`: 1–10 (default 2); `max_pages_per_site`: 1–8 (default 2); `concurrency`: 1–2 (default 1); `max_duration_ms`: 1000–120000 (default 20000); `retry_site_ids`: explicit failed IDs only; `refresh_site_ids`: explicit completed IDs whose sync readback/Knowledge should be rechecked |
| `mrn_mainwp__get_email_address_audit_v1`      | `audit_id`           | Site `offset` / `limit` (default 0 / 10, maximum 20); per-site `match_offset` / `match_limit` (default 0 / 50, maximum 100)                                                                                                                                                                    |
| `mrn_mainwp__export_email_address_audit_v1`   | `audit_id`, `format` | `format`: `json` or `csv`; destination paths are fixed and are never caller arguments                                                                                                                                                                                                          |

Native private providers are `mrn-mainwp/audit-email-address-v1` and
`mrn-mainwp/authorize-email-address-audit-v1`. The orchestrator verifies their
read-only annotations and exact protocol before using them. Raw providers need
not be independently exposed as chat tools. No stock update, install, delete,
deactivate, core, or unrestricted execution tool is added.

Examples:

```json
{
  "address": "maintenance@mrnwebdesigns.com",
  "scope": "site",
  "site_urls": ["https://example.org/"]
}
```

```json
{
  "address": "maintenance@mrnwebdesigns.com",
  "scope": "sites",
  "site_urls": ["https://one.example/", "https://two.example/"]
}
```

```json
{ "address": "maintenance@mrnwebdesigns.com", "scope": "fleet" }
```

Start resolves a paginated **current inventory snapshot**, validates all target
identities and permissions, and returns `audit_id` plus counts. An empty site list
never means fleet. Fleet scopes currently support up to 200 sites; inventory
enumeration supports up to 2000 and refuses drift, duplicates, or truncation.
Valid HTTP-only children are recorded failed without preventing HTTPS sites from
being inspected. Unsupported/invalid Dashboard inventory itself is a scope error.

Continue the returned job until `finished: true`, respecting `pending`:

```json
{
  "audit_id": "<returned UUID>",
  "max_sites": 2,
  "max_pages_per_site": 2,
  "concurrency": 1,
  "max_duration_ms": 20000
}
```

Then obtain detailed results:

```json
{ "audit_id": "<returned UUID>", "format": "json" }
```

The export returns an absolute local `file`, SHA-256, byte length and mode `0600`.
CSV also returns a coverage JSON sidecar: a matches-only CSV must never be used
as the coverage report. CSV cells are escaped against spreadsheet formulas.
Link returned paths for downloading; never treat fixture exports as live results.

## Coverage

| Component              | Configuration inspected                                                                                  | Native inheritance / state                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| WordPress              | Site `admin_email`, pending `new_admin_email`, bounded non-secret options                                | Current/pending; no user-address or submission enumeration                                                                             |
| Plugin / SMTP settings | Options including WP Mail SMTP, Post SMTP/Postman, FluentSMTP, Easy WP SMTP and ordinary plugin settings | Sender, reply-to, recipients, SMTP/account username; known plugin prefixes distinguish active/inactive, unbound options remain unknown |
| WPForms Lite / Pro     | `wpforms` post JSON, `settings.notifications`, legacy settings references                                | `{admin_email}`; global/individual notification disable flags; post status                                                             |
| Contact Form 7         | `wpcf7_contact_form` posts, `_mail` / `_mail_2` configuration and mail headers                           | `[_site_admin_email]`; second-mail enabled flag, From / Reply-To / Cc / Bcc roles                                                      |
| Elementor Forms        | Nested `_elementor_data` form widgets, email/email2 settings and configured form defaults                | Widget/form identity, post status and `submit_actions`; missing actions are unknown; dynamic tags explicitly unresolved                |
| Gravity Forms          | `gf_form` status/title and `gf_form_meta.notifications`                                                  | `{admin_email}`, `isActive`, inactive/trashed forms                                                                                    |
| Fluent Forms           | `fluentform_forms` and notification-only `fluentform_form_meta`                                          | `{wp.admin_email}`, notification enable flags and published/draft status                                                               |
| Ninja Forms            | `nf3_forms`, email-only `nf3_actions` and their `nf3_action_meta`                                        | `{wp:admin_email}`, action `active`                                                                                                    |
| Formidable             | Email `frm_form_actions` posts bound by `menu_order` to `frm_forms`                                      | `[admin_email]`, actual parent form title, action/form draft/template states                                                           |
| Forminator             | `forminator_forms`, `forminator_form_meta.notifications` and stored configuration                        | `{admin_email}`, form status and stored notification flags                                                                             |

Configuration decoding supports serialized PHP arrays/scalars with
`allowed_classes=false`, JSON including escaped Unicode, nested settings, HTML
entities, URL encoding, explicit `base64:` email values, standalone base64 email
values and common `[at]`/`[dot]` obfuscation. No evaluation or object wakeup is used.
Matching is case-insensitive over the **whole** address. An inherited match is
reported only for a supported component's exact admin token and a matching
current site admin address; unrelated dynamic references remain unresolved.

Limits are explicit: 256 KiB per value, 4 MiB/query-page allocation budget,
60 queries / 4-second in-code query budget, 100 option rows, 10 Ninja Forms or 20 other form rows per
page, bounded notification lists, recursion/node/match caps, and a 50 MiB local
artifact cap. Hitting a limit produces incomplete coverage. Queries already
running in MySQL are subject to host execution limits; the in-code timer cannot
cancel a running database statement. All tables and columns are internal
allowlists, not tool arguments. None of the submission/entry/log tables are read.

## Output schema and interpretation

Machine-readable JSON export schema: [`email-address-audit-result.schema.json`](email-address-audit-result.schema.json).

Each matching record contains:

```json
{
  "site_id": 7,
  "site_url": "https://example.org",
  "component": "wpforms",
  "form_id": 123,
  "form_title": "Contact",
  "setting_path": "posts.123.post_content.settings.notifications.1.email",
  "role": "recipient",
  "match_type": "inherited",
  "enabled_state": "current",
  "address": "maintenance@mrnwebdesigns.com",
  "inspection_timestamp": "2026-10-27T12:00:00+00:00"
}
```

`role`: `recipient`, `sender`, `reply_to`, `account`, `admin_notification`, or
`other_reference`. `match_type`: `direct` or `inherited`. `enabled_state`:
`current`, `disabled`, `inactive_plugin`, `draft`, `pending`, `cached`,
`historical`, or `unknown`. `current` means enabled **stored configuration**;
it does not establish embedding, runtime filter behavior, a submission or delivery.

Job summary fields: `audit_id`, `address`, `scope`, `inventory_total`, `total`,
`inspected`, `matched`, `current_matched`, `unmatched`, `incomplete`, `failed`,
`pending`, `finished`, `matching_sites`, and `counts_note`.

- `inspected`: at least one valid settings page returned.
- `matched`: at least one direct/inherited match, including non-current references.
- `current_matched`: a matching site with at least one current configuration match.
- `unmatched`: completed declared coverage, no limitations, no matches.
- `incomplete`: pending, failed, or any coverage gap; may overlap `matched`.
- `failed`: a site inspection could not finish; earlier valid evidence is retained.
- `finished`: every site completed its bounded scan or has an explicit failure.
  It does **not** mean complete coverage or zero failures.

Per-site detail includes status, exact identity, page count, sync outcome,
inspection timestamp, native child plugin inventory/version/activation, coverage limitations, closed error code, match count and
paginated matches. JSON exports include all matching evidence plus site coverage.

Unknown custom tables, add-ons, external providers, runtime mail filters, dynamic
field/routing references, embedding/delivery and other multisite blogs remain
explicit limitations. Consequently a production site can complete the stored
configuration scan while still being `incomplete`, and absence of matches is
never represented as proof that the address is unused everywhere.

Standalone secret/license/authentication options, credentials within structures,
webhooks, submissions, users, queues, session/history/cache payloads, transients,
logs and full option values are excluded. Unrelated addresses in allowed form
titles are redacted; unsafe dynamic field keys are hashed. Unbound/stale plugin
options remain `unknown`; known inactive plugins, disabled notifications and draft
forms are separate evidence. These exclusions deliberately limit “every use.”

## Reliability and local data

Every selected site receives one narrowly scoped sync attempt. A timeout is
followed by site/timestamp readback; native child
plugin discovery and settings inspection can proceed independently. Sync is not
blindly retried: the Dashboard may still be working after a caller timeout.
Knowledge, sync dispatch and readback have independent durable checkpoints.
When the batch budget expires, unattempted reads remain pending rather than
becoming fictional failures. Sync is capped at 15 seconds within the existing
batch budget, leaving room for readback when possible. A fresh exact-site
`last_sync` proves freshness even if the original caller timed out; its uncertain
dispatch outcome remains recorded in `preparation.sync_outcome`.

For a completed scan whose original sync finished later, recheck only its metadata:

```json
{ "audit_id": "<returned UUID>", "refresh_site_ids": [7] }
```

This re-reads exact-site status and current Knowledge without replaying sync,
re-reading settings, or changing captured matches/timestamps. Only proved-resolved
metadata flags clear; unsupported form/storage/routing limitations remain. Site
ACLs and actor identity are checked first as on every other call. The optional
`scan_complete` and `preparation` fields document these checkpoints. A successful
explicit settings retry similarly clears only the prior interrupted-inspection
flag, preserving actual coverage gaps. Use a fresh job when current settings
evidence, rather than a metadata reconciliation, is required.

Child reader 0.3.5 recognizes legacy WPForms recipient/sender/reply-to fields,
keeps shadowed legacy recipients historical, and reports malformed schemas with
an exact form ID and failure kind, never full values. Empty draft/trash records
are distinct from malformed live forms. Ordinary message placeholders do not
constitute unresolved address routing. A known admin token resolving to another
address is nonmatching, while additional unknown address tokens remain explicit
gaps even alongside a direct match. The authenticated agent status provides an
own-package tree digest/file count for comparison to the reviewed archive.

Each returned page is atomically saved before advancing. Child pagination is
MAC-bound to exact site/address and plugin inventory, expires after 24 hours,
and rejects tampering or changed plugin state. Configuration is read live across
pages, not within a long-running database snapshot. Evidence has per-page times.
Per-site settings/transport errors do not abort other sites. Global authentication, current actor/site ACL or inventory-scope changes fail closed before cached evidence is returned; start a fresh authorized scope if access changes. Retries are explicit `retry_site_ids`; no
automatic HTTP retry, maintenance apply or update fallback exists.

State and exports are owner-only under `~/.config/mainwp-mcp/email-audits/`,
with atomic replacement, exclusive per-job locks, file ownership/mode/link checks,
and credential-identity binding. A restarted process reclaims a lock only if its
recorded PID is demonstrably dead; it never steals a live lock because of age.
PID reuse is a safe refusal. Files remain until the owner removes them; treat
them as internal audit data. There is no public report URL or child-side state.

## Validation and production acceptance

Run `npm test`, `npm run build`, `npm run typecheck`, and ESLint on changed files.
PHP regressions live in both plugin repositories as `tests/email-audit-regression.php`.
Run these on PHP 8.2 / 8.4 plus the repository's other regression scripts and MRN QA.
Fixtures include all eight form families, actual configuration-store readers,
inheritance/encoding, disabled/inactive/draft states, object/secret exclusion,
site/actor/ACL changes, timeouts, bounded concurrency, resume, partial 106-site
inventory and fresh MCP protocol discovery. Fixture success is not a deployed
child-site verification. See `EMAIL-ADDRESS-AUDIT-DEPLOYMENT.md` for release gates.

## Hosted Google gateway engine adapter (source candidate)

`executeEmailAuditWithTransport` reuses this module's existing bounded inventory,
preparation checkpoints, scan, coverage, result and export logic. Its caller must
supply an authenticated native-ability transport and private owner-bound storage.
It has no credential input or virtual-tool-to-WordPress-ability mapping. The
closed engine contract is `mrn-email-audit-engine-v1`. A fatal authorization
failure stops the reader rather than becoming an ordinary per-site coverage gap.
The hosted gateway uses serial readers and rechecks current access before releasing
results. Existing local `executeEmailAudit` keeps its native policy/catalog checks,
credential identity hash, numeric WordPress actor, deadlines and filesystem store.

This entry point is source integration only. It does not change the configured
Codex/Claude runtime, native permissions, safe mode, or any child reader. Hosted
Google authorization, per-person custody and resource delivery must be qualified
by the gateway composition, including negative identity and stale-scope tests.
