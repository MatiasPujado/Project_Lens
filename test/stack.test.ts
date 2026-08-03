import { describe, expect, it } from 'vitest';
import { MANIFEST_FILES, detectStack } from '../src/stack.js';

describe('detectStack', () => {
  it('ignores files that map to no stack', () => {
    expect(detectStack(['package.json', 'notes.txt'])).toEqual(['Node.js']);
    expect(detectStack([])).toEqual([]);
  });

  it('deduplicates manifests that share a stack', () => {
    expect(detectStack(['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'])).toEqual(['Docker']);
    expect(detectStack(['pyproject.toml', 'requirements.txt'])).toEqual(['Python']);
  });

  it('reports every distinct stack in the manifest set', () => {
    expect(detectStack(['package.json', 'tsconfig.json']).sort()).toEqual(['Node.js', 'TypeScript']);
  });

  it('exposes every mapped manifest name for the discovery filter', () => {
    expect(MANIFEST_FILES.has('Cargo.toml')).toBe(true);
    expect(MANIFEST_FILES.has('notes.txt')).toBe(false);
  });
});
