import type { IFileSystem } from '@gugu/session-core/files';
import {
  defaultShareableProjectSettings,
  shareableProjectSettingsSchema,
  type ProjectSettings,
} from '@shared/core/project-settings/project-settings';
import { mergeShareableProjectSettings } from '@shared/core/project-settings/project-settings-fields';
import type { ProjectSettingsProvider } from './provider';

/**
 * 会话级共享配置(`.gugu.json`)读不了、被截断或写坏了 ⇒ 抛,带着文件路径与原因。
 * ❌ 退回项目设置照跑:队友提交的 shellSetup / 脚本悄悄不生效,agent 在缺环境的 shell 里跑,失败看着像代码的问题。
 */
export async function getEffectiveSessionSettings(args: {
  projectSettings: ProjectSettingsProvider;
  sessionFs: Pick<IFileSystem, 'exists' | 'readText'>;
  sessionConfigPath: string;
}): Promise<ProjectSettings> {
  const { projectSettings, sessionFs, sessionConfigPath } = args;
  const localShareableSettings = shareableProjectSettingsSchema.parse(await projectSettings.get());
  const defaults = defaultShareableProjectSettings();
  const invalid = (reason: string) => new Error(`Invalid session config ${sessionConfigPath}: ${reason}`);
  const exists = await sessionFs.exists(sessionConfigPath);
  if (!exists.success) throw invalid(`cannot check it (${exists.error.message})`);
  if (!exists.data) return mergeShareableProjectSettings(defaults, localShareableSettings);
  const content = await sessionFs.readText(sessionConfigPath);
  if (!content.success) throw invalid(`cannot read it (${content.error.message})`);
  if (content.data.truncated) throw invalid(`it is larger than the readable limit (${content.data.totalSize} bytes)`);
  let raw: unknown;
  try { raw = JSON.parse(content.data.content); }
  catch (error) { throw invalid(error instanceof Error ? error.message : String(error)); }
  const parsed = shareableProjectSettingsSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  return mergeShareableProjectSettings(defaults, parsed.data, localShareableSettings);
}
