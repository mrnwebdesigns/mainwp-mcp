/** Native, read-only configuration audits. Private local progress never contains settings values. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { configIdentityHash, executeAbility, fetchAbilities, type Ability } from './abilities.js';
import type { Config } from './config.js';
import type { Logger } from './logging.js';
import { decidePolicy, isToolAllowed } from './policy.js';
import { validateInput } from './security.js';
import { McpErrorFactory, getHttpStatus, UpstreamHttpError } from './errors.js';

export const EMAIL_AUDIT_CONTRACT = 'mrn-email-address-audit-v1';
export const EMAIL_AUDIT_TOOLS = [
  'mrn_mainwp__start_email_address_audit_v1',
  'mrn_mainwp__continue_email_address_audit_v1',
  'mrn_mainwp__get_email_address_audit_v1',
  'mrn_mainwp__export_email_address_audit_v1',
] as const;
const PREFIX = 'mrn-mainwp/';
const INSPECT = PREFIX + 'audit-email-address-v1';
const AUTHORIZE = PREFIX + 'authorize-email-address-audit-v1';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
function refuse(code: string): never {
  throw McpErrorFactory.invalidParams(code);
}
function url(value: unknown, inventory = false): string {
  if (typeof value !== 'string') return refuse('EMAIL_AUDIT_SITE_IDENTITY');
  const v = new URL(value);
  if (
    (v.protocol !== 'https:' && !(inventory && v.protocol === 'http:')) ||
    v.username ||
    v.password ||
    v.search ||
    v.hash
  )
    return refuse('EMAIL_AUDIT_SITE_IDENTITY');
  return v.href.replace(/\/$/, '');
}
type Site = { site_id: number; site_url: string };
type Match = Site & {
  component: string;
  form_id: string | number | null;
  form_title: string;
  setting_path: string;
  role: string;
  match_type: string;
  enabled_state: string;
  address: string;
  inspection_timestamp: string;
};
type Row = Site & {
  status: 'pending' | 'inspecting' | 'complete' | 'failed';
  cursor: string;
  pages: number;
  scan_complete?: boolean;
  sync: string;
  preparation?: {
    sync_started_at: number;
    sync_outcome?: 'returned' | 'timeout_or_refused' | 'interrupted';
    readback: 'pending' | 'complete';
    knowledge: 'pending' | 'complete';
  };
  limitations: string[];
  matches: Match[];
  error_code?: string;
  inspected_at?: string;
  coverage?: ObjectValue;
};
export type EmailAuditJob = {
  schema: 1;
  audit_id: string;
  identity: string;
  actor_id: number;
  dashboard_host: string;
  address: string;
  scope: 'site' | 'sites' | 'fleet';
  created_at: string;
  inventory_total: number;
  rows: Row[];
};

const common = { audit_id: { type: 'string', pattern: uuid.source } };
const schemas: Tool['inputSchema'][] = [
  {
    type: 'object',
    properties: {
      address: { type: 'string', minLength: 3, maxLength: 254 },
      scope: { type: 'string', enum: ['site', 'sites', 'fleet'] },
      site_urls: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        items: { type: 'string', maxLength: 512 },
      },
    },
    required: ['address', 'scope'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      ...common,
      max_sites: { type: 'integer', minimum: 1, maximum: 10, default: 2 },
      max_pages_per_site: { type: 'integer', minimum: 1, maximum: 8, default: 2 },
      concurrency: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
      max_duration_ms: { type: 'integer', minimum: 1000, maximum: 120000, default: 20000 },
      retry_site_ids: {
        type: 'array',
        maxItems: 200,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 },
      },
      refresh_site_ids: {
        type: 'array',
        maxItems: 200,
        uniqueItems: true,
        items: { type: 'integer', minimum: 1 },
      },
    },
    required: ['audit_id'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: {
      ...common,
      offset: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
      match_offset: { type: 'integer', minimum: 0, default: 0 },
      match_limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    required: ['audit_id'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { ...common, format: { type: 'string', enum: ['json', 'csv'] } },
    required: ['audit_id', 'format'],
    additionalProperties: false,
  },
];

export function emailAuditTools(config: Config): Tool[] {
  if (!config.abilityNamespaces.includes('mrn-mainwp')) return [];
  return EMAIL_AUDIT_TOOLS.map((name, i) => ({
    name,
    inputSchema: schemas[i],
    description: [
      'Create an explicit one-site, site-list or fleet email configuration audit from current MainWP inventory. Fleet is never implicit. No settings changes, mail or form submissions.',
      'Inspect a bounded page batch and persist resumable progress. Sites fail independently. A sync timeout does not prevent safe independent settings reads. No write operations.',
      'Read paginated audit evidence after freshly checking current Dashboard identity and site permissions. Incomplete coverage never establishes no matches.',
      'Export minimal matching evidence and coverage to owner-only local JSON or CSV; return file path and checksum. Rechecks current permissions. No credentials or complete settings values.',
    ][i],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: i === 2 || i === 3,
      openWorldHint: false,
    },
  })).filter(t => config.allowedTools?.includes(t.name) && isToolAllowed(config, t.name));
}

/** Owner-only atomic artifacts, one audit lock, no caller-supplied paths, no symlink adoption. */
export class EmailAuditStore {
  constructor(readonly root = path.join(os.homedir(), '.config/mainwp-mcp/email-audits')) {}
  private directory(): void {
    if (!fs.existsSync(this.root)) fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const s = fs.lstatSync(this.root);
    if (
      !s.isDirectory() ||
      s.isSymbolicLink() ||
      (s.mode & 0o777) !== 0o700 ||
      s.uid !== process.getuid?.()
    )
      refuse('EMAIL_AUDIT_PRIVATE_STORAGE');
  }
  private filename(id: string, suffix = '.state.json'): string {
    if (!uuid.test(id)) return refuse('EMAIL_AUDIT_ID');
    this.directory();
    return path.join(this.root, id + suffix);
  }
  private check(file: string): void {
    const s = fs.lstatSync(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      (s.mode & 0o777) !== 0o600 ||
      s.uid !== process.getuid?.() ||
      s.size > 50 * 1024 * 1024
    )
      refuse('EMAIL_AUDIT_PRIVATE_STORAGE');
  }
  lock(id: string): () => void {
    const file = this.filename(id, '.lock');
    let fd: number;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch {
      // Recover only a demonstrably dead same-machine process, never a timed-out live request.
      this.check(file);
      const before = fs.lstatSync(file);
      let dead = false;
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) refuse('EMAIL_AUDIT_LOCK_INVALID');
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      if (!dead) refuse('EMAIL_AUDIT_BUSY_OR_INTERRUPTED_LOCK');
      const after = fs.lstatSync(file);
      if (before.ino !== after.ino || before.dev !== after.dev)
        refuse('EMAIL_AUDIT_BUSY_OR_INTERRUPTED_LOCK');
      fs.unlinkSync(file);
      try {
        fd = fs.openSync(file, 'wx', 0o600);
      } catch {
        return refuse('EMAIL_AUDIT_BUSY_OR_INTERRUPTED_LOCK');
      }
    }
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    return () => {
      fs.closeSync(fd);
      fs.unlinkSync(file);
    };
  }
  load(id: string): EmailAuditJob {
    const file = this.filename(id);
    this.check(file);
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as EmailAuditJob;
    if (v.audit_id !== id || v.schema !== 1) return refuse('EMAIL_AUDIT_STATE');
    return v;
  }
  write(id: string, data: string, suffix = '.state.json'): string {
    const file = this.filename(id, suffix);
    if (fs.existsSync(file)) this.check(file);
    if (Buffer.byteLength(data) > 50 * 1024 * 1024) return refuse('EMAIL_AUDIT_RESULT_LIMIT');
    const temporary = this.filename(id, '.' + crypto.randomUUID() + '.tmp');
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    return file;
  }
  save(job: EmailAuditJob): void {
    this.write(job.audit_id, JSON.stringify(job));
  }
}

