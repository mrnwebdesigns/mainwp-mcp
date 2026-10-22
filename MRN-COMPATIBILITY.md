# MRN MainWP MCP compatibility

This fork is based on official MainWP MCP **v1.5.1**, commit
`6d63bd95b2c57740158fa78800384873c8f0a40d`, the latest stable release verified
on October 15, 2026. The previous MRN runtime was based on v1.3.0 and pinned at
`3249bde643f52f29b7b18db41f4c3c7bb88d2434`.

## Remaining patches

The package-size compatibility patch raises the ceiling for schema-declared
strings to **69,905,068 characters**, the exact padded base64 length of a
**50 MiB (52,428,800 byte) ZIP**. Upstream's 64 MiB character ceiling would
reject the top of MRN's supported Stack and MU deployment range.

The undeclared-string default remains 10,000 characters. Tighter declared
limits remain effective, including the separate 25 MiB plugin upload contract.
An excessive schema declaration cannot raise the ceiling further. GET/DELETE
URL limits remain unchanged. No outbound package is truncated or recompressed.

The previous MRN patches for schema-aware limits, nested-array validation, and
schema-declared string identifiers are supplied upstream in this release;
their implementations are not reapplied. No Dashboard plugin changes are needed.

The subsequent MRN maintenance gate adds only the two explicitly allowed local
plugin/theme tools described in [the maintenance contract](docs/mrn-maintenance.md).
It preserves receipt provenance, exact versions, preview/confirmation and
independent readback. Its three closed provider phases use bounded timeout
floors of 90/180/90 seconds without changing other tools' configured deadlines.
Core and unguarded stock updates remain excluded.

## Preserved policy and provider contracts

The existing global `mainwp` entry uses an immutable local Git pin. It continues
to load owner-only settings, the same credentials, `mainwp` and `mrn-mainwp`
namespaces, an explicit allowlist, and required user confirmation. No second
MCP configuration entry is created.

All existing MRN allowlisted tools remain enabled. Their provider schemas and
implementations continue to enforce target restrictions, SHA-256 checksums,
QA admission, fresh verified backup receipts, and private rollback storage.
The MCP forwards the reviewed inputs intact; it does not replace server-side
authorization or full JSON Schema validation.

For destructive abilities that support `dry_run`, upstream obtains a preview
before issuing a short-lived confirmation token. For MRN install/rollback
abilities without `dry_run`, it issues a token without calling the provider
and explicitly requires the agent to describe the reviewed plan and obtain
human authorization. The existing preflight/inspection tools provide that
review evidence. The token binds the exact target, plan, checksum, and receipt
arguments; changes require a new review. Tokens are single-use and expire.
Named confirmation flags retain upstream's fail-closed behavior.

## Knowledge access

The installed MainWP Dashboard **6.3** was verified read-only and advertised
all seven Knowledge abilities. The allowlist adds only:

- `get_knowledge_record_v1`
- `get_site_knowledge_v1`
- `get_client_knowledge_v1`
- `list_knowledge_v1`
- `create_knowledge_record_v1`
- `update_knowledge_record_v1`
- `delete_knowledge_record_v1`

Writes remain destructive and require exact-content preview and human
confirmation. Agent-created records are marked unverified by the Dashboard;
enabling these tools does not confer human verification or make Knowledge
content an instruction that overrides user or system policy.

## Verification and activation

`src/mrn-compatibility.test.ts` covers the complete upload boundary, tighter
limits, namespace discovery and allowlisting, string operation identifiers,
backup/checksum/target approval binding, exact deployment/rollback transport,
Knowledge preview/confirmation, replay rejection, and safe mode. These write
tests use mocked transport only. The normal upstream suite additionally tests
named confirmation, Knowledge restrictions, pagination, cancellation, and
response redaction. Run the upstream release checks and MRN staged QA before
creating an immutable runtime pin.

After changing the existing launch path, a separate short-lived MCP client can
verify the replacement using resource reads, tool listing, and read-only tools.
That proves the new pin works; it does not prove an already-running Codex MCP
process has restarted. Check the serving process path and restart the MainWP
MCP connection in Codex to activate the new launch path for that process.

No Dashboard updates, child-site changes, or production write tests are part
of this upgrade. Runtime dependencies have no reported production advisories
at qualification time. Upstream's optional development MCPB bundler has
development-only audit findings; it is excluded from the pinned runtime.

## Rollback

Retain the previous immutable pin. Restore only the `args` path in the existing
`[mcp_servers.mainwp]` section to that pin's `dist/index.js`, then restart the
MainWP MCP connection. Remove only the seven newly added Knowledge allowlist
names if rolling the policy back too. Preserve credentials, all previous
allowlisted tools, namespace order, and `requireUserConfirmation: true`.
The local upgrade evidence directory contains a nonsecret policy snapshot and
a guarded rollback script; it never stores credential-bearing settings copies.
