export interface SessionpageMessageHost {
  /** gugu-dev#181 我发出的一张卡(content_type='card',taskCardModels):不点名、不叫醒人。「已安排」那张由这里落。 */
  sendCardToChat(chatId: string, content: string): Promise<void>;
  /**
   * gugu-dev#181 在这个对话里派任务记着的项目:(那台机器, 那台上的本地项目);这个对话没选过 = 这台电脑(`localDeviceId`)上最近一次选的。
   */
  rememberedTaskProject(chatId: string, localDeviceId: string): Promise<{ deviceId: string; projectId: string } | null>;
  /** 记下这个对话选的项目:`deviceId` = 那个本地项目所在的机器(❌ 一律写这台电脑)。 */
  rememberTaskProject(chatId: string, deviceId: string, projectId: string | null): Promise<void>;
}
