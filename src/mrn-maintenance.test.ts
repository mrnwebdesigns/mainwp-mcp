/** Protocol fixtures only. No real Dashboard or child is contacted. */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type Ability, clearCache, initRateLimiter } from './abilities.js';
import { createServer } from './index.js';
import { executeTool, getTools, clearToolsCache } from './tools.js';
import { handleReadResource } from './resources.js';
import { resetSessionData } from './session.js';
import {
  clearMaintenanceState,
  maintenanceTools,
  maintenanceStatus,
  MAINTENANCE_CONTRACT,
  MAINTENANCE_TOOLS,
} from './mrn-maintenance.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

const hash = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const receipt = {
  site_id: 7,
  nonce: 'abcdef123456',
  receipt: 'fixture-only-backup-receipt-123456',
};
const base = {
  site_id: 7,
  site_url: 'https://site.example',
  items: [{ slug: 'example/example.php', from: '6.35', to: '6.36' }],
  backup_receipt: receipt,
};
const config = makeBaseConfig({
  dashboardUrl: 'https://wpcontrol.mrndev.io',
  skipSslVerify: false,
  abilityNamespaces: ['mainwp', 'mrn-mainwp'],
  allowedTools: [...MAINTENANCE_TOOLS, 'mrn_mainwp__get_database_backup_status_v1', 'get_site_v1'],
});
const logger = makeMockLogger();
const names = ['preflight-maintenance-v1', 'execute-maintenance-v1', 'read-maintenance-state-v1'];
function ability(name: string, destructive = false, readonly = false): Ability {
  return {
    name: 'mrn-mainwp/' + name,
    label: name,
    description: name,
    category: 'mrn-mainwp',
    input_schema: { type: 'object', properties: {} },
    meta: {
      annotations: { destructive, readonly, idempotent: !destructive },
      mrn_maintenance_contract: MAINTENANCE_CONTRACT,
    } as Ability['meta'],
  };
}
let catalog: Ability[];
let requests: Array<{ name: string; input: Record<string, unknown> }>;
let planHash: string;
let planPatch: (value: Record<string, unknown>) => Record<string, unknown>;
let readPatch: (value: Record<string, unknown>) => Record<string, unknown>;
let executeMode: 'success' | 'partial' | 'lost';
let operations: number;
let receiptPatch: Record<string, unknown>;
const call = (
  input: Record<string, unknown> = base,
  name: string = MAINTENANCE_TOOLS[0],
  c = config
) => executeTool(c, name, input, logger);
const body = (r: Awaited<ReturnType<typeof call>>) => JSON.parse(r.content[0].text);
const writes = () => requests.filter(r => r.name === 'mrn-mainwp/' + names[1]);
async function issued(): Promise<void> {
  const r = await call(
    { site_id: 7, nonce: receipt.nonce },
    'mrn_mainwp__get_database_backup_status_v1'
  );
  expect(r.isError).not.toBe(true);
}
async function preview(
  input = base,
  name: string = MAINTENANCE_TOOLS[0]
): Promise<Record<string, unknown>> {
  const r = await call(input, name);
  expect(r.isError).not.toBe(true);
  return body(r);
}
async function confirmed(input = base, name: string = MAINTENANCE_TOOLS[0]) {
  const p = await preview(input, name);
  return call(
    { ...input, confirm: true, user_confirmed: true, confirmation_token: p.confirmation_token },
    name
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  clearCache();
  clearToolsCache();
  clearMaintenanceState();
  resetSessionData();
  initRateLimiter(0);
  catalog = [
    ability('get-database-backup-status-v1'),
    ...names.map((n, i) => ability(n, i === 1, i === 2)),
    { ...ability('get-site-v1', false, true), name: 'mainwp/get-site-v1' },
  ];
  requests = [];
  planHash = 'a'.repeat(64);
  planPatch = v => v;
  readPatch = v => v;
  executeMode = 'success';
  operations = 0;
  receiptPatch = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (raw: string, options: RequestInit) => {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/run')) return new Response(JSON.stringify(catalog));
      const name = decodeURIComponent(url.pathname.split('/abilities/')[1].slice(0, -4));
      const input = options.body
        ? JSON.parse(String(options.body)).input
        : url.searchParams.has('input_json')
          ? JSON.parse(url.searchParams.get('input_json')!)
          : Object.fromEntries(
              [...url.searchParams].map(([k, v]) => [k.replace(/^input\[([^\]]+)\]$/, '$1'), v])
            );
      requests.push({ name, input });
      if (name.endsWith('/get-database-backup-status-v1'))
        return new Response(
          JSON.stringify({ ...receipt, status: 'complete', receipt_ttl: 7200, ...receiptPatch })
        );
      if (name.endsWith('/preflight-maintenance-v1'))
        return new Response(
          JSON.stringify(
            planPatch({
              contract: MAINTENANCE_CONTRACT,
              ready: true,
              site_id: input.site_id,
              site_url: input.site_url,
              kind: input.kind,
              items: input.items,
              input_sha256: hash(input),
              plan_sha256: planHash,
              backup: {
                provider: 'updraftplus',
                site_id: input.site_id,
                nonce: receipt.nonce,
                receipt_sha256: hash(receipt.receipt),
                database_only: true,
                remote_verified: true,
                completed_at: Date.now() - 1000,
                expires_at: Date.now() + 600_000,
              },
            })
          )
        );
      if (name.endsWith('/execute-maintenance-v1')) {
        operations++;
        if (executeMode === 'lost') throw Error('simulated response loss');
        return new Response(
          JSON.stringify({
            contract: MAINTENANCE_CONTRACT,
            status: executeMode === 'partial' ? 'partial' : 'complete',
            request_id: input.request_id,
            site_id: input.site_id,
            site_url: input.site_url,
            plan_sha256: input.plan_sha256,
          })
        );
      }
      if (name.endsWith('/read-maintenance-state-v1'))
        return new Response(
          JSON.stringify(
            readPatch({
              contract: MAINTENANCE_CONTRACT,
              site_id: 7,
              site_url: base.site_url,
              kind: 'plugin',
              request_id: input.request_id,
              plan_sha256: input.plan_sha256,
              items: base.items.map(i => ({ slug: i.slug, version: i.to })),
              unrelated_unchanged: true,
              core_unchanged: true,
            })
          )
        );
      throw Error('Unexpected fixture request');
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MRN maintenance through the public executor', () => {
  it('adds exactly two opted-in tools and preserves the existing namespace surface', async () => {
    expect((await getTools(config, logger)).map(t => t.name).sort()).toEqual(
      [...config.allowedTools!].sort()
    );
    expect(maintenanceTools({ ...config, allowedTools: undefined })).toEqual([]);
    expect(
      (await getTools({ ...config, blockedTools: [MAINTENANCE_TOOLS[0]] })).some(
        t => t.name === MAINTENANCE_TOOLS[0]
      )
    ).toBe(false);
    expect(maintenanceTools(config)[0].inputSchema.properties).not.toHaveProperty('core');
  });
  it('keeps raw updates, batch/core, install, activation and deletion unexposed', async () => {
    for (const name of [
      'update_site_plugins_v1',
      'update_site_themes_v1',
      'update_site_core_v1',
      'run_updates_v1',
      'update_all_v1',
      'delete_site_plugins_v1',
      'install_site_plugins_v1',
      'activate_site_plugins_v1',
      'deactivate_site_plugins_v1',
    ])
      expect((await call(base, name)).isError).toBe(true);
    expect(requests).toEqual([]);
  });
  it.each([
    ['absent receipt', { ...base, backup_receipt: undefined }],
    [
      'forged receipt',
      { ...base, backup_receipt: { ...receipt, receipt: 'never-issued-receipt-123456789' } },
    ],
    ['other site', { ...base, backup_receipt: { ...receipt, site_id: 8 } }],
    ['empty selection', { ...base, items: [] }],
    ['unknown version', { ...base, items: [{ ...base.items[0], to: 'unknown' }] }],
    ['downgrade', { ...base, items: [{ ...base.items[0], to: '6.34' }] }],
    ['unchanged', { ...base, items: [{ ...base.items[0], to: '6.35' }] }],
    ['core injection', { ...base, type: 'core' }],
    ['extra nested input', { ...base, items: [{ ...base.items[0], core: true }] }],
    ['credential URL', { ...base, site_url: 'https://person:pass@site.example' }],
    ['non HTTPS', { ...base, site_url: 'http://site.example' }],
    ['URL query', { ...base, site_url: 'https://site.example?other=1' }],
    ['duplicate selection', { ...base, items: [base.items[0], base.items[0]] }],
  ])('refuses %s without a provider write', async (_label, input) => {
    await issued();
    expect((await call(input)).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('requires receipt provenance from this principal and process', async () => {
    expect((await call()).isError).toBe(true);
    await issued();
    expect(
      (await call(base, MAINTENANCE_TOOLS[0], { ...config, username: 'another' })).isError
    ).toBe(true);
    clearMaintenanceState();
    expect((await call()).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('refuses expired receipts even if the wall clock moves backward', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    await issued();
    clock.mockReturnValue(7200_001);
    vi.setSystemTime(now - 1_000);
    expect((await call()).isError).toBe(true);
    expect(writes()).toEqual([]);
    clock.mockRestore();
  });
  it('refuses an expired human confirmation without any write', async () => {
    vi.useFakeTimers();
    await issued();
    const p = await preview();
    vi.advanceTimersByTime(300_001);
    const r = await call({
      ...base,
      confirm: true,
      user_confirmed: true,
      confirmation_token: p.confirmation_token,
    });
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('preserves the existing session response budget', async () => {
    await issued();
    const r = await call(base, MAINTENANCE_TOOLS[0], { ...config, maxSessionData: 1 });
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it.each(['failed', 'running', 'pending'])('does not trust a %s backup response', async status => {
    receiptPatch = { status };
    await issued();
    expect((await call()).isError).toBe(true);
  });
  it.each([0, -1, 7201, '7200'])('rejects invalid receipt TTL %s', async receipt_ttl => {
    receiptPatch = { receipt_ttl };
    await issued();
    expect((await call()).isError).toBe(true);
  });
  it('blocks a leading digit change irrespective of provider flags', async () => {
    await issued();
    const r = await call({ ...base, items: [{ ...base.items[0], to: '7.0' }] });
    expect(JSON.stringify(body(r))).toContain('MAINTENANCE_MAJOR_VERSION_BLOCKED');
    expect(requests).toHaveLength(1);
  });
  it('binds a major override to one plugin and exact versions', async () => {
    await issued();
    const item = { ...base.items[0], to: '7.0' };
    const input = {
      ...base,
      items: [item],
      major_overrides: [{ ...item, reason: 'Explicit owner approval for this exact plugin.' }],
    };
    const p = await preview(input);
    expect(p.items).toEqual([item]);
    expect(writes()).toEqual([]);
    expect(
      (await call({ ...input, major_overrides: [{ ...input.major_overrides[0], to: '8.0' }] }))
        .isError
    ).toBe(true);
    expect((await call({ ...input, major_overrides: true })).isError).toBe(true);
  });
  it('allows minor theme previews and refuses theme major overrides', async () => {
    await issued();
    const item = { slug: 'example', from: '2.4', to: '2.5' };
    expect((await preview({ ...base, items: [item] }, MAINTENANCE_TOOLS[1])).kind).toBe('theme');
    expect(
      (await call({ ...base, items: [{ ...item, to: '3.0' }] }, MAINTENANCE_TOOLS[1])).isError
    ).toBe(true);
  });
  it.each([
    { safeMode: true },
    { requireUserConfirmation: false },
    { dashboardUrl: 'https://other.example' },
    { skipSslVerify: true },
    { blockedTools: [MAINTENANCE_TOOLS[0]] },
    { abilityNamespaces: ['mainwp'] as ['mainwp'] },
  ])('does not bypass policy %j', async patch => {
    await issued();
    expect((await call(base, MAINTENANCE_TOOLS[0], { ...config, ...patch })).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('reports a missing provider and never falls back to stock updates', async () => {
    await issued();
    catalog = catalog.filter(a => !a.name.includes('maintenance'));
    const r = await call();
    expect(r.isError).toBe(true);
    expect(JSON.stringify(body(r))).toContain('MAINTENANCE_PROVIDER_REQUIRED');
    expect(maintenanceStatus(config, catalog)).toMatchObject({
      execution_ready: false,
      provider_ready: false,
      core_enabled: false,
      stock_update_fallback: false,
    });
    expect(writes()).toEqual([]);
  });
  it('requires the exact provider contract and destructive classifications', async () => {
    await issued();
    Reflect.deleteProperty(catalog[1].meta!.annotations!, 'destructive');
    expect((await call()).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it.each(['remote_verified', 'database_only', 'provider', 'nonce', 'receipt_sha256', 'site_id'])(
    'refuses invalid backup attestation %s',
    async key => {
      await issued();
      planPatch = value => ({ ...value, backup: { ...(value.backup as object), [key]: false } });
      expect((await call()).isError).toBe(true);
      expect(writes()).toEqual([]);
    }
  );
  it('refuses expired and future server backup attestations', async () => {
    await issued();
    planPatch = v => ({
      ...v,
      backup: { ...(v.backup as object), completed_at: Date.now() + 1_000 },
    });
    expect((await call()).isError).toBe(true);
    planPatch = v => ({ ...v, backup: { ...(v.backup as object), expires_at: Date.now() - 1 } });
    expect((await call()).isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('requires a preview, exact token, and explicit human-confirmed flag', async () => {
    await issued();
    expect((await call({ ...base, confirm: true, user_confirmed: true })).isError).toBe(true);
    const p = await preview();
    const again = await call({ ...base, confirm: true, confirmation_token: p.confirmation_token });
    expect(again.isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('rejects changed or expired previews and refreshes server state before writing', async () => {
    await issued();
    const p = await preview();
    planHash = 'b'.repeat(64);
    expect(
      (
        await call({
          ...base,
          confirm: true,
          user_confirmed: true,
          confirmation_token: p.confirmation_token,
        })
      ).isError
    ).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('does not permit a changed item selection with an existing confirmation', async () => {
    await issued();
    const p = await preview();
    const r = await call({
      ...base,
      items: [{ ...base.items[0], to: '6.37' }],
      confirm: true,
      user_confirmed: true,
      confirmation_token: p.confirmation_token,
    });
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
  });
  it('executes once, independently reads back, and withholds secrets from audit and result', async () => {
    await issued();
    const p = await preview();
    const input = {
      ...base,
      confirm: true,
      user_confirmed: true,
      confirmation_token: p.confirmation_token,
    };
    const r = await call(input);
    expect(body(r).status).toBe('VERIFIED');
    expect(operations).toBe(1);
    expect(requests.at(-1)?.name).toBe('mrn-mainwp/read-maintenance-state-v1');
    expect((await call(input)).isError).toBe(true);
    expect(operations).toBe(1);
    expect(JSON.stringify([r, vi.mocked(logger.info).mock.calls])).not.toContain(receipt.receipt);
  });
  it('consumes confirmation synchronously under concurrent requests', async () => {
    await issued();
    const p = await preview();
    const input = {
      ...base,
      confirm: true,
      user_confirmed: true,
      confirmation_token: p.confirmation_token,
    };
    const result = await Promise.all([call(input), call(input)]);
    expect(result.filter(r => body(r).status === 'VERIFIED')).toHaveLength(1);
    expect(operations).toBe(1);
  });
  it('does not retry a lost write response', async () => {
    await issued();
    executeMode = 'lost';
    const r = await confirmed();
    expect(body(r)).toMatchObject({ status: 'OUTCOME_UNKNOWN', automatic_retry: false });
    expect(r.isError).toBe(true);
    expect(operations).toBe(1);
  });
  it('reports partial provider failures even when installed versions match', async () => {
    await issued();
    executeMode = 'partial';
    expect(body(await confirmed()).status).toBe('PARTIAL_OR_UNVERIFIED');
  });
  it.each(['unrelated_unchanged', 'core_unchanged'])('requires independent %s proof', async key => {
    await issued();
    readPatch = v => ({ ...v, [key]: false });
    expect(body(await confirmed()).status).toBe('PARTIAL_OR_UNVERIFIED');
  });
  it('exposes local schemas and provider availability in resources without changing other tools', async () => {
    const r = await handleReadResource(
      config,
      'mainwp://help/tool/' + MAINTENANCE_TOOLS[0],
      logger
    );
    expect(JSON.parse(r.contents[0].text).implementation).toBe('local-mrn-maintenance-gate');
  });
  it.each(['request_id', 'plan_sha256'])('refuses readback from another %s', async key => {
    await issued();
    readPatch = v => ({ ...v, [key]: 'different-operation' });
    expect(body(await confirmed()).status).toBe('PARTIAL_OR_UNVERIFIED');
  });
  it('discovers and refuses unsafe execution over the actual MCP handlers', async () => {
    catalog = catalog.filter(a => !a.name.includes('maintenance'));
    const { server } = await createServer(config);
    const client = new Client({ name: 'maintenance-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(
        [...config.allowedTools!].sort()
      );
      const r = await client.callTool({ name: MAINTENANCE_TOOLS[0], arguments: base });
      expect(r.isError).toBe(true);
      expect(writes()).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
