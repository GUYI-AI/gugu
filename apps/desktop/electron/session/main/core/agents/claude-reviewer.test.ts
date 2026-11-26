import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { CLAUDE_REVIEW_REASON_KEYS, REVIEWER_NOT_ON_TICKET_KEY, withLaunchedReview } from './claude-reviewer';

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
