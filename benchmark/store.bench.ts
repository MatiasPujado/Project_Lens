import { resolveConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { printStats, stats } from './util.js';

const config = resolveConfig(process.argv[2]);

const coldStart = performance.now();
const registry = new Registry(config);
const scanStats = await registry.initialize();
const coldMs = performance.now() - coldStart;
console.log(
  `cold initialize: ${coldMs.toFixed(1)} ms (${scanStats.projects} projects, ${scanStats.groups} groups)`
);

const getAllSamples: number[] = [];
for (let i = 0; i < 10_000; i++) {
  const start = performance.now();
  registry.getAll();
  getAllSamples.push((performance.now() - start) * 1000);
}
printStats('getAll() x10000', stats(getAllSamples), 'µs');

const findSamples: number[] = [];
for (let i = 0; i < 1_000; i++) {
  const start = performance.now();
  registry.find('a');
  findSamples.push((performance.now() - start) * 1000);
}
printStats('find() x1000', stats(findSamples), 'µs');

const mem = process.memoryUsage();
console.log(
  `memory: rss=${(mem.rss / 1e6).toFixed(1)} MB heapUsed=${(mem.heapUsed / 1e6).toFixed(1)} MB`
);
