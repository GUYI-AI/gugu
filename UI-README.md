# Phone own-message regression rendering

测试环境渲染，未经真机验证，原因：无真机

Actual shared AgentConversationView inside SessionUiTheme, with the phone shell outside the theme scope. Each original carries its full observed product SHA. Synthetic message: someone@example.com. No account, owner email, cloud delivery, or physical-device validation.

Before: 9f633292116b452e6523627c0cba5b6dc785f904. After: b5ec8c1936dfe287d1299b2e7f61a499707d4ed8.

Light and dark originals were inspected individually. The baseline reproduces both unreadable own-message text and the domain file pill. The fixed view shows normal shell text and an intact email link. New and existing related tests: 50 passed, no unhandled errors.
