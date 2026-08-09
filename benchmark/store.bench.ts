import { resolveConfig } from '../src/config.js';
import { Registry } from '../src/registry.js';
import { printStats, stats } from './util.js';

const config = resolveConfig(process.argv[2]);

const coldStart = performance.now();
const registry = new Registry(config);
const scanStats = await registry.initialize();
const coldMs = performance.now() - coldStart;

console.log(
  `cold initialize: ~${coldMs.toFixed(0)} ms (single sample, ±10 ms run to run) ` +
    `(${scanStats.projects} projects, ${scanStats.groups} groups)`
);

const GET_ALL_ITERATIONS = 10_000;
let sink = 0;
const getAllStart = performance.now();
for (let i = 0; i < GET_ALL_ITERATIONS; i++) sink += registry.getAll().length;
const getAllUs = ((performance.now() - getAllStart) * 1000) / GET_ALL_ITERATIONS;
console.log(
  `getAll() x${GET_ALL_ITERATIONS}`.padEnd(28) +
    ` ${getAllUs.toFixed(3)} µs/call (batch mean)`
);

const findSamples: number[] = [];
for (let i = 0; i < 1_000; i++) {
  const start = performance.now();
  sink += registry.find('a').length;
  findSamples.push((performance.now() - start) * 1000);
}
printStats('find() x1000', stats(findSamples), 'µs');

const mem = process.memoryUsage();
console.log(
  `memory: rss=${(mem.rss / 1e6).toFixed(1)} MB heapUsed=${(mem.heapUsed / 1e6).toFixed(1)} MB ` +
    `(${sink} results consumed)`
);
