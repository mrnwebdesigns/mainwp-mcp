/** MRN maintenance boundary. No stock update ability is used as an execution fallback. */
import crypto from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { configIdentityHash, executeAbility, fetchAbilities, type Ability } from './abilities.js';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import { decidePolicy, isToolAllowed } from './policy.js';
import { validateInput } from './security.js';

export const MAINTENANCE_TOOLS = [
  'mrn_mainwp__maintenance_plugins_v1',
  'mrn_mainwp__maintenance_themes_v1',
] as const;
export const MAINTENANCE_CONTRACT = 'mrn-maintenance-exact-versions-remote-updraft-v1';
const PREFIX = 'mrn-mainwp/';
const PROVIDERS = [
  'preflight-maintenance-v1',
  'execute-maintenance-v1',
  'read-maintenance-state-v1',
];
// Native package inspection and tree hashing can outlive the ordinary 30s
// request budget. Keep these waits bounded and local to the three closed
// maintenance phases; external cancellation and all server gates still apply.
const PHASE_TIMEOUTS = [90_000, 180_000, 90_000] as const;
const MAX_AGE = 5 * 60_000;
const RECEIPT_MAX_AGE = 2 * 60 * 60_000;
type Item = { slug: string; from: string; to: string };
type Receipt = { site_id: number; nonce: string; receipt: string };
type Request = {
  kind: 'plugin' | 'theme';
  site_id: number;
  site_url: string;
  items: Item[];
  major_overrides: Array<Item & { reason: string }>;
  backup_receipt: Receipt;
};
type Pending = {
  digest: string;
  plan: string;
  expires: number;
  requestId: string;
  started: number;
};
const receipts = new Map<string, { expires: number; started: number; ttl: number }>();
const previews = new Map<string, Pending>();
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const sha = (x: unknown) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function fail(code: string): never {
  throw new Error(code);
}
const hash = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (c: Config, r: Receipt) =>
  sha([configIdentityHash(c), r.site_id, r.nonce, r.receipt]);

function prune(): void {
  for (const [k, v] of receipts) if (v.expires <= Date.now()) receipts.delete(k);
  for (const [k, v] of previews) if (v.expires <= Date.now()) previews.delete(k);
}

/** Only trusted get_database_backup_status results enter this process-local provenance ledger. */
export function observeMaintenanceReceipt(
  config: Config,
  ability: string,
  input: Record<string, unknown>,
  result: unknown
): void {
  if (ability !== PREFIX + 'get-database-backup-status-v1' || !object(result)) return;
  const { site_id, nonce, receipt, receipt_ttl, status } = result;
  if (
    status !== 'complete' ||
    !Number.isSafeInteger(site_id) ||
    site_id !== input.site_id ||
    nonce !== input.nonce ||
    typeof nonce !== 'string' ||
    !/^[a-f0-9]{12}$/.test(nonce) ||
    typeof receipt !== 'string' ||
    receipt.length < 16 ||
    receipt.length > 256 ||
    !Number.isInteger(receipt_ttl) ||
    (receipt_ttl as number) <= 0 ||
    (receipt_ttl as number) > 7200
  )
    return;
  prune();
  if (receipts.size >= 100) return;
  const ttl = Math.min((receipt_ttl as number) * 1000, RECEIPT_MAX_AGE);
  receipts.set(identity(config, { site_id: site_id as number, nonce, receipt }), {
    expires: Date.now() + ttl,
    started: performance.now(),
    ttl,
  });
}

