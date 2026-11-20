import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Small, read-only JSON-RPC transport shared by model and subscription probes. The caller owns deadlines/processes. */
export class AcpProbeRpcClient {
  private buffer = '';
  private nextId = 1;
  private failure: Error | undefined;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly rpcError: (payload: unknown) => Error = () => new Error('ACP probe request failed'),
    private readonly notification?: (method: string, params: unknown) => void,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString()));
    child.stderr.resume();
    child.stdin.on('error', error => this.close(error));
    child.on('error', error => this.close(error));
    child.on('exit', () => this.close(new Error('ACP probe process exited')));
  }

  private close(error: Error): void {
    this.failure = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private receive(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
      let message: Record<string, unknown>;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      if (typeof message.method === 'string') {
        if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'probe: unsupported' } });
        else this.notification?.(message.method, message.params);
      } else if (typeof message.id === 'number') {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(this.rpcError(message.error)); else waiter.resolve(message.result);
      }
    }
  }

  send(payload: unknown): void {
    if (!this.failure) this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
}
