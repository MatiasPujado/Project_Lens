export interface ProjectNode {
  name: string;
  groupPath: string;
  absolutePath: string;
  root: string;
  detectedStack: string[];
  keyFiles: string[];
  readmePath?: string;
  scannedAt: number;
}

export interface LensConfig {
  roots: string[];
  exclude: string[];
}
