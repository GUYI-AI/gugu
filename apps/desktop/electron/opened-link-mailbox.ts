/** Every link the OS opened, retained until the main renderer takes them, including before window creation and on reload. */
export class OpenedLinkMailbox {
  private pending: string[] = []
  constructor(private readonly notify: () => void) {}
  push(url: string): void { this.pending.push(url); this.notify() }
  take(): string[] { return this.pending.splice(0) }
}
