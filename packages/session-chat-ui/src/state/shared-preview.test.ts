import { describe, expect, it } from 'vitest';
import { projectMessagePreview } from '@gugu/session-core/session-record/message-preview';
import { personalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import { foldedPreviewTurn, previewAgent, previewBody } from '../../../../tests/support/foldedPreviewFixture';
import { activityPreviewLabel, activityPreviewSources } from './activity-preview';
import { defaultChatTranslator as translate } from '../localization';
import { acpRuntimeApiContract } from '@gugu/session-core/acp';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const ctx = { translate, chatName: () => 'Test group', chatKind: () => 'group' as const,
  actor: (id: string) => ({ id, type: id === previewAgent ? 'agent' as const : 'human' as const, name: id === previewAgent ? 'Worker' : 'Owner' }) };

describe('shared preview provenance from original transcripts', () => {
  it.each(['received', 'group', 'agent'] as const)('carries body-free %s ownership through the working preview projection', kind => {
    const record = foldedPreviewTurn(kind);
    const projection = projectMessagePreview([record], activityPreviewSources);
    expect(projection.activityVersion).toBe(1);
    const text = projection.entries.find(entry => entry.kind === (kind === 'received' ? 'prompt' : 'text'));
    if (!text || text.kind === 'tool') throw new Error('Expected message');
    expect(text.activityVersion).toBe(1);
    expect(activityPreviewLabel(text.activity, ctx)).not.toBeNull();
    expect(JSON.stringify(text.activity)).not.toContain('someone@example.com');
  });
  it.each(['owner', 'failed'] as const)('keeps a %s send outside the folded preview without rewriting its text', kind => {
    const projection = projectMessagePreview([foldedPreviewTurn(kind)], activityPreviewSources);
    const text = projection.entries.find(entry => entry.kind === 'text');
    if (text?.kind !== 'text') throw new Error('Expected narration');
    expect(activityPreviewLabel(text.activity, ctx)).toBeNull();
    expect(text.text).toBe(previewBody);
  });
  it('retains A2G ownership in the owner-started personal conversation preview', () => {
    const preview = personalConversationPreview(foldedPreviewTurn(), activityPreviewSources)!;
    expect(preview).toMatchObject({ activityVersion: 1, at: 2000 });
    expect(activityPreviewLabel(preview.activity, ctx)).toBe('Sent 1 message in Test group');
    expect(JSON.stringify(preview.activity)).not.toContain('someone@example.com');
    expect(personalConversationPreview(foldedPreviewTurn('received'), activityPreviewSources)).toBeNull();
  });
  it.each(['group', 'owner'] as const)('retains %s ownership through the actual worker event schema', kind => {
    const preview = personalConversationPreview(foldedPreviewTurn(kind), activityPreviewSources)!;
    const event = { sessionId: 'session', preview };
    expect(acpRuntimeApiContract.conversationActivity.eventSchema.parse(event)).toEqual(event);
    expect(activityPreviewLabel(preview.activity, ctx) === null).toBe(kind === 'owner');
  });
  it('does not change the original model input or copy quoted reply/context into display metadata', () => {
    const turn = foldedPreviewTurn('received');
    const input = turn.items[0];
    if (input.kind !== 'message') throw new Error('Expected input');
    input.text = input.text.replace('</gugu_delivery>', '<reply_to msg="msg:previous" from_id="user:other" from="Other"><![CDATA[quoted someone@example.com]]></reply_to><message_context><![CDATA[context someone@example.com]]></message_context></gugu_delivery>');
    expect(readDeliveryEnvelope(input.text)?.segments[0].facts?.replyTo?.preview).toBe('quoted someone@example.com');
    expect(readDeliveryEnvelope(input.text)?.segments[0].facts?.messageContext).toBe('context someone@example.com');
    const original = JSON.stringify(turn);
    const preview = projectMessagePreview([turn], activityPreviewSources);
    const entry = preview.entries[0];
    if (entry.kind === 'tool') throw new Error('Expected input');
    expect(JSON.stringify(entry.activity)).not.toContain('someone@example.com');
    expect(entry.activity).toEqual({ kind: 'received', id: 'input', facts: [{ from: 'Worker', fromId: previewAgent, fromType: 'agent' }] });
    expect(JSON.stringify(turn)).toBe(original);
    expect(input.text).toContain('quoted someone@example.com');
  });
});
