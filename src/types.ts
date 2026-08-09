export interface ProjectNode {
  name: string;
  groupPath: string;
  absolutePath: string;
  root: string;
  vcsType: 'git' | 'svn';
  detectedStack: string[];
  keyFiles: string[];
  readmePath?: string;
}

export interface LensConfig {
  roots: string[];
  exclude: string[];
  rootExclude?: Record<string, string[]>;
  allowWrites: boolean;
}
