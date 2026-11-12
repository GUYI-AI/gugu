// #2569 the first message sent in the sample turns it into the person's own project: project → its files → its group →
// the project's new-task box sends the message → the sample is dismissed last. Every step that fails stops there with a
// reason and leaves the typed message where it was; sending again picks up from what the account key recorded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SampleProjectState } from '@/lib/sampleProject';
import { composerDrafts } from '../sessions/composer-drafts';
import { zhCNSampleProject } from './content/zh-CN';
import { convertSampleProject, resetSampleConversion, sampleConversion, type SampleConversionDeps } from './sample-conversion';

const DRAFT = 'sample-project';
const seed = { name: '周末去杭州', files: zhCNSampleProject.files };
const fileNames = zhCNSampleProject.files.map((file) => file.name);

/** The account key, the machine's projects and folders, and the order things happened in. */
function world(start: SampleProjectState | null = { version: 1, dismissed: false }) {
  const steps: string[] = [];
  const projects = new Set<string>();
  const taken = new Set<string>();
  const nudges: boolean[] = [];
  let key = start;
  let created = 0;
  let sessionStarts: (() => void) | null = null;
  const deps: SampleConversionDeps = {
    readKey: async () => key,
    recordProject: async (projectId) => {
      steps.push('record project');
      key = { version: 2, dismissed: key?.dismissed ?? false, projectId };
    },
    recordGroup: async (projectId, chatId) => {
      steps.push('record group');
      key = { version: 2, dismissed: key?.dismissed ?? false, projectId, chatId };
    },
    dismiss: async () => {
      steps.push('dismiss');
      if (key) key = { ...key, dismissed: true };
    },
    projectExists: (projectId) => projects.has(projectId),
    defaultDirectory: async () => '/Users/p/projects',
    pathTaken: async (path) => taken.has(path),
    createProject: async (path, name) => {
      const projectId = `project-${++created}`;
      projects.add(projectId);
      taken.add(path);
      steps.push(`project ${name}`);
      return projectId;
    },
    projectFolder: async (projectId) => `${projectId}:folder`,
    writeFile: async (_projectId, workspaceId, name) => { steps.push(`file ${name} in ${workspaceId}`); },
    ensureGroup: async (projectId) => {
      steps.push('group');
      return `chat-of-${projectId}`;
    },
    rowShown: async (_projectId, nudge) => {
      nudges.push(nudge);
      return true;
    },
    handOff: (projectId, onCreated) => {
      steps.push(`open ${projectId}`);
      sessionStarts = onCreated;
    },
    logError: () => {},
  };
  return {
    deps,
    steps,
    taken,
    nudges,
    projects,
    get key() { return key; },
    get created() { return created; },
    /** The project's new-task box created the task. */
    taskCreated: async () => {
      steps.push('session');
      sessionStarts?.();
      await Promise.resolve();
    },
  };
}

const draft = () => composerDrafts.forKey(DRAFT);

beforeEach(() => {
  resetSampleConversion();
  draft().setPrompt('周六下雨的话改成什么？');
});
afterEach(() => composerDrafts.discard(DRAFT));

