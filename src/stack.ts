const manifestStack: Record<string, string> = {
  'package.json': 'Node.js',
  'tsconfig.json': 'TypeScript',
  'Cargo.toml': 'Rust',
  'go.mod': 'Go',
  'pyproject.toml': 'Python',
  'requirements.txt': 'Python',
  'pom.xml': 'Java',
  'build.gradle': 'Gradle',
  'build.gradle.kts': 'Gradle',
  Dockerfile: 'Docker',
  'docker-compose.yml': 'Docker',
  'docker-compose.yaml': 'Docker',
  'CMakeLists.txt': 'C/C++'
};

export const MANIFEST_FILES = new Set(Object.keys(manifestStack));

export function detectStack(manifests: string[]): string[] {
  const stacks = new Set<string>();
  for (const m of manifests) {
    const stack = manifestStack[m];
    if (stack) stacks.add(stack);
  }
  return [...stacks];
}
