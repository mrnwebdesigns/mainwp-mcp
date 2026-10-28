/** Synthetic Dashboard/child fixtures only; never contacts or mutates client sites. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './index.js';
import { clearToolsCache } from './tools.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';
import {
  EMAIL_AUDIT_CONTRACT as CONTRACT,
  EMAIL_AUDIT_TOOLS as TOOLS,
  EmailAuditStore,
  executeEmailAudit,
  emailAuditCsv,
  emailAuditTools,
  emailAuditSummary,
} from './mrn-email-audit.js';
import type { Ability } from './abilities.js';
const fake = vi.hoisted(() => ({ catalog: vi.fn(), call: vi.fn() }));
vi.mock('./abilities.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./abilities.js')>()),
  fetchAbilities: fake.catalog,
  executeAbility: fake.call,
}));
const config = makeBaseConfig({
  dashboardUrl: 'https://wpcontrol.mrndev.io',
  skipSslVerify: false,
  safeMode: true,
  abilityNamespaces: ['mainwp', 'mrn-mainwp'],
  allowedTools: [
    ...TOOLS,
    'list_sites_v1',
    'sync_sites_v1',
    'get_site_v1',
    'get_site_knowledge_v1',
  ],
});
const logger = makeMockLogger();
let directory: string,
  store: EmailAuditStore,
  sites: Array<{ id: number; url: string }>,
  catalog: Ability[],
  permission: boolean,
  active: number,
  maxActive: number;
let child: (input: Record<string, unknown>) => Promise<unknown>;
let sync: (input: Record<string, unknown>) => Promise<unknown>;
const address = 'maintenance@mrnwebdesigns.com';
const page = (input: Record<string, unknown>, matches: unknown[] = [], next = '') => ({
  contract: CONTRACT,
  site_id: input.site_id,
  site_url: input.site_url,
  address,
  matches,
  limitations: [],
  next_cursor: next,
  scan_complete: !next,
  coverage: {
    scope: 'configuration',
    limitations: [],
    plugins: { 'wpforms/wpforms.php': { version: '1.0', active: true } },
  },
});
const match = (id = 1, extra: Record<string, unknown> = {}) => ({
  site_id: id,
  site_url: `https://site${id}.example`,
  component: 'wpforms',
  form_id: 12,
  form_title: 'Contact',
  setting_path: 'forms.12.notifications.1.email',
  role: 'recipient',
  match_type: 'direct',
  enabled_state: 'current',
  address,
  inspection_timestamp: new Date().toISOString(),
  ...extra,
});
const run = (index: number, args: Record<string, unknown>, c = config) =>
  executeEmailAudit(c, TOOLS[index], args, logger, undefined, store);
const start = (args: Record<string, unknown> = {}) => run(0, { address, scope: 'fleet', ...args });

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrn-email-fixture-'));
  fs.chmodSync(directory, 0o700);
  store = new EmailAuditStore(directory);
  sites = [1, 2, 3].map(id => ({ id, url: `https://site${id}.example/` }));
  permission = true;
  active = 0;
  maxActive = 0;
  catalog = [
    'mainwp/list-sites-v1',
    'mainwp/sync-sites-v1',
    'mainwp/get-site-v1',
    'mainwp/get-site-knowledge-v1',
    'mrn-mainwp/audit-email-address-v1',
    'mrn-mainwp/authorize-email-address-audit-v1',
  ].map(
    name =>
      ({
        name,
        label: name,
        description: name,
        category: 'fixture',
        input_schema: { type: 'object', properties: {} },
        meta: {
          annotations: { readonly: true, destructive: false, idempotent: true },
          mrn_email_audit_contract: CONTRACT,
        },
      }) as Ability
  );
  fake.catalog.mockResolvedValue(catalog);
  sync = async () => ({ synced: true });
  child = async input => page(input, input.site_id === 1 ? [match()] : []);
  fake.call.mockImplementation(
    async (_c: unknown, name: string, input: Record<string, unknown>) => {
      if (name === 'mainwp/list-sites-v1') {
        const offset = (Number(input.page) - 1) * Number(input.per_page);
        return {
          items: sites.slice(offset, offset + Number(input.per_page)),
          total: sites.length,
          page: input.page,
        };
      }
      if (name === 'mrn-mainwp/authorize-email-address-audit-v1') {
        if (!permission) throw new Error('EMAIL_AUDIT_PERMISSION');
        return {
          contract: CONTRACT,
          authorized: true,
          actor_id: 5,
          site_count: (input.sites as unknown[]).length,
        };
      }
      if (name === 'mainwp/sync-sites-v1') return sync(input);
      if (name === 'mainwp/get-site-v1') {
        const site = sites.find(s => s.url.replace(/\/$/, '') === input.site_id_or_domain);
        return { ...site, last_sync: new Date().toISOString() };
      }
      if (name === 'mainwp/get-site-knowledge-v1') return { context: [], items: [] };
      if (name === 'mrn-mainwp/audit-email-address-v1') {
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          return await child(input);
        } finally {
          active--;
        }
      }
      throw new Error('Unexpected ability, especially any write');
    }
  );
});
afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('native read-only email configuration audit', () => {
  it('honors explicit provider blocks and returns native WordPress admin evidence', async () => {
    await expect(
      run(
        0,
        { address, scope: 'fleet' },
        {
          ...config,
          blockedTools: ['mrn_mainwp__authorize_email_address_audit_v1'],
        }
      )
    ).rejects.toThrow('not allowed');
    child = async input =>
      page(input, [
        match(Number(input.site_id), {
          component: 'wordpress',
          form_id: null,
          form_title: '',
          setting_path: 'options.admin_email',
          role: 'admin_notification',
        }),
      ]);
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    const v = await run(1, { audit_id: s.audit_id });
    expect(v.current_matched).toBe(1);
    expect(store.load(String(s.audit_id)).rows[0].matches[0].component).toBe('wordpress');
  });
  it('discovers exactly the four opted-in tools over a fresh MCP connection with safe mode enabled', async () => {
    clearToolsCache();
    const { server } = await createServer(config);
    const client = new Client({ name: 'email-audit-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const names = (await client.listTools()).tools.map(t => t.name);
      expect(names.sort()).toEqual([...config.allowedTools!].sort());
      const result = await client.callTool({
        name: TOOLS[0],
        arguments: { address, scope: 'fleet', php: 'not permitted' },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('records an insecure child as failed without dropping other fleet sites', async () => {
    sites[1].url = 'http://site2.example/';
    const s = await start();
    expect(s.failed).toBe(1);
    const v = await run(1, { audit_id: s.audit_id, max_sites: 3 });
    expect(v.failed).toBe(1);
    expect(v.inspected).toBe(2);
    expect(v.finished).toBe(true);
    expect(
      fake.call.mock.calls
        .filter(c => c[1] === 'mrn-mainwp/audit-email-address-v1')
        .every(c => (c[2] as Record<string, unknown>).site_id !== 2)
    ).toBe(true);
  });
  it('stops at the batch deadline and resumes without marking unread sites unmatched', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    sync = async () => {
      now += 21000;
      return {};
    };
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    const v = await run(1, { audit_id: s.audit_id, max_duration_ms: 20000 });
    expect(v.pending).toBe(1);
    expect(v.unmatched).toBe(0);
    expect(v.inspected).toBe(0);
    const again = await run(1, { audit_id: s.audit_id, max_duration_ms: 20000 });
    expect(again.matched).toBe(1);
    expect(again.finished).toBe(true);
  });
  it('rejects credential-shaped evidence paths rather than returning them as ordinary matches', async () => {
    child = async input => page(input, [match(1, { setting_path: 'options.smtp.password' })]);
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    const v = await run(1, { audit_id: s.audit_id });
    expect(v.matched).toBe(0);
    expect(v.failed).toBe(1);
    expect(v.unmatched).toBe(0);
  });
  it('requires explicit scope and exact current inventory, never interprets an empty list as fleet', async () => {
    await expect(run(0, { address })).rejects.toThrow();
    await expect(start({ scope: 'sites', site_urls: [] })).rejects.toThrow();
    await expect(start({ scope: 'site', site_urls: ['https://other.example'] })).rejects.toThrow(
      'EMAIL_AUDIT_SITE_MISSING'
    );
    const v = await start({ scope: 'site', site_urls: ['https://site1.example/'] });
    expect(v.total).toBe(1);
    expect(v.scope).toBe('site');
  });
  it('paginates the complete 106-site inventory and records the exact fleet snapshot', async () => {
    sites = Array.from({ length: 106 }, (_, i) => ({
      id: i + 1,
      url: `https://site${i + 1}.example`,
    }));
    const v = await start();
    expect(v.total).toBe(106);
    expect(v.inventory_total).toBe(106);
    expect(
      fake.call.mock.calls
        .filter(c => c[1] === 'mainwp/list-sites-v1')
        .map(c => (c[2] as Record<string, unknown>).page)
    ).toEqual([1, 2]);
    expect(
      fake.call.mock.calls.some(
        c => String(c[1]).includes('audit-email-address-v1') && !String(c[1]).includes('authorize')
      )
    ).toBe(false);
  });
  it('resumes pagination without restarting sync and deduplicates evidence after read replay', async () => {
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    child = async input => page(input, [match()], input.cursor ? '' : 'opaque-child-cursor');
    let v = await run(1, { audit_id: s.audit_id, max_pages_per_site: 1 });
    expect(v.finished).toBe(false);
    expect(v.matched).toBe(1);
    v = await run(1, { audit_id: s.audit_id, max_pages_per_site: 1 });
    expect(v.finished).toBe(true);
    expect(store.load(String(s.audit_id)).rows[0].matches).toHaveLength(1);
    expect(fake.call.mock.calls.filter(c => c[1] === 'mainwp/sync-sites-v1')).toHaveLength(1);
  });
  it('keeps independent settings inspection after a targeted sync timeout, and marks the gap', async () => {
    sync = async input => {
      expect(input.site_ids_or_domains).toEqual([1]);
      throw new Error('timeout');
    };
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    const v = await run(1, { audit_id: s.audit_id });
    expect(v.matched).toBe(1);
    expect(v.incomplete).toBe(1);
    expect(v.failed).toBe(0);
    expect(store.load(String(s.audit_id)).rows[0].limitations).toContain('inventory_sync_failed');
  });
  it('bounds concurrency and keeps failed sites from aborting successful independent sites', async () => {
    child = async input => {
      await new Promise(r => setTimeout(r, 10));
      if (input.site_id === 2) throw new Error('Request timeout');
      return page(input, input.site_id === 1 ? [match()] : []);
    };
    const s = await start();
    const v = await run(1, { audit_id: s.audit_id, max_sites: 3, concurrency: 2 });
    expect(maxActive).toBe(2);
    expect(v.inspected).toBe(2);
    expect(v.matched).toBe(1);
    expect(v.unmatched).toBe(1);
    expect(v.failed).toBe(1);
    expect(v.incomplete).toBe(1);
    expect(v.finished).toBe(true);
    expect(store.load(String(s.audit_id)).rows[1].error_code).toBe('EMAIL_AUDIT_TIMEOUT');
    await expect(run(1, { audit_id: s.audit_id, concurrency: 3 })).rejects.toThrow();
  });
  it('only retries named failed sites when explicitly requested', async () => {
    child = async () => {
      throw new Error('timeout');
    };
    const s = await start();
    await run(1, { audit_id: s.audit_id, max_sites: 3 });
    const count = fake.call.mock.calls.length;
    await run(1, { audit_id: s.audit_id });
    expect(
      fake.call.mock.calls.slice(count).some(c => c[1] === 'mrn-mainwp/audit-email-address-v1')
    ).toBe(false);
    child = async input => page(input, [match(Number(input.site_id))]);
    const v = await run(1, { audit_id: s.audit_id, retry_site_ids: [2] });
    expect(v.matched).toBe(1);
    expect(v.failed).toBe(2);
  });
  it('marks unsupported storage incomplete and separates current from disabled/inherited references', async () => {
    child = async input => ({
      ...page(input, [match(1, { enabled_state: 'disabled', match_type: 'inherited' })]),
      limitations: ['configuration_store_unavailable:contact_form_7'],
    });
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    const v = await run(1, { audit_id: s.audit_id });
    expect(v.matched).toBe(1);
    expect(v.current_matched).toBe(0);
    expect(v.unmatched).toBe(0);
    expect(v.incomplete).toBe(1);
  });
  it('rechecks permissions and identity before reading or exporting existing results', async () => {
    const s = await start();
    permission = false;
    await expect(run(2, { audit_id: s.audit_id })).rejects.toThrow('EMAIL_AUDIT_PERMISSION');
    await expect(run(3, { audit_id: s.audit_id, format: 'json' })).rejects.toThrow();
    permission = true;
    await expect(
      run(2, { audit_id: s.audit_id }, { ...config, username: 'another-user' })
    ).rejects.toThrow('EMAIL_AUDIT_IDENTITY_CHANGED');
    sites[0].url = 'https://new-host.example';
    await expect(run(2, { audit_id: s.audit_id })).rejects.toThrow(
      'EMAIL_AUDIT_SITE_SCOPE_CHANGED'
    );
  });
  it('enforces exact allowlists, current provider contracts, Dashboard host and verified TLS', async () => {
    expect(emailAuditTools({ ...config, allowedTools: [] })).toHaveLength(0);
    expect(emailAuditTools(config)).toHaveLength(4);
    await expect(start({})).resolves.toBeTruthy();
    await expect(
      run(0, { address, scope: 'fleet' }, { ...config, allowedTools: [] })
    ).rejects.toThrow();
    await expect(
      run(0, { address, scope: 'fleet' }, { ...config, dashboardUrl: 'https://other.example' })
    ).rejects.toThrow('EMAIL_AUDIT_DASHBOARD_IDENTITY');
    await expect(
      run(0, { address, scope: 'fleet' }, { ...config, skipSslVerify: true })
    ).rejects.toThrow();
    catalog.pop();
    await expect(start()).rejects.toThrow('EMAIL_AUDIT_PROVIDER_UNAVAILABLE');
  });
  it('never accepts SQL/PHP selectors or promotes a missing reader into no matches', async () => {
    await expect(start({ php: 'echo 1;' })).rejects.toThrow();
    child = async () => ({ success: false, error_code: 'reader_missing' });
    const s = await start();
    const v = await run(1, { audit_id: s.audit_id, max_sites: 3 });
    expect(v.failed).toBe(3);
    expect(v.unmatched).toBe(0);
  });
  it('exports only minimal evidence, protects files and writes formula-safe CSV with coverage sidecar', async () => {
    child = async input => ({
      ...page(input, [
        match(1, {
          form_title: '=1+2',
          password: 'sensitive-secret',
          full_option: 'sensitive-secret',
        }),
      ]),
      password: 'sensitive-secret',
    });
    const s = await start({ scope: 'site', site_urls: ['https://site1.example'] });
    await run(1, { audit_id: s.audit_id });
    const v = await run(3, { audit_id: s.audit_id, format: 'json' });
    const data = fs.readFileSync(String(v.file), 'utf8');
    expect(data).not.toContain('sensitive-secret');
    expect(data).not.toContain('identity');
    expect(fs.statSync(String(v.file)).mode & 0o777).toBe(0o600);
    const csv = await run(3, { audit_id: s.audit_id, format: 'csv' });
    expect(fs.readFileSync(String(csv.file), 'utf8')).toContain("'=1+2");
    expect(fs.existsSync(String(csv.coverage_file))).toBe(true);
    expect(csv.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects path traversal, symlinks, concurrent live locks and nonprivate artifacts', async () => {
    expect(() => store.load('../../settings')).toThrow();
    const s = await start();
    const id = String(s.audit_id),
      unlock = store.lock(id);
    expect(() => store.lock(id)).toThrow('EMAIL_AUDIT_BUSY_OR_INTERRUPTED_LOCK');
    unlock();
    const file = path.join(directory, id + '.state.json');
    fs.chmodSync(file, 0o644);
    expect(() => store.load(id)).toThrow('EMAIL_AUDIT_PRIVATE_STORAGE');
    fs.chmodSync(file, 0o600);
    const saved = file + '.saved';
    fs.renameSync(file, saved);
    fs.symlinkSync(saved, file);
    expect(() => store.load(id)).toThrow('EMAIL_AUDIT_PRIVATE_STORAGE');
  });
  it('recovers only a dead-process lock after restart and resumes the same read cursor', async () => {
    const s = await start();
    fs.writeFileSync(
      path.join(directory, String(s.audit_id) + '.lock'),
      JSON.stringify({ pid: 2147483647 }),
      { mode: 0o600 }
    );
    expect((await run(2, { audit_id: s.audit_id })).total).toBe(3);
  });
  it('never calls plugin/theme/core updates, mail or submission operations', async () => {
    const s = await start();
    await run(1, { audit_id: s.audit_id, max_sites: 3 });
    expect(
      fake.call.mock.calls.every(c =>
        [
          'mainwp/list-sites-v1',
          'mainwp/sync-sites-v1',
          'mainwp/get-site-v1',
          'mainwp/get-site-knowledge-v1',
          'mrn-mainwp/audit-email-address-v1',
          'mrn-mainwp/authorize-email-address-audit-v1',
        ].includes(c[1])
      )
    ).toBe(true);
    const job = store.load(String(s.audit_id));
    expect(emailAuditSummary(job).finished).toBe(true);
    expect(emailAuditCsv(job)).toContain(address);
  });
});
