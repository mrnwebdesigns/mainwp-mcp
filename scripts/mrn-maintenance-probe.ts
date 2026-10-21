/** Read-only fresh-process proof; deliberate write attempts are rejected locally before HTTP. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MAINTENANCE_TOOLS } from '../src/mrn-maintenance.js';

const [previous, candidate, snapshotPath, outputPath] = process.argv.slice(2);
assert(
  previous && candidate && snapshotPath && outputPath,
  'Pass old runtime, candidate runtime, policy-before.json, output.json'
);
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
const original: string[] = snapshot.oldPolicy.allowedTools;
assert(original.length === 67 && new Set(original).size === original.length);
async function connect(runtime: string, allowed: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [runtime],
    env: { ...process.env, MAINWP_ALLOWED_TOOLS: allowed.join(',') } as Record<string, string>,
    stderr: 'pipe',
  });
  // Consume rather than persist potentially sensitive inherited/runtime stderr.
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'mrn-maintenance-readonly-probe', version: '1' });
  await client.connect(transport);
  return { client, transport };
}
async function probe() {
  const before = await connect(previous, original);
  let baseline;
  try {
    baseline = (await before.client.listTools()).tools;
  } finally {
    await before.client.close();
  }
  const next = await connect(candidate, [...original, ...MAINTENANCE_TOOLS]);
  try {
    const tools = (await next.client.listTools()).tools;
    assert.deepEqual(baseline.map(t => t.name).sort(), [...original].sort());
    assert.deepEqual(tools.map(t => t.name).sort(), [...original, ...MAINTENANCE_TOOLS].sort());
    for (const tool of baseline)
      assert.deepEqual(
        tools.find(t => t.name === tool.name),
        tool
      );
    const resource = await next.client.readResource({ uri: 'mainwp://status' });
    assert('text' in resource.contents[0]);
    const status = JSON.parse(resource.contents[0].text);
    assert.equal(status.connected, true);
    assert.equal(status.dashboardHost, 'wpcontrol.mrndev.io');
    assert(status.abilitiesCount > 0);
    assert.equal(status.maintenance.core_enabled, false);
    assert.equal(status.maintenance.stock_update_fallback, false);
    assert.equal(status.maintenance.provider_ready, false);
    assert.equal(status.maintenance.execution_ready, false);
    const input = {
      site_id: 123456789,
      site_url: 'https://fixture.invalid',
      items: [{ slug: 'fixture/fixture.php', from: '6.35', to: '6.36' }],
    };
    const blocked = [];
    for (const name of MAINTENANCE_TOOLS) {
      const args =
        name === MAINTENANCE_TOOLS[1]
          ? { ...input, items: [{ slug: 'fixture', from: '6.35', to: '6.36' }] }
          : input;
      const result = await next.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      blocked.push({ name, missing_receipt_refused: true });
    }
    const major = await next.client.callTool({
      name: MAINTENANCE_TOOLS[0],
      arguments: {
        ...input,
        items: [{ slug: 'fixture/fixture.php', from: '6.35', to: '7.0' }],
        backup_receipt: {
          site_id: input.site_id,
          nonce: 'abcdef123456',
          receipt: 'fixture-unissued-receipt-12345678',
        },
      },
    });
    assert.equal(major.isError, true);
    assert(JSON.stringify(major).includes('MAINTENANCE_MAJOR_VERSION_BLOCKED'));
    const core = await next.client.callTool({ name: 'update_site_core_v1', arguments: {} });
    assert.equal(core.isError, true);
    const proof = {
      fresh_process_verified: true,
      dashboard_host: status.dashboardHost,
      abilities: status.abilitiesCount,
      previous_tools: baseline.length,
      replacement_tools: tools.length,
      added_tools: MAINTENANCE_TOOLS,
      existing_schemas_unchanged: true,
      core_refused: true,
      major_refused: true,
      receipt_checks: blocked,
      maintenance: status.maintenance,
      production_write_tested: false,
      client_site_requests: false,
    };
    fs.writeFileSync(outputPath, JSON.stringify(proof, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    process.stdout.write(JSON.stringify(proof, null, 2) + '\n');
  } finally {
    await next.client.close();
  }
}
try {
  await probe();
} catch {
  console.error('Fresh-process qualification failed; no production write was attempted.');
  process.exitCode = 1;
}
