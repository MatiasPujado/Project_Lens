import { describe, expect, it } from 'vitest';
import { redactRemote } from '../src/git.js';

describe('redactRemote', () => {
  it('strips user:token from https remotes', () => {
    expect(redactRemote('https://mpujado:s3cr3t-token@gitea.home/Home_Servers/LinuxServices.git')).toBe(
      'https://gitea.home/Home_Servers/LinuxServices.git'
    );
  });

  it('strips bare-user userinfo', () => {
    expect(redactRemote('https://token@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('leaves clean https and scp-style ssh remotes untouched', () => {
    expect(redactRemote('https://gitea.home/AI/Project_Lens.git')).toBe('https://gitea.home/AI/Project_Lens.git');
    expect(redactRemote('git@gitea.home:AI/Project_Lens.git')).toBe('git@gitea.home:AI/Project_Lens.git');
  });
});
