import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');

export async function connect(name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: process.argv[2] ? [serverEntry, process.argv[2]] : [serverEntry],
      env: {
        ...getDefaultEnvironment(),
        ...(process.env.PROJECTS_MCP_CONFIG ? { PROJECTS_MCP_CONFIG: process.env.PROJECTS_MCP_CONFIG } : {}),
        ...(process.env.PROJECT_LENS_PATH ? { PROJECT_LENS_PATH: process.env.PROJECT_LENS_PATH } : {})
      }
    })
  );
  return client;
}

export async function callText(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

export interface BenchProject {
  name: string;
  group: string;
  absolute_path: string;
}

export interface ProjectTable {
  fields: string[];
  rows: unknown[][];
}

export function column(table: ProjectTable, field: string): (row: unknown[]) => string {
  const i = table.fields.indexOf(field);
  if (i < 0) throw new Error(`list_projects response has no "${field}" column`);
  return row => row[i] as string;
}

export async function anyProject(client: Client): Promise<BenchProject> {
  const table = JSON.parse(await callText(client, 'list_projects', {})) as ProjectTable;
  const first = table.rows[0];
  if (first === undefined) throw new Error('no projects in registry; check config');
  return {
    name: column(table, 'name')(first),
    group: column(table, 'group')(first),
    absolute_path: column(table, 'absolute_path')(first)
  };
}
