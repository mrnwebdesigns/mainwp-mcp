/** MRN maintenance boundary. No stock update ability is used as an execution fallback. */
import crypto from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { configIdentityHash, executeAbility, fetchAbilities, type Ability } from './abilities.js';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import { decidePolicy, isToolAllowed } from './policy.js';
import { validateInput } from './security.js';
import { getHttpStatus, McpErrorFactory, UpstreamHttpError } from './errors.js';

export const MAINTENANCE_TOOLS = [
  'mrn_mainwp__maintenance_plugins_v1',
  'mrn_mainwp__maintenance_themes_v1',
] as const;
export const MAINTENANCE_CONTRACT = 'mrn-maintenance-exact-versions-remote-updraft-v1';
export const PREPARATION_CONTRACT = 'mrn-maintenance-preparation-completion-v1';
const PREPARATION_READ = 'read-maintenance-preflight-v1';
const PREPARATION_WAIT = 240_000;
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
  state?: Record<string, string>;
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

// Only closed codes and exact selected slugs cross this diagnostic boundary.
const STAGES = new Set([
  'child_validation',
  'child_backup',
  'child_snapshot',
  'child_offer',
  'child_download',
  'child_package',
  'child_update',
  'child_preinstall',
  'child_postinstall',
  'dashboard_child_transport',
  'dashboard_inventory',
]);
const CODES = new Set([
  'verified',
  'internal_error',
  'unsupported_runtime',
  'invalid_schema',
  'selection_required',
  'invalid_override',
  'invalid_target',
  'unknown_version',
  'version_refused',
  'unused_override',
  'tree_unavailable',
  'tree_unsafe',
  'tree_limit',
  'tree_unreadable',
  'plugin_unreadable',
  'theme_invalid',
  'core_unavailable',
  'offer_changed',
  'shared_plugin_directory',
  'download_unavailable',
  'download_failed',
  'package_invalid',
  'package_limit',
  'package_alias_or_type',
  'package_path',
  'package_version',
  'package_name',
  'theme_template_changed',
  'backup_unverified',
  'preflight_state_changed',
  'backup_nonce_invalid',
  'storage_adapter_unavailable',
  'remote_inventory_unavailable',
  'remote_inventory_schema',
  'remote_region_unavailable',
  'backup_remote_verification_failed',
  'recent_labeled_database_backup_required',
  'maintenance_backup_log_unavailable',
  'maintenance_backup_not_complete',
  'maintenance_backup_expired',
  'maintenance_backup_label_required',
  'download_http_blocked',
  'download_transport_failed',
  'download_dns_failed',
  'download_connection_failed',
  'download_incomplete',
  'download_stream_failed',
  'download_timeout',
  'download_tls_failed',
  'download_empty_reply',
  'download_certificate_failed',
  'download_http_denied',
  'download_http_unavailable',
  'download_http_limited',
  'download_http_server_error',
  'download_http_status',
  'download_empty',
  'download_size_limit',
  'package_changed',
  'mainwp_rollback_contract_unavailable',
  'installed_version_changed',
  'backup_expired_before_write',
  'postinstall_state_changed',
  'native_update_failed',
  'stale_plan',
  'operation_identity',
  'operation_locked',
  'request_conflict',
  'request_already_reserved',
  'audit_capacity',
  'ledger_unavailable',
  'backup_nonce_consumed',
  'ledger_readback_failed',
  'operation_unavailable',
  'read_identity',
  'read_selection',
  'stale_preinstall',
  'activation_change_blocked',
  'child_transport_or_contract',
  'not_attempted',
  'ignored_or_changed',
  'not_offered_or_ignored',
  'preview_versions',
]);
function diagnostic(value: unknown, request: Request): Record<string, unknown> | undefined {
  if (!object(value) || !STAGES.has(String(value.stage)) || !CODES.has(String(value.code))) return;
  return {
    stage: value.stage,
    code: value.code,
    ...(Array.isArray(value.items) ? { items: results(value.items, request) } : {}),
  };
}
function results(value: unknown, request: Request): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > request.items.length) return [];
  const seen = new Set<string>();
  return value.flatMap(v => {
    if (
      !object(v) ||
      typeof v.slug !== 'string' ||
      seen.has(v.slug) ||
      !request.items.some(i => i.slug === v.slug) ||
      typeof v.success !== 'boolean' ||
      !STAGES.has(String(v.stage)) ||
      !CODES.has(String(v.code))
    )
      return [];
    seen.add(v.slug);
    return [
      {
        slug: v.slug,
        success: v.success,
        stage: v.stage,
        code: v.code,
        ...(typeof v.replacement_started === 'boolean'
          ? { replacement_started: v.replacement_started }
          : {}),
      },
    ];
  });
}
function fingerprints(value: unknown): Record<string, string> | undefined {
  if (!object(value) || Object.keys(value).length > 8000) return;
  if (
    !Object.entries(value).every(
      ([k, v]) =>
        k.length <= 250 &&
        /^(?:(?:plugins|themes):[A-Za-z0-9_./-]+:(?:version|active|tree|template)|core:(?:version|db_version|admin|includes|root)|runtime:(?:stylesheet|template)|package:[A-Za-z0-9_./-]+|backup)$/.test(
          k
        ) &&
        hash(v)
    )
  )
    return;
  return value as Record<string, string>;
}
function upstreamFailure(
  error: unknown,
  stage: string,
  started: number,
  timeout: number
): Record<string, unknown> {
  const status = getHttpStatus(error);
  const httpStatus =
    Number.isInteger(status) && status! >= 300 && status! <= 599 ? status : undefined;
  // Inspect only typed local transport fields, never reflect a remote message,
  // URL, response body, header, receipt or arbitrary exception code.
  const cause = object(error) && object(error.cause) ? error.cause : undefined;
  const transportCode = object(error) ? (error.code ?? cause?.code) : undefined;
  let code = 'provider_transport_failed';
  if (
    error instanceof UpstreamHttpError &&
    /^mrn_maintenance_[a-z_]{1,64}$/.test(error.upstreamCode ?? '')
  ) {
    code = error.upstreamCode!;
  } else if (
    transportCode === 'ETIMEDOUT' ||
    (error instanceof Error && error.name === 'TimeoutError')
  ) {
    code = 'provider_request_timeout';
  } else if (error instanceof Error && error.name === 'AbortError') {
    code = 'provider_request_cancelled';
  } else if (httpStatus === 524 || httpStatus === 504) {
    code = 'provider_gateway_timeout';
  } else if (httpStatus === 401) {
    code = 'provider_authentication_rejected';
  } else if (httpStatus === 403) {
    code = 'provider_http_forbidden';
  } else if (httpStatus === 429) {
    code = 'provider_rate_limited';
  } else if (httpStatus !== undefined && httpStatus < 400) {
    code = 'provider_redirect_refused';
  } else if (httpStatus !== undefined) {
    code = 'provider_http_error';
  } else if (['ENOTFOUND', 'EAI_AGAIN'].includes(String(transportCode))) {
    code = 'provider_dns_failed';
  } else if (
    ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(transportCode))
  ) {
    code = 'provider_connection_failed';
  } else if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    ].includes(String(transportCode))
  ) {
    code = 'provider_tls_failed';
  } else if (error instanceof Error && error.message === 'Invalid JSON in ability response') {
    code = 'provider_invalid_response';
  }
  return {
    stage,
    code,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    timeout_ms: timeout,
    elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
    ...(stage === 'dashboard_preflight' ? { execution_attempted: false } : {}),
    automatic_retry: false,
  };
}

