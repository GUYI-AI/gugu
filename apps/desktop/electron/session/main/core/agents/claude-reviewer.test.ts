import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/settings/settings-service', () => ({ appSettingsService: { get: vi.fn(async () => null) } }));

import { CLAUDE_REVIEW_REASON_KEYS, REVIEWER_NOT_ON_TICKET_KEY, resolveHostClaudeReviewer, withLaunchedReview } from './claude-reviewer';

const cli = { kind: 'resolved' as const, path: '/bin/claude' };
const byCatalog = { cli, autoReviewAllowed: true, autoReviewer: { label: 'Claude Haiku 5.5', kind: 'platform' as const } };
const off = (reason: keyof typeof CLAUDE_REVIEW_REASON_KEYS) =>
  ({ autoReviewAllowed: false, autoReviewUnavailable: true, autoReviewReason: CLAUDE_REVIEW_REASON_KEYS[reason] });

describe('the menu verdict of a Gugu-model session once its ticket is issued', () => {
  it('says what the launch armed, keeping the rest of the run context', () => {
    const launched = { autoReviewAllowed: true, autoReviewer: { label: 'Claude Sonnet 4.6', kind: 'platform' as const } };
    expect(withLaunchedReview(byCatalog, launched)).toEqual({ cli, ...launched });
  });
  it('turns Auto mode off with its own reason when the catalog offered a reviewer the ticket does not carry', () => {
    for (const reason of ['noReviewer', 'preferenceUnavailable'] as const) {
      expect(withLaunchedReview(byCatalog, off(reason))).toEqual({
        cli, autoReviewAllowed: false, autoReviewUnavailable: true, autoReviewReason: REVIEWER_NOT_ON_TICKET_KEY,
      });
    }
  });
  it("keeps the launch's own reason when the ticket is not what is missing", () => {
    expect(withLaunchedReview(byCatalog, off('reviewerExcluded'))).toEqual({ cli, ...off('reviewerExcluded') });
    expect(withLaunchedReview({ cli, ...off('noReviewer') }, off('noReviewer'))).toEqual({ cli, ...off('noReviewer') });
  });
  it('turns Auto mode on when the ticket carries a reviewer the catalog could not offer', () => {
    const launched = { autoReviewAllowed: true, autoReviewer: { label: 'Claude Haiku 5.5', kind: 'platform' as const } };
    expect(withLaunchedReview({ cli, ...off('noReviewer') }, launched)).toEqual({ cli, ...launched });
  });
});

// No managed settings here: the reading process is not built in a unit test, which reads as none.
describe('which settings files can make the CLI drop the reviewer', () => {
  let home: string;
  let work: string;
  const put = (file: string, models: string[]) => writeFile(file, JSON.stringify({ availableModels: models }));
  const connection = () => resolveHostClaudeReviewer({
    route: 'custom', mainModel: 'claude-sonnet-4-6', platformModels: [], env: { HOME: home }, cwd: work,
    session: { connectionId: 'relay', endpoint: 'https://relay.example', models: [{ id: 'claude-sonnet-4-6' }, { id: 'glm-5' }] },
  });
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gugu-review-home-'));
    work = await mkdtemp(join(tmpdir(), 'gugu-review-work-'));
    await mkdir(join(home, '.claude'));
    await mkdir(join(work, '.claude'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  it("a connection session: the session folder's project list excludes the reviewer", async () => {
    await put(join(work, '.claude', 'settings.json'), ['glm-5']);
    expect(await connection()).toEqual({ ok: false, reason: 'reviewerExcluded' });
  });
  it('a connection session: the local list too; a list in another file that names the reviewer lets it through', async () => {
    await put(join(work, '.claude', 'settings.local.json'), ['glm-5']);
    expect(await connection()).toEqual({ ok: false, reason: 'reviewerExcluded' });
    await put(join(home, '.claude', 'settings.json'), ['claude-sonnet-4-6']);
    expect(await connection()).toMatchObject({ ok: true, reviewer: { kind: 'connection', modelId: 'claude-sonnet-4-6' } });
  });
  it('a connection session: a family entry lets the reviewer through until an entry names another version of it', async () => {
    await put(join(home, '.claude', 'settings.json'), ['sonnet']);
    expect(await connection()).toMatchObject({ ok: true });
    await put(join(home, '.claude', 'settings.json'), ['sonnet', 'claude-sonnet-4-5']);
    expect(await connection()).toEqual({ ok: false, reason: 'reviewerExcluded' });
  });
  it("a Gugu-model session: the user's and the project's lists cannot exclude the reviewer its own settings list", async () => {
    await put(join(home, '.claude', 'settings.json'), ['claude-opus-4-6']);
    await put(join(work, '.claude', 'settings.json'), ['claude-opus-4-6']);
    expect(await resolveHostClaudeReviewer({
      route: 'platform', mainModel: 'claude-opus-4-6', env: { HOME: home }, cwd: work,
      platformModels: [{ id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' }, { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' }],
    })).toMatchObject({ ok: true, reviewer: { kind: 'platform', modelId: 'claude-haiku-5-5' } });
  });
});
