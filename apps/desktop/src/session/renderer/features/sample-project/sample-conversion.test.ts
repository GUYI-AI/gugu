// #2569 the first message sent in the sample turns it into the person's own project: project → its files → its group →
// open it and hand the message to its new-task box → the sample is dismissed. Every step that fails stops there with a
// reason and leaves the typed message where it was; sending again picks up from what the account key recorded.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SampleProjectState } from '@/lib/sampleProject';
import { composerDrafts } from '../sessions/composer-drafts';
import { zhCNSampleProject } from './content/zh-CN';
import {
  convertSampleProject,
  resetSampleConversion,
  sampleConversion,
  sampleConversionOf,
  type SampleConversionDeps,
} from './sample-conversion';

const DRAFT = 'sample-project';
const seed = { name: '周末去杭州', files: zhCNSampleProject.files };
const fileNames = zhCNSampleProject.files.map((file) => file.name);

/** The account key, the machine's projects and folders, and the order things happened in. */
function world(start: SampleProjectState | null = { version: 1, dismissed: false }, owner = 'user-a') {
  const steps: string[] = [];
  const projects = new Set<string>();
  const taken = new Set<string>();
  const nudges: boolean[] = [];
  const paths: string[] = [];
  const dismissFailures: unknown[] = [];
  const errors: string[] = [];
  let key = start;
  let created = 0;
  let signedIn = true;
  const deps: SampleConversionDeps = {
    owner,
    signedIn: () => signedIn,
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
    dismissFailed: (error) => { dismissFailures.push(error); },
    projectExists: (projectId) => projects.has(projectId),
    defaultDirectory: async () => '/Users/p/projects',
    pathTaken: async (path) => taken.has(path),
    createProject: async (path, name) => {
      const projectId = `${owner}:project-${++created}`;
      projects.add(projectId);
      taken.add(path);
      paths.push(path);
      steps.push(`project ${name}`);
      return projectId;
    },
    projectFolder: async (projectId) => `${projectId}:folder`,
    writeFile: async (_projectId, workspaceId, name) => { steps.push(`file ${name} in ${workspaceId}`); },
    ensureGroup: async (projectId) => {
      steps.push('group');
      return `chat-of-${projectId}`;
    },
    // The row is drawn at once here; the hand-off runs inside the call, as it does in the update that draws the row.
    whenRowShown: async (_chatId, nudge, open) => {
      nudges.push(nudge);
      open();
      return true;
    },
    handOff: (projectId) => { steps.push(`open ${projectId}`); },
    handOffToGroup: (chatId) => { steps.push(`open group ${chatId}`); },
    logError: (message) => { errors.push(message); },
  };
  return {
    deps,
    steps,
    taken,
    nudges,
    paths,
    projects,
    dismissFailures,
    errors,
    signOut: () => { signedIn = false; },
    get key() { return key; },
    get created() { return created; },
  };
}

const draft = () => composerDrafts.forKey(DRAFT);

beforeEach(() => {
  resetSampleConversion();
  draft().setPrompt('周六下雨的话改成什么？');
});
afterEach(() => composerDrafts.discard(DRAFT));