/** A legacy/partial ledger cannot prove that a replacement never started. */
function noReplacementProven(value: Record<string, unknown>, request: Request): boolean {
  return (
    value.installed_state_changed === false &&
    value.unrelated_unchanged === true &&
    value.core_unchanged === true &&
    ['complete', 'partial'].includes(String(value.provider_status)) &&
    Array.isArray(value.results) &&
    value.results.length === request.items.length &&
    value.results.every(
      (row, index) =>
        object(row) &&
        row.slug === request.items[index].slug &&
        typeof row.success === 'boolean' &&
        row.replacement_started === false
    )
  );
}

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
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return fail('MAINTENANCE_SITE_IDENTITY');
  }
  // Accept one conventional final slash, without accepting other URL aliases.
  const canonical = u.href.replace(/\/$/, '');
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.port ||
    u.hostname.endsWith('.') ||
    u.pathname.endsWith('//') ||
    (value !== canonical && value !== canonical + '/')
  )
    return fail('MAINTENANCE_SITE_IDENTITY');
  return canonical;
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
  const recovery = all.find(a => a.name === PREFIX + PREPARATION_READ);
  const preparationMeta = (a: Ability) =>
    (a.meta as Record<string, unknown> | undefined)?.mrn_maintenance_preparation_contract;
  // A partially installed or explicitly blocked completion contract is not a legacy provider.
  if (recovery || (providers as Ability[]).some(a => preparationMeta(a) !== undefined)) {
    if (
      !recovery ||
      (recovery.meta as Record<string, unknown> | undefined)?.mrn_maintenance_contract !==
        MAINTENANCE_CONTRACT ||
      config.blockedTools?.includes('mrn_mainwp__read_maintenance_preflight_v1') ||
      [...(providers as Ability[]), recovery].some(
        a => preparationMeta(a) !== PREPARATION_CONTRACT
      ) ||
      recovery.meta?.annotations?.readonly !== true ||
      recovery.meta?.annotations?.destructive !== false ||
      recovery.meta?.annotations?.idempotent !== true
    )
      return;
    return [...(providers as Ability[]), recovery];
  }
  return providers as Ability[];
}

