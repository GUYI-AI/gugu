import type { SettlementQuestion } from '@gugu/session-core/session-record/contract';

export type AgentQuestionInput = {
  question: string;
  header?: string;
  options: ReadonlyArray<{ label: string; description?: string }>;
  multi_select?: boolean;
};

/** The host timeline and public chat card carry the same question wording and option IDs. */
export function agentSettlementQuestions(input: readonly AgentQuestionInput[]): SettlementQuestion[] {
  return input.map((question) => ({
    question: question.question, ...(question.header ? { header: question.header } : {}), multiSelect: question.multi_select === true,
    options: question.options.map((option) => ({ optionId: option.label, name: option.label, ...(option.description ? { description: option.description } : {}) })),
  }));
}
