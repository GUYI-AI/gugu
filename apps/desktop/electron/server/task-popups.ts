/** Not implemented yet. */
export class TaskPopups {
  constructor(_close: (targetId: string) => void, _claimMs = 5_000) {}
  hold(_url: string, _targetId: string): void {}
  take(_url: string | undefined): string | null { return null; }
  forget(_targetId: string): void {}
  dispose(): void {}
}
