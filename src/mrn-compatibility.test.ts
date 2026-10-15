/** MRN contracts verified against Dashboard 6.3 metadata; all writes are mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Ability, clearCache, initRateLimiter } from './abilities.js';
import { clearPendingPreviews } from './confirmation.js';
import { MAX_DECLARED_STRING_LENGTH, validateInput } from './security.js';
import { resetSessionData } from './session.js';
import { clearToolsCache, executeTool, getTools } from './tools.js';
import { makeBaseConfig, makeMockLogger } from '../tests/helpers/config.js';

const PACKAGE_CHARACTERS = 69_905_068;
const properties = {
  site_ids: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 1 } },
  plan_json: { type: 'string', maxLength: 1_048_576 },
  plan_sha256: { type: 'string' },
  filename: { type: 'string' },
  package_sha256: { type: 'string' },
  package_base64: { type: 'string', maxLength: PACKAGE_CHARACTERS },
  backup_receipts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        site_id: { type: 'integer' },
        nonce: { type: 'string' },
        receipt: { type: 'string' },
      },
    },
  },
  confirm: { type: 'boolean' },
};
const install: Ability = {
  name: 'mrn-mainwp/install-stack-release-v1',
  label: 'Install MRN Stack Release',
  description: 'Checksum-locked release requiring a fresh backup.',
  category: 'mrn-mainwp-operations',
  input_schema: {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
  meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
};
const rollback: Ability = {
  ...install,
  name: 'mrn-mainwp/rollback-stack-release-v1',
  input_schema: {
    type: 'object',
    properties: {
      site_ids: properties.site_ids,
      rollout_id: { type: 'string' },
      confirm: properties.confirm,
      backup_receipts: properties.backup_receipts,
    },
    required: ['site_ids', 'rollout_id', 'confirm', 'backup_receipts'],
  },
};
const knowledge: Ability = {
  ...install,
  name: 'mainwp/create-knowledge-record-v1',
  input_schema: {
    type: 'object',
    properties: {
      scope_type: { type: 'string' },
      scope_id: { type: 'integer' },
      type: { type: 'string' },
      title: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 10_000 },
      confirm: { type: 'boolean' },
      dry_run: { type: 'boolean' },
    },
    required: ['scope_type', 'type', 'title', 'body'],
  },
};
const config = makeBaseConfig({
  abilityNamespaces: ['mainwp', 'mrn-mainwp'],
  allowedTools: [
    'create_knowledge_record_v1',
    'mrn_mainwp__install_stack_release_v1',
    'mrn_mainwp__rollback_stack_release_v1',
  ],
});
const logger = makeMockLogger();
const mockFetch = vi.fn();
const installArgs = {
  site_ids: [7],
  plan_json: JSON.stringify({ target: 7, reviewed: true, padding: 'p'.repeat(12_000) }),
  plan_sha256: 'a'.repeat(64),
  filename: 'reviewed.zip',
  package_sha256: 'b'.repeat(64),
  package_base64: 'UEs=',
  backup_receipts: [{ site_id: 7, nonce: 'fresh-nonce', receipt: 'verified-backup' }],
  confirm: true,
};
const response = (value: unknown) => ({
  ok: true,
  json: async () => value,
  headers: new Headers(),
});

describe('MRN compatibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('fetch', mockFetch);
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    resetSessionData();
    initRateLimiter(0);
    mockFetch.mockResolvedValueOnce(response([install, rollback, knowledge]));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('accepts the complete 50 MiB base64 boundary and rejects the next character', () => {
    expect(MAX_DECLARED_STRING_LENGTH).toBe(PACKAGE_CHARACTERS);
    const value = 'A'.repeat(PACKAGE_CHARACTERS);
    expect(() => validateInput({ package_base64: value }, install.input_schema)).not.toThrow();
    expect(() => validateInput({ package_base64: value + 'A' }, install.input_schema)).toThrow(
      /maximum length/
    );
    expect(() =>
      validateInput(
        { package_base64: value + 'A' },
        {
          properties: { package_base64: { type: 'string', maxLength: Number.MAX_SAFE_INTEGER } },
        }
      )
    ).toThrow(/server ceiling/);
  });

  it('retains tighter plugin upload limits and the undeclared-string default', () => {
    expect(() =>
      validateInput(
        { package_base64: 'A'.repeat(34_952_537) },
        {
          properties: { package_base64: { type: 'string', maxLength: 34_952_536 } },
        }
      )
    ).toThrow(/34952536/);
    expect(() => validateInput({ plan_json: 'A'.repeat(10_001) })).toThrow(/10000/);
    expect(() => validateInput({ rows: [['A'.repeat(10_001)]] })).toThrow(/10000/);
  });

  it('discovers both namespaces with stable custom prefixes and an explicit allowlist', async () => {
    const tools = await getTools(config, logger);
    expect(tools.map(tool => tool.name).sort()).toEqual([...config.allowedTools!].sort());
    expect(
      tools.find(tool => tool.name === 'mrn_mainwp__install_stack_release_v1')?.inputSchema
        .properties
    ).toMatchObject({ package_base64: properties.package_base64 });
    const blocked = await executeTool(config, 'delete_site_v1', { site_id: 7 }, logger);
    expect(blocked.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('accepts string operation and rollout IDs without relaxing numeric site IDs', () => {
    const schema = {
      properties: {
        operation_id: { type: 'string' },
        rollout_id: { type: 'string' },
        site_id: { type: 'integer' },
      },
    };
    expect(() =>
      validateInput(
        {
          operation_id: '343048b0-7ce0-4475-bd9b-e31516df8904',
          rollout_id: 'release-2026.10.15',
          site_id: 7,
        },
        schema
      )
    ).not.toThrow();
    expect(() => validateInput({ site_id: 0 }, schema)).toThrow(/positive integer/);
    expect(() => validateInput({ operation_id: 'bad\nidentifier' }, schema)).toThrow(
      /control characters/
    );
  });

  it.each([
    { site_ids: [8] },
    { package_sha256: 'c'.repeat(64) },
    { plan_sha256: 'd'.repeat(64) },
    { backup_receipts: [{ site_id: 7, nonce: 'different', receipt: 'other-backup' }] },
  ])('binds approval to exact targets, checksums and backup receipts: %j', async mutation => {
    const preview = await executeTool(
      config,
      'mrn_mainwp__install_stack_release_v1',
      installArgs,
      logger
    );
    const token = JSON.parse(preview.content[0].text).confirmation_token;
    expect(JSON.parse(preview.content[0].text)).toMatchObject({
      status: 'CONFIRMATION_REQUIRED',
      next_action: 'confirm_without_preview',
      preview: null,
    });
    expect(typeof token).toBe('string');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const changed = await executeTool(
      config,
      'mrn_mainwp__install_stack_release_v1',
      {
        ...installArgs,
        ...mutation,
        user_confirmed: true,
        confirmation_token: token,
      },
      logger
    );
    expect(changed.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mrn_mainwp__install_stack_release_v1', installArgs],
    [
      'mrn_mainwp__rollback_stack_release_v1',
      {
        site_ids: [7],
        rollout_id: 'release-2026.10.15',
        backup_receipts: installArgs.backup_receipts,
        confirm: true,
      },
    ],
  ] as const)(
    'forwards the exact reviewed %s POST once, preserving provider gates',
    async (name, args) => {
      const unapproved = await executeTool(config, name, { ...args, user_confirmed: true }, logger);
      expect(unapproved.isError).toBe(true);
      const preview = await executeTool(config, name, args, logger);
      const token = JSON.parse(preview.content[0].text).confirmation_token;
      expect(mockFetch).toHaveBeenCalledTimes(1);
      mockFetch.mockResolvedValueOnce(response({ status: 'verified' }));
      const confirmed = await executeTool(
        config,
        name,
        { ...args, user_confirmed: true, confirmation_token: token },
        logger
      );
      expect(confirmed.isError).toBeUndefined();
      const [url, options] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(String(url)).toContain('/mrn-mainwp/');
      expect(options.method).toBe('POST');
      expect(JSON.parse(String(options.body))).toEqual({ input: args });
      const replay = await executeTool(
        config,
        name,
        { ...args, user_confirmed: true, confirmation_token: token },
        logger
      );
      expect(replay.isError).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    }
  );

  it('previews exact Knowledge content before permitting an approved write', async () => {
    const args = {
      scope_type: 'site',
      scope_id: 7,
      type: 'context',
      title: 'Reviewed context',
      body: 'Human-reviewed content',
      confirm: true,
    };
    mockFetch.mockResolvedValueOnce(
      response({ dry_run: true, would_save: { ...args, source: 'ability', verified: false } })
    );
    const preview = await executeTool(config, 'create_knowledge_record_v1', args, logger);
    const result = JSON.parse(preview.content[0].text);
    expect(preview.content[0].text).toContain('CONFIRMATION_REQUIRED');
    expect(preview.content[0].text).toContain(args.body);
    expect(JSON.parse(String(mockFetch.mock.calls[1][1].body))).toEqual({
      input: { ...args, dry_run: true, confirm: undefined },
    });
    mockFetch.mockResolvedValueOnce(response({ id: 1, verified: false }));
    const confirmed = await executeTool(
      config,
      'create_knowledge_record_v1',
      { ...args, user_confirmed: true, confirmation_token: result.confirmation_token },
      logger
    );
    expect(confirmed.isError).toBeUndefined();
    expect(JSON.parse(String(mockFetch.mock.calls[2][1].body))).toEqual({ input: args });
  });

  it('retains safe mode blocking before any deployment or Knowledge preview', async () => {
    for (const name of config.allowedTools!) {
      const result = await executeTool({ ...config, safeMode: true }, name, {}, logger);
      expect(result.content[0].text).toContain('SAFE_MODE_BLOCKED');
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
