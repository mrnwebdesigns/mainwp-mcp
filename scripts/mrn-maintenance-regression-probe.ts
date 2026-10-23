/** Read-only comparison of two fresh processes using the existing owner settings.
 * No policy overrides, receipt creation, client-site reads or production writes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MAINTENANCE_TOOLS } from '../src/mrn-maintenance.js';

const [previous, candidate, output] = process.argv.slice(2);
assert(previous && candidate && output, 'Pass previous entry, candidate entry and output path');
async function probe(entry: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {}); // Never retain credential-bearing diagnostics.
  const client = new Client({ name: 'mrn-maintenance-regression-readonly', version: '1' });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools;
    const resource = await client.readResource({ uri: 'mainwp://status' });
    assert('text' in resource.contents[0]);
    const status = JSON.parse(String(resource.contents[0].text));
    assert.equal(status.connected, true);
    assert.equal(status.dashboardHost, 'wpcontrol.mrndev.io');
    assert(status.abilitiesCount > 0);
    assert.equal(status.maintenance.core_enabled, false);
    assert.equal(status.maintenance.stock_update_fallback, false);
    for (const name of MAINTENANCE_TOOLS) assert(tools.some(t => t.name === name));
    for (const name of ['update_site_plugins_v1', 'update_site_themes_v1', 'update_site_core_v1'])
      assert(!tools.some(t => t.name === name));
    const args = {
      site_id: 9007199254740990,
      site_url: 'https://fixture.invalid',
      items: [{ slug: 'fixture/fixture.php', from: '1.0', to: '1.1' }],
      backup_receipt: {
        site_id: 9007199254740990,
        nonce: 'abcdef123456',
        receipt: 'unissued-fixture-receipt-only',
      },
    };
    for (const name of MAINTENANCE_TOOLS) {
      const input =
        name === MAINTENANCE_TOOLS[1]
          ? { ...args, items: [{ slug: 'fixture', from: '1.0', to: '1.1' }] }
          : args;
      const refused = await client.callTool({ name, arguments: input });
      assert.equal(refused.isError, true);
      assert(JSON.stringify(refused).includes('MAINTENANCE_BACKUP_UNPROVEN_OR_EXPIRED'));
    }
    const major = await client.callTool({
      name: MAINTENANCE_TOOLS[0],
      arguments: {
        ...args,
        items: [{ slug: 'fixture/fixture.php', from: '1.0', to: '2.0' }],
      },
    });
    assert.equal(major.isError, true);
    assert(JSON.stringify(major).includes('MAINTENANCE_MAJOR_VERSION_BLOCKED'));
    const core = await client.callTool({ name: 'update_site_core_v1', arguments: {} });
    assert.equal(core.isError, true);
    return { tools, status };
  } finally {
    await client.close();
  }
}
const before = await probe(previous),
  after = await probe(candidate);
assert.deepEqual(after.tools, before.tools);
fs.writeFileSync(
  output,
  JSON.stringify(
    {
      status: 'pass',
      previous,
      candidate,
      tool_count: after.tools.length,
      tool_schemas_unchanged: true,
      tools_added: [],
      tools_removed: [],
      missing_receipts_refused: true,
      majors_refused: true,
      core_refused: true,
      connected: true,
      dashboardHost: after.status.dashboardHost,
      abilitiesCount: after.status.abilitiesCount,
      production_writes: 0,
      configuration_changed: false,
      serving_chat_process_attested: false,
      candidate_entry_sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(candidate))
        .digest('hex'),
      candidate_maintenance_module_sha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(path.dirname(candidate), 'mrn-maintenance.js')))
        .digest('hex'),
    },
    null,
    2
  ) + '\n',
  { mode: 0o600 }
);
process.stdout.write(
  'PASS fresh processes, unchanged tool schemas and locally refused unsafe requests.\n'
);
