# App 的接口(原「tab 扩展的暴露面」)

> 界面上叫 App;仓库与代码里仍叫 extension。

这里不再抄一份接口表。动词、能力词、清单字段、程序写法、页面生命周期只有一个原文:

- **产品内 guide**:`apps/desktop/src/session/shared/extensions/authoring-guide.ts`。咕咕里的 agent 用 `guide_read`
  读到的就是它,分 `apps`、`apps-files`、`apps-page`、`apps-ui`、`apps-programs`、`apps-fork` 六篇。
- **宿主集成参考**:[`apps/`](apps/) 下每个主题一篇(bindings、assistant、projection、task pages、cloud、sessions、editors、
  settings、agents 等)。agent 不经 `guide_read` 读,`apps` 那篇给出公开链接。
- `tests/unit/desktop/mcp/guguGuide6614.test.ts` 把两处合起来逐个核对代码:每个动词、每个能力词、每个 `app_*` 工具。
- 清单能写什么、上限多少:`apps/desktop/src/session/shared/extensions/manifest.ts` 的 zod schema。
- 动词各要哪个能力、要不要手势:`apps/desktop/src/session/shared/extensions/bridge-protocol.ts` 的 `BRIDGE_VERBS`。

产品契约见 product spec;结构与防线见 [架构](../design/session-extensions-architecture.md);
上架见 [发布到市场](publishing-an-extension.md)。
