# MRN transport dependency repair

This source candidate starts at the exact CI transport
`16a0e1e719077deb98f8d3b9a0ca57e85b301406`. It does not replace the separately
configured local transport, merge other maintenance branches, or authorize a
Dashboard/client-site change. Select a tested exact Git commit plus its lockfile
for subsequent integration qualification; do not use an unpinned npm install as
the release identity.

## Runtime dependency changes

- Add exact direct `zod: 4.6.7`, resolving the SDK's existing compatible peer to
  the patched release instead of transitive 4.6.5.
- Refresh only compatible transitive `ip-address` 10.7.2 to 10.7.4 in the lockfile,
  within `express-rate-limit`'s existing `^10.2.0` range.
- Keep SDK 1.32.1, Undici and all application runtime source unchanged.
- Add a required CI `npm audit --omit=dev` step, with no severity exemption or
  audit suppression.

The reviewed Zod advisory is
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)
(affected below 4.6.6). The compatible IP parser repair addresses
[GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).
Dependency presence is not a claim that a particular production path was
exploitable.

## Compatibility evidence

- 3,155 tests passed on Node 20.20.2, 22.23.4 and 26.0.0. Coverage on Node 26
  passed required thresholds: 96.57% lines, 96.13% statements, 93.71% branches,
  98.09% functions.
- New actual-SDK/in-memory-wire tests preserve opaque URL/content bytes, nested
  structured rows, both namespaces, string operation IDs, tool schemas and
  exact-input confirmation. Altering the target URL invalidates approval before
  any mocked Dashboard POST; malformed protocol shapes are rejected.
- Existing MRN tests retain 50 MiB/69,905,068-character package support, tighter
  declared limits, exact allowlists, backup/checksum-bound approvals, rollback,
  maintenance gates, safe-mode behavior and no unguarded stock updates/core.
- Fresh packed fixture: 39 scenarios passed; 6 live-only scenarios intentionally
  skipped (themes, update inventory, client count, tags, sync and plugin toggle).
  No production credentials or target are used. Fixture writes are confined to
  the in-process fake Dashboard.
- MCP bundle built/validated and a fresh extracted process passed fixture tool
  discovery. Independent inspection of actual ZIP entries found Zod 4.6.7 and
  ip-address 10.7.4 and no development mcpb package.
- Formatting, lint, typecheck, version/plugin/skill consistency and build passed.
  Applicable MRN QA and staged commit proof are recorded separately by the
  task's audit report; this document is not a deployment/signing certificate.

The transport application has no direct Zod URL validator: Dashboard setup and
MRN site identity use existing manual URL checks. SDK tool arguments remain
opaque structured values. The tests do not relax provider/gateway identity or
content validation, nor do they assert arbitrary URLs are authorized.

## Development dependency limitation

Runtime-only audit reports zero findings. Full audit still reports 12 affected
development packages (3 low, 3 moderate, 6 high). In particular, the registry's latest
`@anthropic-ai/mcpb` 2.1.2 requires `zod:^3.25.67`, resolving to 3.25.76. It imports
Zod directly for build-time manifest validation. There is no compatible patched
version for that declared major range in the inspected registry. No forced major
override, broad dependency upgrade or audit suppression was applied. Other
pre-existing development advisories include the Vitest/Vite toolchain and bundle
builder transitive packages. Full dependency security clearance remains open.

The bundle builder uses repository-owned test manifests locally; it is not
installed or staged into the production runtime. This limits the dependency's
role and does not remediate its development advisory. Do not accept untrusted
bundle manifests or publish this as full dependency clearance.

## Adoption and rollback

This task changes source only. A later integration candidate must independently
qualify this exact transport together with its selected gateway/provider/runner
commits. Global Codex/Claude configuration, settings, credentials, installed pin
folders and running MCP processes remain unchanged; no reconnect is needed for
this source-only commit. Adoption, any access/registration change, and live
verification retain their separate gates.

To discard this candidate, leave the existing pin selected. For source rollback,
use the recorded parent 16a0e1e commit in a new isolated qualification; do not
rewrite another task's checkout or downgrade an installed runtime automatically.