export function emailAuditSummary(job: EmailAuditJob) {
  const inspected = job.rows.filter(r => r.pages > 0);
  const matched = inspected.filter(r => r.matches.length > 0);
  // Incomplete overlaps matched; unmatched means a completed scan without any coverage gap.
  const incomplete = job.rows.filter(
    r => r.status === 'failed' || r.limitations.length > 0 || r.status !== 'complete'
  );
  return {
    audit_id: job.audit_id,
    address: job.address,
    scope: job.scope,
    inventory_total: job.inventory_total,
    total: job.rows.length,
    inspected: inspected.length,
    matched: matched.length,
    current_matched: matched.filter(r => r.matches.some(m => m.enabled_state === 'current')).length,
    unmatched: inspected.filter(
      r => r.status === 'complete' && !r.limitations.length && !r.matches.length
    ).length,
    incomplete: incomplete.length,
    failed: job.rows.filter(r => r.status === 'failed').length,
    pending: job.rows.filter(r => r.status === 'pending' || r.status === 'inspecting').length,
    finished: job.rows.every(r => r.status === 'complete' || r.status === 'failed'),
    matching_sites: matched.map(r => ({
      site_id: r.site_id,
      site_url: r.site_url,
      matches: r.matches.length,
      current_matches: r.matches.filter(m => m.enabled_state === 'current').length,
      coverage_complete: r.status === 'complete' && !r.limitations.length,
    })),
    counts_note:
      'Matched and incomplete can overlap. Unmatched requires complete declared coverage. Pending sites have not established a negative result.',
  };
}