describe('turning the sample into the person\'s project (#2569)', () => {
  it('goes project → files → group → open the project → dismiss: the sample is dismissed at the hand-off, not after the task', async () => {
    const w = world();
    w.taken.add('/Users/p/projects/周末去杭州');
    await convertSampleProject(w.deps, seed);
    expect(w.steps).toEqual([
      'project 周末去杭州 2',
      'record project',
      ...fileNames.map((name) => `file ${name} in user-a:project-1:folder`),
      'group',
      'open user-a:project-1',
      'record group',
      'dismiss',
    ]);
    expect(sampleConversion).toMatchObject({ owner: 'user-a', status: 'handed-off', failure: null, chatId: 'chat-of-user-a:project-1' });
    // #2589 review 5: persisted on the account at the hand-off, so a reload or a task that fails to start cannot bring it back.
    expect(w.key).toEqual({ version: 2, dismissed: true, projectId: 'user-a:project-1', chatId: 'chat-of-user-a:project-1' });
  });

  it('a dismissal that fails after the hand-off is said out loud; the project stays handed over', async () => {
    const w = world();
    w.deps.dismiss = async () => { throw new Error('offline'); };
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion).toMatchObject({ status: 'handed-off', failure: null });
    expect(w.dismissFailures).toHaveLength(1);
    expect(w.dismissFailures[0]).toBeInstanceOf(Error);
  });

  // #2589 the sample gives way in the render that first draws its project's row; nothing slow sits between the two.
  it('knows its group as soon as it is made, and hands over when its row is drawn, without waiting for the account write', async () => {
    const w = world();
    let drawRow!: () => void;
    let saved!: () => void;
    w.deps.whenRowShown = (_chatId, _nudge, open) => new Promise((resolve) => { drawRow = () => { open(); resolve(true); }; });
    w.deps.recordGroup = () => new Promise((resolve) => { w.steps.push('record group (slow)'); saved = () => resolve(); });
    const running = convertSampleProject(w.deps, seed);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(sampleConversion).toMatchObject({ status: 'working', chatId: 'chat-of-user-a:project-1' });
    expect(w.steps.at(-1)).toBe('record group (slow)');
    drawRow();
    expect(sampleConversion.status, 'handed over in the update that drew the row').toBe('handed-off');
    expect(w.steps.at(-1)).toBe('open user-a:project-1');
    saved();
    await running;
    expect(w.steps.at(-1)).toBe('dismiss');
  });

  it('recording the group on the account failing after the hand-off is logged; the sample is still dismissed', async () => {
    const w = world();
    w.deps.recordGroup = async () => { throw new Error('offline'); };
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion).toMatchObject({ status: 'handed-off', failure: null });
    expect(w.steps.slice(-2)).toEqual(['open user-a:project-1', 'dismiss']);
    expect(w.errors.some((message) => message.includes('project group'))).toBe(true);
  });

  const failures: [string, string, (deps: SampleConversionDeps) => void][] = [
    ['no default projects directory', 'no-default-directory', (deps) => { deps.defaultDirectory = async () => ''; }],
    ['every folder name taken', 'no-free-folder', (deps) => { deps.pathTaken = async () => true; }],
    ['the folder or project cannot be created', 'create', (deps) => { deps.createProject = async () => { throw new Error('EACCES'); }; }],
    ['the project cannot be recorded on the account', 'record', (deps) => { deps.recordProject = async () => { throw new Error('offline'); }; }],
    ['a file cannot be written', 'files', (deps) => { deps.writeFile = async () => { throw new Error('disk full'); }; }],
    ['the group cannot be created', 'group', (deps) => { deps.ensureGroup = async () => { throw new Error('cloud-failed'); }; }],
    ['the project never shows up in the list', 'row', (deps) => { deps.whenRowShown = async () => false; }],
    ['the project cannot be opened', 'open', (deps) => { deps.handOff = () => { throw new Error('draft taken'); }; }],
  ];
  it.each(failures)('%s: stops there with that reason, keeps the message, dismisses nothing', async (_name, kind, breakIt) => {
    const w = world();
    breakIt(w.deps);
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.status).toBe('idle');
    expect(sampleConversion.failure?.kind).toBe(kind);
    if (sampleConversion.failure && 'error' in sampleConversion.failure) expect(sampleConversion.failure.error).toBeInstanceOf(Error);
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
    expect(w.key).toEqual({ version: 2, dismissed: false, projectId: 'user-a:project-1' });

    w.deps.ensureGroup = ensure;
    w.steps.length = 0;
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    // The group was never made, so the files are written again before it (nothing of the person's to overwrite yet).
    expect(w.steps).toEqual([
      ...fileNames.map((name) => `file ${name} in user-a:project-1:folder`),
      'group', 'open user-a:project-1', 'record group', 'dismiss',
    ]);
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
    expect(w.steps).toContain('open user-a:project-1');
  });

  it('a retry once the group is recorded does not write the files again', async () => {
    const w = world();
    const appears = w.deps.whenRowShown;
    w.deps.whenRowShown = async () => false;
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.failure?.kind).toBe('row');
    w.deps.whenRowShown = appears;
    w.steps.length = 0;
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(1);
    expect(w.steps).toEqual(['group', 'open user-a:project-1', 'dismiss']);
  });

  it('a second press while it runs does nothing: one project', async () => {
    const w = world();
    await Promise.all([convertSampleProject(w.deps, seed), convertSampleProject(w.deps, seed)]);
    expect(w.created).toBe(1);
    expect(w.steps.filter((step) => step.startsWith('open'))).toEqual(['open user-a:project-1']);
  });

  it('another window on this computer that finds the conversion recorded continues it: no project, no files, same project opened', async () => {
    const w = world({ version: 2, dismissed: false, projectId: 'project-7', chatId: 'chat-of-project-7' });
    w.projects.add('project-7');
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(0);
    expect(w.steps).toEqual(['group', 'open project-7', 'dismiss']);
  });

  // #2589 review 2: the key's project id is another computer's; its group is what every computer can resolve.
  it('on another computer, a sample already turned into an account project opens that project instead of making a second one', async () => {
    const w = world({ version: 2, dismissed: false, projectId: 'project-on-the-laptop', chatId: 'chat-of-the-laptop-project' });
    await convertSampleProject(w.deps, seed);
    expect(w.created).toBe(0);
    expect(w.steps).toEqual(['open group chat-of-the-laptop-project', 'dismiss']);
    expect(w.key).toEqual({ version: 2, dismissed: true, projectId: 'project-on-the-laptop', chatId: 'chat-of-the-laptop-project' });
    expect(sampleConversion).toMatchObject({ status: 'handed-off', chatId: 'chat-of-the-laptop-project' });
  });

  it('on another computer, waits for that project to be listed; not listed yet stops with a reason and makes nothing', async () => {
    const w = world({ version: 2, dismissed: false, projectId: 'project-on-the-laptop', chatId: 'chat-of-the-laptop-project' });
    w.deps.whenRowShown = async () => false;
    await convertSampleProject(w.deps, seed);
    expect(sampleConversion.failure?.kind).toBe('row');
    expect(w.created).toBe(0);
    expect(w.steps).toEqual([]);
  });

  it('a recorded project with no group yet that is not on this computer never reached the account: it is made here', async () => {
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

  // #2589 review 7
  it.each([
    ['/Users/p/projects/', '/Users/p/projects/周末去杭州'],
    ['C:\\Users\\p\\projects\\', 'C:\\Users\\p\\projects\\周末去杭州'],
    ['C:\\Users\\p\\projects', 'C:\\Users\\p\\projects\\周末去杭州'],
  ])('the folder under the default directory %s is %s', async (directory, path) => {
    const w = world();
    w.deps.defaultDirectory = async () => directory;
    await convertSampleProject(w.deps, seed);
    expect(w.paths).toEqual([path]);
  });
});