export function maintenanceTools(config: Config): Tool[] {
  return MAINTENANCE_TOOLS.filter(
    n => config.allowedTools?.includes(n) && isToolAllowed(config, n)
  ).map(name => ({
    name,
    description:
      'MRN guarded maintenance: exact-site preview and confirmation; server-validated remote Updraft receipt, pinned versions and independent readback required. Fails closed if the Dashboard lacks the qualified maintenance provider. Core is never supported.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['site_id', 'site_url', 'items', 'backup_receipt'],
      properties: {
        site_id: { type: 'integer', minimum: 1 },
        site_url: { type: 'string', format: 'uri', maxLength: 2048 },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['slug', 'from', 'to'],
            properties: {
              slug: { type: 'string', maxLength: 200 },
              from: { type: 'string', maxLength: 80 },
              to: { type: 'string', maxLength: 80 },
            },
          },
        },
        major_overrides: {
          type: 'array',
          maxItems: 20,
          description:
            'Plugins only: one exact slug/from/to and human-approved reason per major update. No blanket override.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['slug', 'from', 'to', 'reason'],
            properties: {
              slug: { type: 'string', maxLength: 200 },
              from: { type: 'string', maxLength: 80 },
              to: { type: 'string', maxLength: 80 },
              reason: { type: 'string', minLength: 12, maxLength: 500 },
            },
          },
        },
        backup_receipt: {
          type: 'object',
          additionalProperties: false,
          required: ['site_id', 'nonce', 'receipt'],
          properties: {
            site_id: { type: 'integer', minimum: 1 },
            nonce: { type: 'string', pattern: '^[a-f0-9]{12}$' },
            receipt: { type: 'string', minLength: 16, maxLength: 256, writeOnly: true },
          },
        },
        dry_run: { type: 'boolean' },
        confirm: { type: 'boolean' },
        user_confirmed: { type: 'boolean' },
        confirmation_token: { type: 'string', maxLength: 36 },
      },
    },
  }));
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(k => allowed.includes(k));
}
function siteUrl(value: unknown): string {
  if (typeof value !== 'string') return fail('MAINTENANCE_SITE_IDENTITY');
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.port ||
    u.hostname.endsWith('.') ||
    value !== u.href.replace(/\/$/, '')
  )
    return fail('MAINTENANCE_SITE_IDENTITY');
  return value;
}
function normalize(config: Config, name: string, args: Record<string, unknown>): Request {
  if (
    config.dashboardUrl !== 'https://wpcontrol.mrndev.io' ||
    config.skipSslVerify ||
    !config.abilityNamespaces.includes('mainwp') ||
    !config.abilityNamespaces.includes('mrn-mainwp')
  )
    fail('MAINTENANCE_DASHBOARD_IDENTITY');
  if (decidePolicy(config, name, true) !== 'needs-confirmation' || !config.requireUserConfirmation)
    fail('MAINTENANCE_POLICY_BLOCKED');
  const tool = maintenanceTools(config).find(t => t.name === name);
  if (!tool) return fail('MAINTENANCE_POLICY_BLOCKED');
  validateInput(args, tool.inputSchema);
  if (!exactKeys(args, Object.keys(tool.inputSchema.properties ?? {})))
    fail('MAINTENANCE_UNKNOWN_INPUT');
  const kind =
    name === MAINTENANCE_TOOLS[0]
      ? 'plugin'
      : name === MAINTENANCE_TOOLS[1]
        ? 'theme'
        : fail('MAINTENANCE_CORE_FORBIDDEN');
  if (!Number.isSafeInteger(args.site_id) || (args.site_id as number) < 1)
    fail('MAINTENANCE_SITE_IDENTITY');
  const url = siteUrl(args.site_url);
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 20)
    fail('MAINTENANCE_SELECTION_REQUIRED');
  const items: Item[] = args.items
    .map(value => {
      if (
        !object(value) ||
        !exactKeys(value, ['slug', 'from', 'to']) ||
        typeof value.slug !== 'string' ||
        !/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.php)?$/.test(
          value.slug
        ) ||
        value.slug.includes('..') ||
        (kind === 'theme' && value.slug.includes('/'))
      )
        return fail('MAINTENANCE_ITEM_INVALID');
      const versions = [value.from, value.to];
      if (
        !versions.every(v => typeof v === 'string' && v.length <= 80 && /^\d+(?:\.\d+)*$/.test(v))
      )
        return fail('MAINTENANCE_VERSION_UNKNOWN');
      const from = (value.from as string).split('.').map(BigInt),
        to = (value.to as string).split('.').map(BigInt);
      let newer = false;
      for (let i = 0; i < Math.max(from.length, to.length); i++) {
        if ((to[i] ?? 0n) === (from[i] ?? 0n)) continue;
        newer = (to[i] ?? 0n) > (from[i] ?? 0n);
        break;
      }
      if (!newer) fail('MAINTENANCE_UPGRADE_ONLY');
      return { slug: value.slug, from: value.from as string, to: value.to as string };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (new Set(items.map(i => i.slug)).size !== items.length)
    fail('MAINTENANCE_SELECTION_DUPLICATE');
  const overrides = args.major_overrides ?? [];
  if (!Array.isArray(overrides) || overrides.length > 20) fail('MAINTENANCE_OVERRIDE_INVALID');
  const major_overrides = overrides
    .map(v => {
      if (
        !object(v) ||
        !exactKeys(v, ['slug', 'from', 'to', 'reason']) ||
        typeof v.reason !== 'string' ||
        v.reason.trim().length < 12 ||
        v.reason.length > 500 ||
        kind !== 'plugin' ||
        !items.some(
          i =>
            i.slug === v.slug &&
            i.from === v.from &&
            i.to === v.to &&
            BigInt(i.from.split('.')[0]) !== BigInt(i.to.split('.')[0])
        )
      )
        return fail('MAINTENANCE_OVERRIDE_INVALID');
      return {
        slug: v.slug as string,
        from: v.from as string,
        to: v.to as string,
        reason: v.reason,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (new Set(major_overrides.map(i => i.slug)).size !== major_overrides.length)
    fail('MAINTENANCE_OVERRIDE_INVALID');
  for (const i of items)
    if (
      BigInt(i.from.split('.')[0]) !== BigInt(i.to.split('.')[0]) &&
      !major_overrides.some(o => o.slug === i.slug)
    )
      fail('MAINTENANCE_MAJOR_VERSION_BLOCKED');
  const r = args.backup_receipt;
  if (
    !object(r) ||
    !exactKeys(r, ['site_id', 'nonce', 'receipt']) ||
    r.site_id !== args.site_id ||
    typeof r.nonce !== 'string' ||
    !/^[a-f0-9]{12}$/.test(r.nonce) ||
    typeof r.receipt !== 'string' ||
    r.receipt.length < 16 ||
    r.receipt.length > 256
  )
    fail('MAINTENANCE_BACKUP_REQUIRED');
  return {
    kind,
    site_id: args.site_id as number,
    site_url: url,
    items,
    major_overrides,
    backup_receipt: { site_id: r.site_id as number, nonce: r.nonce, receipt: r.receipt },
  };
}
function receiptValid(c: Config, r: Receipt): void {
  const known = receipts.get(identity(c, r));
  if (!known || known.expires <= Date.now() || performance.now() - known.started >= known.ttl)
    fail('MAINTENANCE_BACKUP_UNPROVEN_OR_EXPIRED');
}

/** These are dedicated server gates, never aliases for stock update/install/run-all tools. */
export async function maintenanceProvider(
  config: Config,
  logger?: Logger
): Promise<Ability[] | undefined> {
  const all = await fetchAbilities(config, true, logger);
  return qualifiedMaintenanceProvider(config, all);
}

function qualifiedMaintenanceProvider(config: Config, all: Ability[]): Ability[] | undefined {
  const providers = PROVIDERS.map(n => all.find(a => a.name === PREFIX + n));
  if (
    providers.some(
      a =>
        !a ||
        (a.meta as Record<string, unknown> | undefined)?.mrn_maintenance_contract !==
          MAINTENANCE_CONTRACT
    )
  )
    return;
  const [preview, execute, read] = providers as Ability[];
  if (
    preview.meta?.annotations?.destructive !== false ||
    preview.meta?.annotations?.readonly !== false ||
    execute.meta?.annotations?.destructive !== true ||
    execute.meta?.annotations?.readonly !== false ||
    execute.meta?.annotations?.idempotent !== false ||
    read.meta?.annotations?.readonly !== true ||
    read.meta?.annotations?.destructive !== false
  )
    return;
  // A blocked helper is an explicit denial even though helpers are not public tools.
  if (PROVIDERS.some(n => config.blockedTools?.includes('mrn_mainwp__' + n.replaceAll('-', '_'))))
    return;
  return providers as Ability[];
}

export function maintenanceStatus(
  config: Config,
  abilities: Ability[]
): Record<string, unknown> | undefined {
  const tools = maintenanceTools(config).map(t => t.name);
  if (!tools.length) return;
  const ready = !!qualifiedMaintenanceProvider(config, abilities);
  return {
    contract: MAINTENANCE_CONTRACT,
    tools,
    provider_ready: ready,
    execution_ready: ready && !config.safeMode && config.requireUserConfirmation,
    core_enabled: false,
    stock_update_fallback: false,
    ...(!ready ? { blocker: 'MAINTENANCE_PROVIDER_REQUIRED' } : {}),
  };
}

function checkPlan(value: unknown, request: Request): { plan: string; expires: number } {
  if (
    !object(value) ||
    value.contract !== MAINTENANCE_CONTRACT ||
    value.ready !== true ||
    value.site_id !== request.site_id ||
    value.site_url !== request.site_url ||
    value.kind !== request.kind ||
    !equal(value.items, request.items) ||
    value.input_sha256 !== sha(request) ||
    !hash(value.plan_sha256) ||
    !object(value.backup)
  )
    return fail('MAINTENANCE_PROVIDER_PLAN_INVALID');
  const b = value.backup;
  if (
    b.provider !== 'updraftplus' ||
    b.site_id !== request.site_id ||
    b.nonce !== request.backup_receipt.nonce ||
    b.receipt_sha256 !== sha(request.backup_receipt.receipt) ||
    b.database_only !== true ||
    b.remote_verified !== true ||
    !Number.isSafeInteger(b.completed_at) ||
    !Number.isSafeInteger(b.expires_at) ||
    (b.completed_at as number) > Date.now() ||
    Date.now() - (b.completed_at as number) >= RECEIPT_MAX_AGE ||
    (b.expires_at as number) <= Date.now() ||
    (b.expires_at as number) > (b.completed_at as number) + RECEIPT_MAX_AGE
  )
    return fail('MAINTENANCE_REMOTE_BACKUP_UNVERIFIED');
  return {
    plan: value.plan_sha256,
    expires: Math.min(Date.now() + MAX_AGE, b.expires_at as number),
  };
}

export async function executeMaintenance(
  config: Config,
  name: string,
  args: Record<string, unknown>,
  logger: Logger,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  prune();
  const r = normalize(config, name, args);
  receiptValid(config, r.backup_receipt);
  if (args.confirm === true && args.dry_run === true) fail('MAINTENANCE_CONFLICTING_CONFIRMATION');
  if (args.user_confirmed === true && (args.confirm !== true || args.dry_run === true))
    fail('MAINTENANCE_CONFIRMATION_REQUIRED');
  const digest = sha([configIdentityHash(config), name, r]);
  let pending: Pending | undefined;
  if (args.user_confirmed === true) {
    if (typeof args.confirmation_token !== 'string') fail('MAINTENANCE_CONFIRMATION_REQUIRED');
    pending = previews.get(args.confirmation_token as string);
    if (
      !pending ||
      pending.digest !== digest ||
      pending.expires <= Date.now() ||
      performance.now() - pending.started >= MAX_AGE
    )
      fail('MAINTENANCE_CONFIRMATION_STALE');
    // Consume synchronously before any await. An uncertain write is never automatically retried.
    previews.delete(args.confirmation_token as string);
  }
  const provider = await maintenanceProvider(config, logger);
  if (!provider)
    return fail(
      'MAINTENANCE_PROVIDER_REQUIRED: Dashboard must validate remote Updraft receipts and atomically bind exact child versions. Stock updates are not a safe fallback.'
    );
  const run = (i: number, input: Record<string, unknown>) =>
    executeAbility(
      { ...config, requestTimeout: Math.max(config.requestTimeout, PHASE_TIMEOUTS[i]) },
      provider[i].name,
      input,
      logger,
      provider[i],
      signal
    );
  let rawPlan: unknown;
  try {
    rawPlan = await run(0, r);
  } catch {
    return fail('MAINTENANCE_PREFLIGHT_FAILED');
  }
  const plan = checkPlan(rawPlan, r);
  receiptValid(config, r.backup_receipt);
  if (!pending) {
    if (args.confirmation_token !== undefined) fail('MAINTENANCE_CONFIRMATION_INVALID');
    if (previews.size >= 100) fail('MAINTENANCE_PREVIEW_CAPACITY');
    const token = crypto.randomUUID();
    previews.set(token, {
      digest,
      plan: plan.plan,
      expires: plan.expires,
      requestId: crypto.randomUUID(),
      started: performance.now(),
    });
    return {
      status: 'CONFIRMATION_REQUIRED',
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      items: r.items,
      major_overrides: r.major_overrides,
      plan_sha256: plan.plan,
      confirmation_token: token,
      expires_at: plan.expires,
      backup: { provider: 'updraftplus', remote_verified: true, nonce: r.backup_receipt.nonce },
      message:
        'Show this exact plan and obtain explicit human approval before repeating with confirm=true, user_confirmed=true and this token.',
    };
  }
  if (plan.plan !== pending.plan) fail('MAINTENANCE_STALE_STATE');
  if (pending.expires <= Date.now() || plan.expires <= Date.now())
    fail('MAINTENANCE_CONFIRMATION_STALE');
  if (signal?.aborted) fail('MAINTENANCE_CANCELLED');
  // One backup per write attempt in this process; server contract additionally consumes it under a site lock.
  receipts.delete(identity(config, r.backup_receipt));
  logger.info('AUDIT: MRN maintenance execution requested', {
    toolName: name,
    siteId: r.site_id,
    requestId: pending.requestId,
    planHash: plan.plan,
  });
  let outcome: unknown;
  try {
    outcome = await run(1, {
      ...r,
      plan_sha256: plan.plan,
      request_id: pending.requestId,
      confirm: true,
    });
  } catch {
    return {
      status: 'OUTCOME_UNKNOWN',
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      items: r.items,
      plan_sha256: plan.plan,
      request_id: pending.requestId,
      automatic_retry: false,
      message:
        'The request may have reached the child. Inspect installed state and provider operation status; do not repeat the write.',
    };
  }
  let readback: unknown;
  try {
    readback = await run(2, {
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      slugs: r.items.map(i => i.slug),
      request_id: pending.requestId,
      plan_sha256: plan.plan,
    });
  } catch {
    return {
      status: 'READBACK_REQUIRED',
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      items: r.items,
      plan_sha256: plan.plan,
      request_id: pending.requestId,
      automatic_retry: false,
    };
  }
  const verified =
    object(readback) &&
    readback.contract === MAINTENANCE_CONTRACT &&
    readback.site_id === r.site_id &&
    readback.site_url === r.site_url &&
    readback.kind === r.kind &&
    readback.request_id === pending.requestId &&
    readback.plan_sha256 === plan.plan &&
    equal(
      readback.items,
      r.items.map(i => ({ slug: i.slug, version: i.to }))
    ) &&
    readback.unrelated_unchanged === true &&
    readback.core_unchanged === true;
  const succeeded =
    object(outcome) &&
    outcome.contract === MAINTENANCE_CONTRACT &&
    outcome.status === 'complete' &&
    outcome.request_id === pending.requestId &&
    outcome.site_id === r.site_id &&
    outcome.site_url === r.site_url &&
    outcome.plan_sha256 === plan.plan;
  logger.info('AUDIT: MRN maintenance verification completed', {
    toolName: name,
    siteId: r.site_id,
    requestId: pending.requestId,
    verified,
    succeeded,
  });
  return {
    status: verified && succeeded ? 'VERIFIED' : 'PARTIAL_OR_UNVERIFIED',
    site_id: r.site_id,
    site_url: r.site_url,
    request_id: pending.requestId,
    items: r.items,
    installed_verified: verified,
    provider_succeeded: succeeded,
    automatic_retry: false,
  };
}

/** Test isolation only; never exposed as an MCP operation. */
export function clearMaintenanceState(): void {
  receipts.clear();
  previews.clear();
}