/** CSV is formula-safe even if a form title or email local part starts with a formula character. */
export function emailAuditCsv(job: EmailAuditJob): string {
  const keys: Array<keyof Match> = [
    'site_id',
    'site_url',
    'component',
    'form_id',
    'form_title',
    'setting_path',
    'role',
    'match_type',
    'enabled_state',
    'address',
    'inspection_timestamp',
  ];
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    [
      keys.map(cell).join(','),
      ...job.rows.flatMap(r => r.matches.map(m => keys.map(k => cell(m[k])).join(','))),
    ].join('\r\n') + '\r\n'
  );
}

function cleanPage(
  value: unknown,
  row: Row,
  address: string
): {
  matches: Match[];
  cursor: string;
  done: boolean;
  limitations: string[];
  coverage: ObjectValue;
} {
  if (
    !object(value) ||
    value.contract !== EMAIL_AUDIT_CONTRACT ||
    value.site_id !== row.site_id ||
    value.site_url !== row.site_url ||
    value.address !== address ||
    !Array.isArray(value.matches) ||
    value.matches.length > 1000 ||
    !Array.isArray(value.limitations) ||
    typeof value.next_cursor !== 'string' ||
    value.next_cursor.length > 4096 ||
    typeof value.scan_complete !== 'boolean' ||
    !object(value.coverage)
  )
    return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
  const matches: Match[] = value.matches.map((v: unknown) => {
    if (
      !object(v) ||
      v.address !== address ||
      v.site_id !== row.site_id ||
      v.site_url !== row.site_url ||
      typeof v.component !== 'string' ||
      !/^[a-z0-9_-]{1,100}$/.test(v.component) ||
      typeof v.setting_path !== 'string' ||
      !/^(options|posts|forms)\.[a-zA-Z0-9_.:-]{1,500}$/.test(v.setting_path) ||
      typeof v.form_title !== 'string' ||
      v.form_title.length > 160 ||
      /password|passwd|(?:^|[._])pass(?:[._]|$)|secret|token|nonce|api.?key|license|credential|submission|entry_data/i.test(
        v.setting_path
      ) ||
      ![
        'recipient',
        'sender',
        'reply_to',
        'account',
        'admin_notification',
        'other_reference',
      ].includes(String(v.role)) ||
      !['direct', 'inherited'].includes(String(v.match_type)) ||
      ![
        'current',
        'disabled',
        'inactive_plugin',
        'draft',
        'pending',
        'cached',
        'historical',
        'unknown',
      ].includes(String(v.enabled_state)) ||
      typeof v.inspection_timestamp !== 'string' ||
      !Number.isFinite(Date.parse(v.inspection_timestamp)) ||
      (v.form_id !== null && !/^[a-zA-Z0-9:-]{1,100}$/.test(String(v.form_id)))
    )
      return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
    return {
      site_id: row.site_id,
      site_url: row.site_url,
      component: v.component,
      form_id: v.form_id as string | number | null,
      form_title: v.form_title,
      setting_path: v.setting_path,
      role: String(v.role),
      match_type: String(v.match_type),
      enabled_state: String(v.enabled_state),
      address,
      inspection_timestamp: v.inspection_timestamp,
    };
  });
  const limitations = [
    ...value.limitations,
    ...(Array.isArray(value.coverage.limitations) ? value.coverage.limitations : []),
  ];
  if (limitations.some(v => typeof v !== 'string' || !/^[a-z0-9_:]{1,100}$/.test(v)))
    return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
  if (value.scan_complete !== (value.next_cursor === ''))
    return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
  if (!object(value.coverage.plugins) || Object.keys(value.coverage.plugins).length > 500)
    return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
  const plugins: Record<string, { version: string; active: boolean }> = {};
  for (const [slug, info] of Object.entries(value.coverage.plugins)) {
    if (
      !/^[a-zA-Z0-9_./-]{1,200}$/.test(slug) ||
      !object(info) ||
      typeof info.version !== 'string' ||
      !/^[a-zA-Z0-9.+_-]{1,50}$/.test(info.version) ||
      typeof info.active !== 'boolean'
    )
      return refuse('EMAIL_AUDIT_PROVIDER_CONTRACT');
    plugins[slug] = { version: info.version, active: info.active };
  }
  return {
    matches,
    cursor: value.next_cursor,
    done: value.scan_complete,
    limitations: limitations as string[],
    coverage: {
      scope: 'stored_options_and_supported_form_configuration',
      plugin_inventory: plugins,
      limitations,
    },
  };
}

