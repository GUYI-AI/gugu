import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANTIGRAVITY_LAUNCH_SCRIPT, ANTIGRAVITY_PROBE_LAUNCH_SCRIPT } from './session-bundle';

const MCP = '{"mcpServers":{"supabase":{"command":"npx","args":["-y","@supabase/mcp-server-supabase@latest"]}}}';

describe('Antigravity 只读探测的启动器(无 MCP 的探测根)', () => {
  let root: string;
  let managed: string;
  let realHome: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agy-probe-'));
    realHome = join(root, 'real');
    managed = join(root, 'shadow', '.gemini');
    mkdirSync(join(realHome, 'Library', 'Keychains'), { recursive: true });
    mkdirSync(join(managed, 'config'), { recursive: true });
    mkdirSync(join(managed, 'antigravity-cli'), { recursive: true });
    writeFileSync(join(managed, 'settings.json'), '{"modelProvider":"x"}');
    writeFileSync(join(managed, 'jetski-standalone-oauth-token'), 'token');
    writeFileSync(join(managed, 'antigravity-cli', 'antigravity-oauth-token'), 'cli-token');
    writeFileSync(join(managed, 'mcp_config.json'), MCP); // 老位置
    writeFileSync(join(managed, 'config', 'mcp_config.json'), MCP);
    writeFileSync(join(managed, 'config', 'plugins.json'), '[]');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // 让「agy」是一条 sh 命令:在影子 home 里读 agy 会读到的东西。
  const asAgy = (script: string, command: string) =>
    execFileSync('/bin/sh', ['-c', script, '/bin/sh', '-c', command], {
      env: { PATH: '/usr/bin:/bin', HOME: realHome, GEMINI_HOME: managed },
      encoding: 'utf8',
    }).trim();

  it('agy 读到的 MCP 配置是空的,凭据与其余配置仍是托管根里的同一份', () => {
    expect(asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/config/mcp_config.json"')).toBe('{"mcpServers":{}}');
    // 老位置的 mcp_config.json 不链过去
    expect(() => readFileSync(join(managed, '..', '.gugu-probe', '.gemini', 'mcp_config.json'))).toThrow();
    // 登录凭据 / 设置 / 其余 config 走软链,读到的就是托管根里那份(不是复制)
    expect(asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"')).toBe('cli-token');
    expect(asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/jetski-standalone-oauth-token"')).toBe('token');
    expect(asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/config/plugins.json"')).toBe('[]');
    const probe = join(managed, '..', '.gugu-probe', '.gemini');
    expect(lstatSync(join(probe, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(probe, 'antigravity-cli'))).toBe(join(managed, 'antigravity-cli'));
    // 托管根里的 MCP 配置一个字都没动
    expect(readFileSync(join(managed, 'config', 'mcp_config.json'), 'utf8')).toBe(MCP);
    expect(readFileSync(join(managed, 'mcp_config.json'), 'utf8')).toBe(MCP);
  });

  it('对照:真会话用的启动器仍然把 MCP 配置原样给 agy(探测根只用于只读探测)', () => {
    expect(asAgy(ANTIGRAVITY_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/config/mcp_config.json"')).toBe(MCP);
  });

  it('钥匙串软链照旧接在探测根的 HOME 上,重复探测幂等,托管根后来新增的文件下一次就跟上', () => {
    const home = () => asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'echo "$HOME"');
    const probeShadow = join(managed, '..', '.gugu-probe');
    expect(home()).toBe(probeShadow);
    expect(readlinkSync(join(probeShadow, 'Library', 'Keychains'))).toBe(join(realHome, 'Library', 'Keychains'));
    writeFileSync(join(managed, 'config', 'hooks.json'), '{}');
    expect(asAgy(ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, 'cat "$HOME/.gemini/config/hooks.json"')).toBe('{}');
    expect(home()).toBe(probeShadow);
  });

  it('GEMINI_HOME 不是托管那份 ⇒ 拒绝起,❌ 回落用户真 HOME', () => {
    expect(() =>
      execFileSync('/bin/sh', ['-c', ANTIGRAVITY_PROBE_LAUNCH_SCRIPT, '/usr/bin/true'], {
        env: { PATH: '/usr/bin:/bin', HOME: realHome, GEMINI_HOME: join(root, 'elsewhere') },
        stdio: 'pipe',
      })
    ).toThrow();
  });
});
