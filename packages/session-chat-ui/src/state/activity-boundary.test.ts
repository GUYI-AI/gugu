import { describe, expect, it } from 'vitest';
import type { ChatMessage, TranscriptTurn } from '../model';
import { latestViewerInput, resetActivityOnInput } from './activity-boundary';
import { createViewState } from './view-state';

const activity = 'agent-activity:report';
const message = (id: string, text = id, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ kind: 'message', id, seq: 0, role: 'user', text, ...extra });
const turn = (id: string, items: ChatMessage[]): TranscriptTurn =>
  ({ id, seq: 0, initiator: 'user', items: items as TranscriptTurn['items'] });
const answer = (state: 'answered' | 'withdrawn') => message(state, '<gugu_question_answer>\n'
  + JSON.stringify({ question_id: 'question', state, answers: [{ selected: ['Keep it'] }] }) + '\n</gugu_question_answer>');

function opened() {
  const model = {}, view = createViewState(), history = [turn('owner', [message('owner')])];
  resetActivityOnInput(model, latestViewerInput(history), view);
  view.setCollapsed(activity, true);
  return { model, view, history };
}

describe('viewer input boundary for manually opened agent activity', () => {
  it.each(['answered', 'withdrawn'] as const)('preserves expansion for a raw %s receipt in committed and active input', state => {
    const { model, view, history } = opened();
    const receipt = turn('receipt', [answer(state)]);
    const previous = latestViewerInput(history);
    expect(latestViewerInput([...history, receipt])).toBe(previous);
    expect(resetActivityOnInput(model, latestViewerInput([receipt], undefined, previous), view)).toBe(false);
    expect(view.isCollapsed(activity)).toBe(true);
  });

  it.each(['answered', 'withdrawn'] as const)('preserves expansion for a normalized %s status row', state => {
    const { model, view, history } = opened();
    const receipt = message(state, '', { questionAnswer: { answer: state === 'answered' ? 'Keep it' : null } });
    expect(resetActivityOnInput(model, latestViewerInput([...history, turn('receipt', [receipt])]), view)).toBe(false);
    expect(view.isCollapsed(activity)).toBe(true);
  });

  it('still collapses on the next ordinary viewer message after answering', () => {
    const { model, view, history } = opened();
    history.push(turn('receipt', [answer('answered')]));
    resetActivityOnInput(model, latestViewerInput(history), view);
    history.push(turn('next', [message('next', 'Continue with the next task')]));
    expect(resetActivityOnInput(model, latestViewerInput(history), view)).toBe(true);
    expect(view.isCollapsed(activity)).toBe(false);
  });

  it('keeps an opened activity expanded when a new agent report arrives', () => {
    const { model, view, history } = opened();
    const report = message('report', '<gugu_delivery route="session-direct" from="Peer" from_id="session:peer" from_type="agent">'
      + '<![CDATA[Another report]]></gugu_delivery>');
    expect(resetActivityOnInput(model, latestViewerInput([...history, turn('report', [report])]), view)).toBe(false);
    expect(view.isCollapsed(activity)).toBe(true);
  });

  it('does not open untouched activities when an answer arrives', () => {
    const model = {}, view = createViewState();
    resetActivityOnInput(model, latestViewerInput([turn('owner', [message('owner')])]), view);
    resetActivityOnInput(model, latestViewerInput([turn('receipt', [answer('answered')])], undefined, 'owner'), view);
    expect(view.isCollapsed(activity)).toBe(false);
  });

  it('keeps ordinary text that resembles an invalid answer protocol as a new input', () => {
    const { model, view, history } = opened();
    history.push(turn('quoted', [message('quoted', '<gugu_question_answer>\nnot a protocol record\n</gugu_question_answer>')]));
    expect(resetActivityOnInput(model, latestViewerInput(history), view)).toBe(true);
    expect(view.isCollapsed(activity)).toBe(false);
  });
});
