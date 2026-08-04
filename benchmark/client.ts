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

export async function anyProject(client: Client): Promise<BenchProject> {
  const text = await callText(client, 'list_projects', {});
  const { projects } = JSON.parse(text) as { projects: BenchProject[] };
  if (projects.length === 0) throw new Error('no projects in registry; check config');
  return projects[0]!;
}
