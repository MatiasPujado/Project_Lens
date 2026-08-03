#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { Registry } from './registry.js';
import { buildServer } from './tools.js';

const config = resolveConfig(process.argv[2]);
const registry = new Registry(config);
const stats = await registry.initialize();
console.error(
  `project-lens: ${stats.projects} projects in ${stats.groups} groups across ${stats.scanned_roots} roots (${stats.duration_ms} ms)`
);

serveStdio(() => buildServer(registry, config));