export async function executeEmailAudit(
  config: Config,
  name: string,
  args: ObjectValue,
  logger: Logger,
  signal?: AbortSignal,
  store = new EmailAuditStore()
): Promise<ObjectValue> {
  const index = (EMAIL_AUDIT_TOOLS as readonly string[]).indexOf(name);
  if (index < 0 || !config.allowedTools?.includes(name) || decidePolicy(config, name) !== 'allow')
    throw McpErrorFactory.permissionDenied('Email audit tool is not allowed');
  validateEmailAuditInput(name, args);
  if (
    config.dashboardUrl.replace(/\/$/, '') !== 'https://wpcontrol.mrndev.io' ||
    config.skipSslVerify ||
    !config.abilityNamespaces.includes('mainwp') ||
    !config.abilityNamespaces.includes('mrn-mainwp')
  )
    refuse('EMAIL_AUDIT_DASHBOARD_IDENTITY');
  const deadlineAt = Date.now() + (index === 1 ? Number(args.max_duration_ms ?? 20000) : 30000);
  const catalog = await fetchAbilities(config, false, logger);
  for (const provider of [INSPECT, AUTHORIZE]) {
    const a = catalog.find(a => a.name === provider);
    if (
      !a ||
      a.meta?.annotations?.readonly !== true ||
      a.meta?.annotations?.destructive === true ||
      (a.meta as ObjectValue).mrn_email_audit_contract !== EMAIL_AUDIT_CONTRACT
    )
      refuse('EMAIL_AUDIT_PROVIDER_UNAVAILABLE');
  }
  const call = async (
    abilityName: string,
    input: ObjectValue,
    internal = false,
    timeout = 30_000,
    perCallLimit = timeout
  ): Promise<unknown> => {
    const tool = abilityName.startsWith(PREFIX)
      ? 'mrn_mainwp__' + abilityName.slice(PREFIX.length).replaceAll('-', '_')
      : abilityName.slice('mainwp/'.length).replaceAll('-', '_');
    if (
      config.blockedTools?.includes(tool) ||
      (!internal && decidePolicy(config, tool) !== 'allow')
    )
      throw McpErrorFactory.permissionDenied('Email audit supporting tool is not allowed');
    const ability = catalog.find(a => a.name === abilityName);
    if (!ability) refuse('EMAIL_AUDIT_SUPPORTING_ABILITY_MISSING');
    if (
      ability?.meta?.annotations?.destructive !== false ||
      (abilityName !== 'mainwp/sync-sites-v1' && ability?.meta?.annotations?.readonly !== true)
    )
      refuse('EMAIL_AUDIT_SUPPORTING_ABILITY_UNQUALIFIED');
    if (signal?.aborted) throw McpErrorFactory.cancelled();
    const remaining = deadlineAt - Date.now();
    if (remaining < 1000) refuse('EMAIL_AUDIT_BATCH_BUDGET');
    const requestLimit = Math.min(config.requestTimeout, perCallLimit);
    const requestTimeout = Math.min(requestLimit, timeout, remaining);
    // This read-only workflow never needs longer timeouts or automatic HTTP retries.
    try {
      return await executeAbility(
        { ...config, retryEnabled: false, requestTimeout },
        abilityName,
        input,
        logger,
        ability as Ability,
        signal
      );
    } catch (error) {
      // Only worker calls may defer after a shortened local deadline. Scope and
      // authorization checks remain fail-closed; a full request timeout, early
      // transport error or upstream refusal remains a genuine failure.
      const workerCall = [
        INSPECT,
        'mainwp/get-site-knowledge-v1',
        'mainwp/get-site-v1',
        'mainwp/sync-sites-v1',
      ].includes(abilityName);
      if (
        index === 1 &&
        workerCall &&
        requestTimeout < requestLimit &&
        Date.now() >= deadlineAt &&
        !signal?.aborted &&
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ETIMEDOUT' &&
        ![401, 403].includes(getHttpStatus(error) ?? 0)
      )
        refuse('EMAIL_AUDIT_BATCH_BUDGET');
      throw error;
    }
  };
  return executeEmailAuditWithTransport(
    { identity: configIdentityHash(config), call, deadlineAt },
    name,
    args,
    signal,
    store
  );
}

/** Shared orchestration. Hosts supply an authenticated transport and private owner-bound store.
 * No credentials, policy bypass, or virtual-tool-to-native-ability mapping is accepted here.
 */
