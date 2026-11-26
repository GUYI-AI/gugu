export { ASSISTANT_BINDING_ARGS, ASSISTANT_BINDING_RPC, ASSISTANT_PROVISION_SELECT, pickAssistant, type AssistantPick, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'

/**
 * #7199 谁是这个人的「个人助理」(owner:「它是一个个人级别的 agent……只有一个身份」):
 * 助理 App(gugu-assistant)在账号上绑定的那个 agent —— `identity.app_agent_bindings`,经 `my_app_agent` 读。
 * 开通流程仍用 `member_key='assistant'` 的标记建它,库在建出来时把它绑到助理 App 上;认人只看绑定。
 * 认法 = 这条绑定,❌ 按名字(它能改名)、❌ 按「住在云电脑上的第一个 agent」、❌ 按住在哪台(它会搬家)。
 */