describe('turning the sample into the person\'s project (#2569)', () => {
  it('goes project → files → group → open the project → task → dismiss, the sample dismissed last', async () => {
    const w = world();
    w.taken.add('/Users/p/projects/周末去杭州');
    await convertSampleProject(w.deps, seed);
    expect(w.steps).toEqual([
      'project 周末去杭州 2',
      'record project',
      ...fileNames.map((name) => `file ${name} in project-1:folder`),
      'group',
      'record group',
      'open project-1',
    ]);
    expect(sampleConversion).toMatchObject({ status: 'handed-off', failure: null, chatId: 'chat-of-project-1' });
    expect(w.key, 'not dismissed before the task exists').toEqual({ version: 2, dismissed: false, projectId: 'project-1', chatId: 'chat-of-project-1' });
    await w.taskCreated();
    expect(w.steps.slice(-2)).toEqual(['session', 'dismiss']);
    expect(w.key).toMatchObject({ dismissed: true, projectId: 'project-1' });
  });

  const failures: [string, string, (deps: SampleConversionDeps) => void][] = [
    ['no default projects directory', 'no-default-directory', (deps) => { deps.defaultDirectory = async () => ''; }],
    ['every folder name taken', 'no-free-folder', (deps) => { deps.pathTaken = async () => true; }],
    ['the folder or project cannot be created', 'create', (deps) => { deps.createProject = async () => { throw new Error('EACCES'); }; }],
    ['the project cannot be recorded on the account', 'record', (deps) => { deps.recordProject = async () => { throw new Error('offline'); }; }],
    ['a file cannot be written', 'files', (deps) => { deps.writeFile = async () => { throw new Error('disk full'); }; }],
    ['the group cannot be created', 'group', (deps) => { deps.ensureGroup = async () => { throw new Error('cloud-failed'); }; }],
    ['the project never shows up in the list', 'row', (deps) => { deps.rowShown = async () => false; }],
    ['the project cannot be opened', 'open', (deps) => { deps.handOff = () => { throw new Error('draft taken'); }; }],
  ];
  it.each(failures)('%s: stops there with that reason, keeps the message, dismisses nothing', async (_name, kind, breakIt) => {
    const w = world();
    breakIt(w.deps);
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.status).toBe('idle');
    expect(sampleConversion.failure?.kind).toBe(kind);
    if (sampleConversion.failure && 'error' in sampleConversion.failure) expect(sampleConversion.failure.error).toBeInstanceOf(Error);
    expect(sampleConversion.chatId, 'the sample keeps its row').toBeNull();
    expect(draft().prompt).toBe('周六下雨的话改成什么？');
    expect(w.steps).not.toContain('dismiss');
    expect(w.key?.dismissed).toBe(false);
  });

  it('sending again after a failure continues with the recorded project instead of making a second one', async () => {
    const w = world();
    const ensure = w.deps.ensureGroup;
    w.deps.ensureGroup = async () => { throw new Error('cloud-failed'); };
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.failure?.kind).toBe('group');
    expect(w.key).toEqual({ version: 2, dismissed: false, projectId: 'project-1' });

    w.deps.ensureGroup = ensure;
    w.steps.length = 0;
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    // The group was never made, so the files are written again before it (nothing of the person's to overwrite yet).
    expect(w.steps).toEqual([...fileNames.map((name) => `file ${name} in project-1:folder`), 'group', 'record group', 'open project-1']);
    expect(sampleConversion).toMatchObject({ status: 'handed-off', failure: null });
    expect(w.nudges, 'only the retry asks the project list to read again').toEqual([true]);
  });

  it('a project the account could not record is still the one a retry in this window continues with', async () => {
    const w = world();
    const record = w.deps.recordProject;
    w.deps.recordProject = async () => { throw new Error('offline'); };
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.failure?.kind).toBe('record');
    w.deps.recordProject = record;
    w.steps.length = 0;
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    expect(w.steps[0]).toBe('record project');
    expect(w.steps.at(-1)).toBe('open project-1');
  });

  it('a retry once the group is recorded does not write the files again', async () => {
    const w = world();
    w.deps.rowShown = async () => false;
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.failure?.kind).toBe('row');
    w.deps.rowShown = async () => true;
    w.steps.length = 0;
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    expect(w.steps).toEqual(['group', 'open project-1']);
  });

  it('a second press while it runs does nothing: one project', async () => {
    const w = world();
    await Promise.all([convertSampleProject(w.deps, seed), convertSampleProject(w.deps, seed)]);
    expect(w.created).toBe(1);
    expect(w.steps.filter((step) => step.startsWith('open'))).toEqual(['open project-1']);
  });

  it('another window that finds the conversion recorded continues it: no project, no files, same project opened', async () => {
    const w = world({ version: 2, dismissed: false, projectId: 'project-7', chatId: 'chat-of-project-7' });
    w.projects.add('project-7');
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(0);
    expect(w.steps).toEqual(['group', 'open project-7']);
  });

  it('a recorded project that is gone from this computer is made again', async () => {
    const w = world({ version: 2, dismissed: false, projectId: 'project-elsewhere' });
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    expect(w.steps[0]).toBe('project 周末去杭州');
  });

  it('a sample already dismissed elsewhere is left alone', async () => {
    const w = world({ version: 2, dismissed: true, projectId: 'project-7', chatId: 'chat-of-project-7' });
    await convertSampleProject(w.deps, seed);
    expect(w.steps).toEqual([]);
    expect(sampleConversion).toMatchObject({ status: 'idle', failure: null });
  });
});