// #2589 review 1: one renderer, two accounts one after the other.
describe('the conversion belongs to the account that sent', () => {
  it('another account signing in here converts its own sample: A\'s finished hand-off does not hold it back', async () => {
    const a = world(undefined, 'user-a');
    await convertSampleProject(a.deps, seed);
    expect(sampleConversionOf('user-a').status).toBe('handed-off');
    expect(sampleConversionOf('user-b')).toMatchObject({ status: 'idle', failure: null, chatId: null });

    const b = world(undefined, 'user-b');
    await convertSampleProject(b.deps, seed);
    expect(b.created).toBe(1);
    expect(b.steps).toContain('open user-b:project-1');
  });

  it('a project A made but could not record is never the one B\'s sample continues with', async () => {
    const a = world(undefined, 'user-a');
    a.deps.recordProject = async () => { throw new Error('offline'); };
    await convertSampleProject(a.deps, seed);
    expect(sampleConversionOf('user-a').failure?.kind).toBe('record');

    const b = world(undefined, 'user-b');
    for (const id of a.projects) b.projects.add(id);
    await convertSampleProject(b.deps, seed);
    expect(b.created).toBe(1);
    expect(b.steps).not.toContain('open user-a:project-1');
    expect(b.key).toMatchObject({ projectId: 'user-b:project-1' });
    expect(sampleConversionOf('user-b').failure).toBeNull();
  });

  it('signing out mid-way stops the run before it hands anything over; the next press starts clean', async () => {
    const w = world();
    const ensure = w.deps.ensureGroup;
    w.deps.ensureGroup = async (projectId) => { w.signOut(); return ensure(projectId); };
    await convertSampleProject(w.deps, seed);
    expect(w.steps.some((step) => step.startsWith('open'))).toBe(false);
    expect(w.steps).not.toContain('record group');
    expect(sampleConversionOf('user-a')).toMatchObject({ status: 'idle', failure: null });
  });
});
