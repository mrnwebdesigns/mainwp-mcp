/** Exercise the resolved SDK validators and wire, without a real Dashboard. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { clearCache, initRateLimiter, type Ability } from './abilities.js';
import { clearPendingPreviews } from './confirmation.js';
import { createServer } from './index.js';
import { resetSessionData } from './session.js';
import { clearToolsCache } from './tools.js';
import { makeBaseConfig } from '../tests/helpers/config.js';

const customName = 'mrn_mainwp__dependency_fixture_v1';
const text = '  <p>Policy café — https://site.example/%2f?a=%2Fb#section</p>  ';
const args = {
  site_id: 7,
  site_url: 'https://site.example',
  operation_id: '343048b0-7ce0-4475-bd9b-e31516df8904',
  document: { page_content_rows: [{ acf_fc_layout: 'body_text', field_body: text }] },
  confirm: true,
};
const abilities: Ability[] = [
  {
    name: 'mainwp/list-sites-v1',
    label: 'List Sites',
    description: 'Fixture inventory.',
    category: 'mainwp-sites',
    input_schema: { type: 'object', properties: {} },
    meta: { annotations: { readonly: true, destructive: false, idempotent: true } },
  },
  {
    name: 'mrn-mainwp/dependency-fixture-v1',
    label: 'Dependency Fixture',
    description: 'Mock-only structured content write, with no child-site execution.',
    category: 'mrn-mainwp-operations',
    input_schema: {
      type: 'object',
      properties: {
        site_id: { type: 'integer' },
        site_url: { type: 'string', format: 'uri' },
        operation_id: { type: 'string' },
        document: { type: 'object' },
        confirm: { type: 'boolean' },
      },
      required: Object.keys(args),
      additionalProperties: false,
    },
    meta: { annotations: { readonly: false, destructive: true, idempotent: false } },
  },
];
const mockFetch = vi.fn();

describe('patched transport dependency compatibility', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    clearCache();
    clearToolsCache();
    clearPendingPreviews();
    resetSessionData();
    initRateLimiter(0);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(abilities)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps tool argument URL and content bytes opaque while rejecting malformed protocol shapes', () => {
    // Tool argument strings are not Zod URL schemas. The provider remains the
    // authority for exact site identity; the SDK must not trim signed inputs.
    for (const site_url of ['https://site.example/', ' https://site.example ', 'https://x/%2f']) {
      const request = {
        method: 'tools/call',
        params: { name: customName, arguments: { ...args, site_url } },
      };
      expect(CallToolRequestSchema.parse(request).params.arguments).toEqual(
        request.params.arguments
      );
    }
    expect(
      CallToolRequestSchema.safeParse({
        method: 'tools/call',
        params: { name: customName, arguments: [] },
      }).success
    ).toBe(false);
    expect(
      CallToolRequestSchema.safeParse({
        method: 'tools/call',
        params: { name: 7, arguments: args },
      }).success
    ).toBe(false);
  });

  it('discovers both namespaces and preserves reviewed nested content through the actual SDK wire', async () => {
    const { server } = await createServer(
      makeBaseConfig({
        abilityNamespaces: ['mainwp', 'mrn-mainwp'],
        allowedTools: ['list_sites_v1', customName],
      })
    );
    const client = new Client({ name: 'dependency-compatibility-fixture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name).sort()).toEqual(
        [customName, 'list_sites_v1'].sort()
      );
      expect(
        list.tools.find(tool => tool.name === customName)?.inputSchema.properties
      ).toMatchObject({
        operation_id: { type: 'string' },
        site_url: { type: 'string', format: 'uri' },
        document: { type: 'object' },
        confirmation_token: { type: 'string' },
      });
      const preview = await client.callTool({ name: customName, arguments: args });
      const parsed = JSON.parse((preview.content as Array<{ text: string }>)[0].text);
      expect(parsed.status).toBe('CONFIRMATION_REQUIRED');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const altered = await client.callTool({
        name: customName,
        arguments: {
          ...args,
          site_url: args.site_url + '/',
          user_confirmed: true,
          confirmation_token: parsed.confirmation_token,
        },
      });
      expect(altered.isError).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // A changed input consumes its token. Obtain a fresh preview and approve
      // the exact original bytes; the only POST goes to the mocked Dashboard.
      const fresh = await client.callTool({ name: customName, arguments: args });
      const token = JSON.parse(
        (fresh.content as Array<{ text: string }>)[0].text
      ).confirmation_token;
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ fixture_verified: true })));
      const confirmed = await client.callTool({
        name: customName,
        arguments: { ...args, user_confirmed: true, confirmation_token: token },
      });
      expect(confirmed.isError).not.toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [url, options] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(String(url)).toContain('/mrn-mainwp/dependency-fixture-v1/run');
      expect(options.method).toBe('POST');
      expect(JSON.parse(String(options.body))).toEqual({ input: args });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