export type EmailAuditStorage = Pick<EmailAuditStore, 'lock' | 'load' | 'save' | 'write'>;
export type EmailAuditTransport = {
  identity: string;
  deadlineAt?: number;
  call: (
    ability: string,
    input: ObjectValue,
    internal: boolean,
    timeout: number,
    // Independent per-call cap before the continuation budget clips timeout.
    // Only the native adapter uses this to prove its own local ETIMEDOUT.
    perCallLimit: number
  ) => Promise<unknown>;
  fatal?: (error: unknown) => boolean;
};
export const EMAIL_AUDIT_ENGINE_CONTRACT = 'mrn-email-audit-engine-v1';
const supportingAbilities = new Set([
  INSPECT,
  AUTHORIZE,
  'mainwp/list-sites-v1',
  'mainwp/get-site-v1',
  'mainwp/get-site-knowledge-v1',
  'mainwp/sync-sites-v1',
]);
function validateEmailAuditInput(name: string, args: ObjectValue): number {
  const index = (EMAIL_AUDIT_TOOLS as readonly string[]).indexOf(name);
  if (index < 0) refuse('EMAIL_AUDIT_INPUT');
  validateInput(args, schemas[index]);
  const properties = schemas[index].properties ?? {};
  if (
    Object.keys(args).some(key => !Object.hasOwn(properties, key)) ||
    (schemas[index].required ?? []).some(key => !Object.hasOwn(args, key))
  )
    refuse('EMAIL_AUDIT_INPUT');
  if (index === 0) {
    if (!['site', 'sites', 'fleet'].includes(String(args.scope))) refuse('EMAIL_AUDIT_SCOPE');
    if (
      args.site_urls !== undefined &&
      (!Array.isArray(args.site_urls) ||
        args.site_urls.length < 1 ||
        args.site_urls.length > 200 ||
        args.site_urls.some(v => typeof v !== 'string'))
    )
      refuse('EMAIL_AUDIT_EXPLICIT_SITES_REQUIRED');
  } else if (typeof args.audit_id !== 'string' || !uuid.test(args.audit_id))
    refuse('EMAIL_AUDIT_ID');
  for (const [key, min, max] of [
    ['max_sites', 1, 10],
    ['max_pages_per_site', 1, 8],
    ['concurrency', 1, 2],
    ['offset', 0, Number.MAX_SAFE_INTEGER],
    ['limit', 1, 20],
    ['match_offset', 0, Number.MAX_SAFE_INTEGER],
    ['match_limit', 1, 100],
    ['max_duration_ms', 1000, 120000],
  ] as const)
    if (
      args[key] !== undefined &&
      (!Number.isInteger(args[key]) || Number(args[key]) < min || Number(args[key]) > max)
    )
      refuse('EMAIL_AUDIT_INPUT');
  if (
    args.retry_site_ids !== undefined &&
    (!Array.isArray(args.retry_site_ids) ||
      args.retry_site_ids.length > 200 ||
      new Set(args.retry_site_ids).size !== args.retry_site_ids.length)
  )
    refuse('EMAIL_AUDIT_RETRY_SCOPE');
  if (
    args.refresh_site_ids !== undefined &&
    (!Array.isArray(args.refresh_site_ids) ||
      args.refresh_site_ids.length > 200 ||
      new Set(args.refresh_site_ids).size !== args.refresh_site_ids.length ||
      args.refresh_site_ids.some(v => !Number.isSafeInteger(v) || Number(v) < 1))
  )
    refuse('EMAIL_AUDIT_REFRESH_SCOPE');
  if (index === 3 && !['json', 'csv'].includes(String(args.format))) refuse('EMAIL_AUDIT_FORMAT');
  return index;
}
export async function executeEmailAuditWithTransport(
  transport: EmailAuditTransport,
  name: string,
  args: ObjectValue,
  signal: AbortSignal | undefined,
  store: EmailAuditStorage
): Promise<ObjectValue> {
  const index = validateEmailAuditInput(name, args);
  if (!/^(?:[a-f0-9]{16}|[a-f0-9]{64})$/.test(transport.identity))
    refuse('EMAIL_AUDIT_IDENTITY_CHANGED');
  const deadline = Math.min(
    transport.deadlineAt ?? Infinity,
    Date.now() + (index === 1 ? Number(args.max_duration_ms ?? 20000) : 30000)
  );
  const call = async (ability: string, input: ObjectValue, internal = false, timeout = 30000) => {
    if (!supportingAbilities.has(ability)) refuse('EMAIL_AUDIT_SUPPORTING_ABILITY_MISSING');
    if (signal?.aborted) throw McpErrorFactory.cancelled();
    const remaining = deadline - Date.now();
    if (remaining < 1000) refuse('EMAIL_AUDIT_BATCH_BUDGET');
    return transport.call(ability, input, internal, Math.min(timeout, remaining), timeout);
  };
  const inventory = async (): Promise<Site[]> => {
    const sites: Site[] = [];
    let total = 0;
    for (let page = 1; page <= 20; page++) {
      const v = await call('mainwp/list-sites-v1', { page, per_page: 100 });
      if (
        !object(v) ||
        !Array.isArray(v.items) ||
        !Number.isInteger(v.total) ||
        Number(v.total) > 2000 ||
        (page > 1 && v.total !== total)
      )
        refuse('EMAIL_AUDIT_INVENTORY_CHANGED');
      total = Number(v.total);
      for (const item of v.items) {
        if (!object(item) || !Number.isInteger(item.id) || Number(item.id) < 1)
          refuse('EMAIL_AUDIT_INVENTORY');
        sites.push({ site_id: Number(item.id), site_url: url(item.url, true) });
      }
      if (sites.length === total) {
        if (
          new Set(sites.map(s => s.site_id)).size !== total ||
          new Set(sites.map(s => s.site_url)).size !== total
        )
          refuse('EMAIL_AUDIT_INVENTORY');
        return sites;
      }
      if (!v.items.length || sites.length > total) refuse('EMAIL_AUDIT_INVENTORY');
    }
    return refuse('EMAIL_AUDIT_INVENTORY_LIMIT');
  };
  const authorize = async (sites: Site[]): Promise<number> => {
    let actor = 0;
    for (let offset = 0; offset < sites.length;) {
      // The native read-only ability requires GET. Keep indexed PHP parameters
      // below the existing URL limit; never change method or weaken the ACL.
      const batch: Site[] = [];
      let encoded = 0;
      while (offset < sites.length && batch.length < 20) {
        const site = sites[offset];
        const cost = encodeURIComponent(site.site_url).length + 160;
        if (batch.length && encoded + cost > 6000) break;
        batch.push({ site_id: site.site_id, site_url: site.site_url });
        encoded += cost;
        offset++;
      }
      const v = await call(AUTHORIZE, { sites: batch }, true);
      if (
        !object(v) ||
        v.contract !== EMAIL_AUDIT_CONTRACT ||
        v.authorized !== true ||
        !Number.isInteger(v.actor_id) ||
        Number(v.actor_id) < 1 ||
        v.site_count !== batch.length ||
        (actor !== 0 && actor !== v.actor_id)
      )
        throw McpErrorFactory.permissionDenied('EMAIL_AUDIT_ACCESS_CHANGED');
      actor = Number(v.actor_id);
    }
    if (!actor) throw McpErrorFactory.permissionDenied('EMAIL_AUDIT_ACCESS_CHANGED');
    return actor;
  };
  if (index === 0) {
    if (typeof args.address !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(args.address))
      refuse('EMAIL_AUDIT_ADDRESS');
    const current = await inventory();
    let selected: Site[];
    if (args.scope === 'fleet') {
      if (args.site_urls !== undefined) refuse('EMAIL_AUDIT_SCOPE');
      selected = current;
    } else {
      if (
        !Array.isArray(args.site_urls) ||
        !args.site_urls.length ||
        (args.scope === 'site' && args.site_urls.length !== 1)
      )
        refuse('EMAIL_AUDIT_EXPLICIT_SITES_REQUIRED');
      const urls = (args.site_urls as unknown[]).map(v => url(v, true));
      if (new Set(urls).size !== urls.length) refuse('EMAIL_AUDIT_SCOPE');
      selected = urls.map(
        u => current.find(s => s.site_url === u) ?? refuse('EMAIL_AUDIT_SITE_MISSING')
      );
    }
    if (!selected.length || selected.length > 200) refuse('EMAIL_AUDIT_SCOPE_LIMIT');
    const actor = await authorize(selected),
      id = crypto.randomUUID();
    const job: EmailAuditJob = {
      schema: 1,
      audit_id: id,
      identity: transport.identity,
      actor_id: actor,
      dashboard_host: 'wpcontrol.mrndev.io',
      address: args.address.toLowerCase(),
      scope: args.scope as EmailAuditJob['scope'],
      created_at: new Date().toISOString(),
      inventory_total: current.length,
      rows: selected.map(s => ({
        ...s,
        status: s.site_url.startsWith('https://') ? 'pending' : 'failed',
        cursor: '',
        pages: 0,
        sync: 'not_attempted',
        limitations: s.site_url.startsWith('https://')
          ? []
          : ['insecure_child_origin_not_inspected'],
        ...(s.site_url.startsWith('https://') ? {} : { error_code: 'EMAIL_AUDIT_INSECURE_SITE' }),
        matches: [],
      })),
    };
    const unlock = store.lock(id);
    try {
      store.save(job);
    } finally {
      unlock();
    }
    return { ...emailAuditSummary(job), next_tool: EMAIL_AUDIT_TOOLS[1] };
  }
  const id = String(args.audit_id);
  const unlock = store.lock(id);
  try {
    const job = store.load(id);
    if (job.identity !== transport.identity || job.dashboard_host !== 'wpcontrol.mrndev.io')
      throw McpErrorFactory.permissionDenied('EMAIL_AUDIT_IDENTITY_CHANGED');
    const current = await inventory();
    for (const row of job.rows)
      if (!current.some(s => s.site_id === row.site_id && s.site_url === row.site_url))
        throw McpErrorFactory.permissionDenied('EMAIL_AUDIT_SITE_SCOPE_CHANGED');
    if ((await authorize(job.rows)) !== job.actor_id)
      throw McpErrorFactory.permissionDenied('EMAIL_AUDIT_ACTOR_CHANGED');
    if (index === 1) {
      for (const sid of (args.refresh_site_ids ?? []) as number[]) {
        const row = job.rows.find(r => r.site_id === sid);
        if (!row || row.status !== 'complete' || row.sync === 'not_attempted')
          refuse('EMAIL_AUDIT_REFRESH_SCOPE');
        row.status = 'pending';
        row.scan_complete = true;
        row.preparation = {
          sync_started_at: row.preparation?.sync_started_at ?? Date.parse(job.created_at),
          sync_outcome: row.preparation?.sync_outcome ?? 'interrupted',
          readback: 'pending',
          knowledge: 'pending',
        };
      }
      const retry = args.retry_site_ids ?? [];
      for (const sid of retry as number[]) {
        const row = job.rows.find(r => r.site_id === sid);
        if (!row || row.status !== 'failed') refuse('EMAIL_AUDIT_RETRY_SCOPE');
        row.status = 'pending';
        delete row.error_code;
      }
      // An interrupted read page may be resumed; no child write or update is ever replayed.
      for (const row of job.rows) if (row.status === 'inspecting') row.status = 'pending';
      const selected = job.rows
        .filter(r => r.status === 'pending')
        .slice(0, Number(args.max_sites ?? 2));
      let position = 0;
      const worker = async () => {
        while (position < selected.length) {
          const row = selected[position++];
          row.status = 'inspecting';
          store.save(job);
          try {
            // Persist independent preparation stages. Exhausting a batch is not
            // evidence that a read failed, nor permission to replay a sync that
            // the Dashboard may still be processing.
            row.preparation ??= {
              sync_started_at: Date.parse(job.created_at),
              ...(row.sync === 'not_attempted' ? {} : { sync_outcome: 'interrupted' }),
              readback: 'pending',
              knowledge: 'pending',
            };
            const preparation = row.preparation;
            const budgetError = (error: unknown) =>
              signal?.aborted ||
              (error instanceof Error && error.message.includes('EMAIL_AUDIT_BATCH_BUDGET'));
            if (preparation.knowledge === 'pending') {
              try {
                await call('mainwp/get-site-knowledge-v1', { site_id: row.site_id });
                row.limitations = row.limitations.filter(v => v !== 'site_knowledge_unavailable');
              } catch (error) {
                if (transport.fatal?.(error)) throw error;
                if (budgetError(error)) throw error;
                row.limitations.push('site_knowledge_unavailable');
              }
              preparation.knowledge = 'complete';
              store.save(job);
            }
            if (row.sync === 'not_attempted') {
              if (deadline - Date.now() < 1000) refuse('EMAIL_AUDIT_BATCH_BUDGET');
              row.sync = 'dispatched';
              preparation.sync_started_at = Date.now();
              store.save(job);
              try {
                await call(
                  'mainwp/sync-sites-v1',
                  { site_ids_or_domains: [row.site_id] },
                  false,
                  15000
                );
                row.sync = 'returned';
                preparation.sync_outcome = 'returned';
              } catch (error) {
                if (transport.fatal?.(error)) throw error;
                row.sync = 'timeout_or_refused';
                preparation.sync_outcome = 'timeout_or_refused';
                row.limitations.push('inventory_sync_unverified');
                store.save(job);
                if (budgetError(error)) throw error;
              }
              store.save(job);
            }
            if (preparation.readback === 'pending') {
              let siteValue: unknown;
              try {
                siteValue = await call('mainwp/get-site-v1', {
                  site_id_or_domain: row.site_url,
                  include_stats: false,
                });
              } catch (error) {
                if (transport.fatal?.(error)) throw error;
                if (budgetError(error)) throw error;
                row.limitations.push('inventory_readback_failed');
              }
              if (siteValue !== undefined) {
                if (
                  !object(siteValue) ||
                  siteValue.id !== row.site_id ||
                  url(siteValue.url) !== row.site_url
                )
                  refuse('EMAIL_AUDIT_SITE_IDENTITY');
                if (
                  typeof siteValue.last_sync === 'string' &&
                  Date.parse(siteValue.last_sync) >= preparation.sync_started_at - 1000
                ) {
                  row.sync = 'verified';
                  row.limitations = row.limitations.filter(
                    v =>
                      ![
                        'inventory_sync_failed',
                        'inventory_sync_unverified',
                        'inventory_readback_failed',
                        'inventory_freshness_unverified',
                      ].includes(v)
                  );
                } else row.limitations.push('inventory_freshness_unverified');
              }
              preparation.readback = 'complete';
              store.save(job);
            }
            if (row.scan_complete) {
              row.status = 'complete';
              store.save(job);
              continue;
            }
            for (let page = 0; page < Number(args.max_pages_per_site ?? 2); page++) {
              const v = cleanPage(
                await call(
                  INSPECT,
                  {
                    site_id: row.site_id,
                    site_url: row.site_url,
                    address: job.address,
                    cursor: row.cursor,
                  },
                  true
                ),
                row,
                job.address
              );
              if (!v.done && v.cursor === row.cursor) refuse('EMAIL_AUDIT_CURSOR_STALLED');
              const keys = new Set(
                row.matches.map(m =>
                  digest([
                    m.component,
                    m.form_id,
                    m.setting_path,
                    m.role,
                    m.match_type,
                    m.enabled_state,
                  ])
                )
              );
              for (const m of v.matches) {
                const k = digest([
                  m.component,
                  m.form_id,
                  m.setting_path,
                  m.role,
                  m.match_type,
                  m.enabled_state,
                ]);
                if (!keys.has(k)) {
                  row.matches.push(m);
                  keys.add(k);
                }
              }
              row.pages++;
              row.cursor = v.cursor;
              row.coverage = v.coverage;
              row.limitations = [...new Set([...row.limitations, ...v.limitations])];
              row.inspected_at = new Date().toISOString();
              row.status = v.done ? 'complete' : 'pending';
              if (v.done) {
                row.limitations = row.limitations.filter(
                  v => v !== 'settings_inspection_incomplete'
                );
                delete row.error_code;
              }
              store.save(job);
              if (v.done) break;
            }
          } catch (error) {
            if (transport.fatal?.(error)) throw error;
            if (
              signal?.aborted ||
              (error instanceof Error && error.message.includes('EMAIL_AUDIT_BATCH_BUDGET'))
            ) {
              row.status = 'pending';
              store.save(job);
              break;
            }
            row.status = 'failed';
            const upstream = error instanceof UpstreamHttpError ? error.upstreamCode : undefined;
            const status = getHttpStatus(error);
            const msg =
              upstream && /^EMAIL_AUDIT_[A-Z_]+$/.test(upstream)
                ? upstream
                : status === 401 || status === 403
                  ? 'EMAIL_AUDIT_PERMISSION'
                  : error instanceof Error
                    ? error.message
                    : '';
            row.error_code =
              /EMAIL_AUDIT_[A-Z_]+/.exec(msg)?.[0] ??
              (/timeout|timed out/i.test(msg)
                ? 'EMAIL_AUDIT_TIMEOUT'
                : 'EMAIL_AUDIT_INSPECTION_FAILED');
            row.limitations = [...new Set([...row.limitations, 'settings_inspection_incomplete'])];
            store.save(job);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(Number(args.concurrency ?? 1), selected.length) }, () =>
          worker()
        )
      );
      store.save(job);
    }
    if (index === 3) {
      const exportValue = {
        summary: emailAuditSummary(job),
        created_at: job.created_at,
        sites: job.rows.map(
          ({
            site_id,
            site_url,
            status,
            pages,
            scan_complete,
            sync,
            preparation,
            limitations,
            error_code,
            inspected_at,
            coverage,
            matches,
          }) => ({
            site_id,
            site_url,
            status,
            pages,
            scan_complete,
            sync,
            preparation,
            limitations,
            error_code,
            inspected_at,
            coverage,
            matches,
          })
        ),
      };
      const data =
        args.format === 'csv' ? emailAuditCsv(job) : JSON.stringify(exportValue, null, 2) + '\n';
      const file = store.write(id, data, '.results.' + String(args.format));
      const coverageFile =
        args.format === 'csv'
          ? store.write(
              id,
              JSON.stringify(
                exportValue.sites.map(({ matches: _matches, ...site }) => site),
                null,
                2
              ) + '\n',
              '.coverage.json'
            )
          : undefined;
      return {
        ...emailAuditSummary(job),
        file,
        coverage_file: coverageFile,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        bytes: Buffer.byteLength(data),
        permissions: '0600',
        delivery_verified: false,
      };
    }
    const offset = Number(args.offset ?? 0),
      limit = Number(args.limit ?? 10),
      matchOffset = Number(args.match_offset ?? 0),
      matchLimit = Number(args.match_limit ?? 50);
    return {
      ...emailAuditSummary(job),
      sites: job.rows.slice(offset, offset + limit).map(({ cursor: _cursor, matches, ...row }) => ({
        ...row,
        match_count: matches.length,
        matches: index === 1 ? [] : matches.slice(matchOffset, matchOffset + matchLimit),
        next_match_offset:
          matchOffset + matchLimit < matches.length ? matchOffset + matchLimit : null,
      })),
      next_offset: offset + limit < job.rows.length ? offset + limit : null,
    };
  } finally {
    unlock();
  }
}