export function maintenanceStatus(
  config: Config,
  abilities: Ability[]
): Record<string, unknown> | undefined {
  const tools = maintenanceTools(config).map(t => t.name);
  if (!tools.length) return;
  const providers = qualifiedMaintenanceProvider(config, abilities);
  const ready = !!providers;
  return {
    contract: MAINTENANCE_CONTRACT,
    tools,
    provider_ready: ready,
    execution_ready: ready && !config.safeMode && config.requireUserConfirmation,
    core_enabled: false,
    stock_update_fallback: false,
    ...(providers?.length === 4 ? { preparation_recovery_ready: true } : {}),
    ...(!ready ? { blocker: 'MAINTENANCE_PROVIDER_REQUIRED' } : {}),
  };
}

/** Read only the original attempt after a lost preparation response; never resend work. */
async function recoverPreparation(
  config: Config,
  helper: Ability,
  request: Request,
  attempt: string,
  started: number,
  approvalDeadline: number | undefined,
  logger: Logger,
  signal?: AbortSignal
): Promise<unknown> {
  const deadline = Math.min(
    started + PREPARATION_WAIT,
    performance.now() +
      (receipts.get(identity(config, request.backup_receipt))!.expires - Date.now()),
    approvalDeadline === undefined ? Infinity : performance.now() + approvalDeadline - Date.now()
  );
  const refuse = (code: string): never => {
    throw McpErrorFactory.invalidParams('MAINTENANCE_PREFLIGHT_FAILED', {
      stage: 'dashboard_preparation_read',
      code,
      input_sha256: sha(request),
      elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
      execution_attempted: false,
      automatic_retry: false,
    });
  };
  while (performance.now() < deadline) {
    if (signal?.aborted) return refuse('preparation_cancelled');
    receiptValid(config, request.backup_receipt);
    let result: unknown;
    try {
      result = await executeAbility(
        {
          ...config,
          requestTimeout: Math.max(1, Math.min(10_000, deadline - performance.now())),
          retryEnabled: false,
        },
        helper.name,
        {
          kind: request.kind,
          site_id: request.site_id,
          site_url: request.site_url,
          attempt_id: attempt,
          input_sha256: sha(request),
        },
        logger,
        helper,
        signal
      );
    } catch (error) {
      throw McpErrorFactory.invalidParams('MAINTENANCE_PREFLIGHT_FAILED', {
        ...upstreamFailure(error, 'dashboard_preflight', started, 10_000),
        stage: 'dashboard_preparation_read',
        input_sha256: sha(request),
      });
    }
    if (
      !object(result) ||
      !exactKeys(result, ['contract', 'attempt_id', 'input_sha256', 'status', 'result', 'error']) ||
      Object.keys(result).length !== 6 ||
      result.contract !== PREPARATION_CONTRACT ||
      result.attempt_id !== attempt ||
      result.input_sha256 !== sha(request)
    )
      return refuse('preparation_binding');
    if (result.status === 'complete') {
      if (
        !object(result.result) ||
        result.error !== null ||
        result.result.preparation_id !== undefined
      )
        return refuse('preparation_contract');
      return { ...result.result, preparation_id: attempt };
    }
    if (result.status === 'failed') {
      if (
        result.result !== null ||
        typeof result.error !== 'string' ||
        !/^mrn_maintenance_[a-z_]{1,64}$/.test(result.error)
      )
        return refuse('preparation_contract');
      return refuse(result.error);
    }
    if (result.status !== 'pending' || result.result !== null || result.error !== null)
      return refuse('preparation_contract');
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        clearTimeout(timer);
        reject(new Error('MAINTENANCE_CANCELLED'));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        },
        Math.max(1, Math.min(3_000, deadline - performance.now()))
      );
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }
  return refuse('preparation_wait_expired');
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
    expires: Math.min(
      Date.now() + MAX_AGE,
      b.expires_at as number,
      value.expires_at === undefined
        ? Infinity
        : Number.isSafeInteger(value.expires_at) &&
            (value.expires_at as number) > Date.now() &&
            (value.expires_at as number) <= (b.expires_at as number)
          ? (value.expires_at as number)
          : fail('MAINTENANCE_PROVIDER_PLAN_EXPIRED')
    ),
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
  const attempt = provider[3] ? crypto.randomUUID() : undefined;
  let phaseStarted = performance.now();
  const timeout = (i: number) => Math.max(config.requestTimeout, PHASE_TIMEOUTS[i]);
  const run = (i: number, input: Record<string, unknown>) => {
    phaseStarted = performance.now();
    return executeAbility(
      { ...config, requestTimeout: timeout(i) },
      provider[i].name,
      input,
      logger,
      provider[i],
      signal
    );
  };
  let rawPlan: unknown;
  try {
    rawPlan = await run(0, { ...r, ...(attempt ? { attempt_id: attempt } : {}) });
  } catch (error) {
    const failure = upstreamFailure(error, 'dashboard_preflight', phaseStarted, timeout(0));
    if (
      attempt &&
      !signal?.aborted &&
      ['provider_request_timeout', 'provider_gateway_timeout'].includes(String(failure.code))
    ) {
      rawPlan = await recoverPreparation(
        config,
        provider[3],
        r,
        attempt,
        phaseStarted,
        pending?.expires,
        logger,
        signal
      );
    } else {
      throw McpErrorFactory.invalidParams('MAINTENANCE_PREFLIGHT_FAILED', {
        ...failure,
        input_sha256: sha(r),
      });
    }
  }
  if (attempt && (!object(rawPlan) || rawPlan.preparation_id !== attempt))
    fail('MAINTENANCE_PREPARATION_BINDING');
  if (object(rawPlan) && rawPlan.contract === MAINTENANCE_CONTRACT && rawPlan.ready === false)
    throw McpErrorFactory.invalidParams('MAINTENANCE_PREFLIGHT_FAILED', {
      failure: diagnostic(rawPlan.failure, r) ?? {
        stage: 'dashboard_preflight',
        code: 'provider_contract',
      },
      execution_attempted: false,
    });
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
      state: object(rawPlan) ? fingerprints(rawPlan.state_fingerprints) : undefined,
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
  if (plan.plan !== pending.plan) {
    const current = object(rawPlan) ? fingerprints(rawPlan.state_fingerprints) : undefined;
    const changes =
      pending.state && current
        ? [...new Set([...Object.keys(pending.state), ...Object.keys(current)])]
            .sort()
            .filter(k => pending!.state![k] !== current[k])
            .map(component => ({
              component,
              previous_sha256: pending!.state![component] ?? null,
              current_sha256: current[component] ?? null,
            }))
        : [];
    throw McpErrorFactory.invalidParams('MAINTENANCE_STALE_STATE', {
      previous_plan_sha256: pending.plan,
      current_plan_sha256: plan.plan,
      changes,
      reason: changes.length ? 'material_state_changed' : 'provider_plan_identity_changed',
      execution_attempted: false,
      automatic_retry: false,
    });
  }
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
      ...(attempt ? { attempt_id: attempt } : {}),
    });
  } catch (error) {
    return {
      status: 'OUTCOME_UNKNOWN',
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      items: r.items,
      plan_sha256: plan.plan,
      request_id: pending.requestId,
      automatic_retry: false,
      failure: upstreamFailure(error, 'dashboard_execute', phaseStarted, timeout(1)),
      change_reached_site: 'unknown',
      message:
        'The request may have reached the child. Inspect installed state and provider operation status; do not repeat the write.',
    };
  }
  const outcomeBound =
    object(outcome) &&
    outcome.contract === MAINTENANCE_CONTRACT &&
    outcome.site_id === r.site_id &&
    outcome.site_url === r.site_url &&
    outcome.request_id === pending.requestId &&
    outcome.plan_sha256 === plan.plan;
  const boundOutcome = outcomeBound && object(outcome) ? outcome : undefined;
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
  } catch (error) {
    return {
      status: 'READBACK_REQUIRED',
      site_id: r.site_id,
      site_url: r.site_url,
      kind: r.kind,
      items: r.items,
      plan_sha256: plan.plan,
      request_id: pending.requestId,
      automatic_retry: false,
      failure: upstreamFailure(error, 'independent_readback', phaseStarted, timeout(2)),
      provider_result: boundOutcome ? diagnostic(boundOutcome.failure, r) : undefined,
      item_results: boundOutcome ? results(boundOutcome.results, r) : [],
      change_reached_site: 'unknown',
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
  const readBound =
    object(readback) &&
    readback.contract === MAINTENANCE_CONTRACT &&
    readback.site_id === r.site_id &&
    readback.site_url === r.site_url &&
    readback.kind === r.kind &&
    readback.request_id === pending.requestId &&
    readback.plan_sha256 === plan.plan;
  const boundRead = readBound && object(readback) ? readback : undefined;
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
    phases: {
      dashboard_provider_call: 'returned',
      child_site_execution:
        boundOutcome &&
        ['complete', 'partial', 'outcome_unknown'].includes(String(boundOutcome.status))
          ? boundOutcome.status
          : 'unverified',
      independent_readback: verified
        ? 'verified'
        : boundRead
          ? 'state_mismatch'
          : 'identity_unverified',
    },
    automatic_retry: false,
    failure_stage:
      verified && succeeded ? null : !succeeded ? 'child_execution' : 'independent_readback',
    provider_failure: boundOutcome ? diagnostic(boundOutcome.failure, r) : undefined,
    item_results: boundOutcome ? results(boundOutcome.results, r) : [],
    installed_items:
      boundRead && Array.isArray(boundRead.items)
        ? boundRead.items.flatMap(v =>
            object(v) &&
            r.items.some(i => i.slug === v.slug) &&
            typeof v.version === 'string' &&
            /^\d+(?:\.\d+)*$/.test(v.version) &&
            v.version.length <= 80
              ? [{ slug: v.slug, version: v.version }]
              : []
          )
        : [],
    change_reached_site:
      boundRead?.change_reached_site === true
        ? true
        : boundRead?.change_reached_site === false && noReplacementProven(boundRead, r)
          ? false
          : 'unknown',
    installed_state_changed:
      boundRead && typeof boundRead.installed_state_changed === 'boolean'
        ? boundRead.installed_state_changed
        : 'unknown',
    core_unchanged: boundRead ? boundRead.core_unchanged === true : false,
    unrelated_unchanged: boundRead ? boundRead.unrelated_unchanged === true : false,
  };
}

/** Test isolation only; never exposed as an MCP operation. */
export function clearMaintenanceState(): void {
  receipts.clear();
  previews.clear();
}
