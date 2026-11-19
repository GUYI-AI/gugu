interface Ports<T> {
  currentOwner(): Promise<string | null>
  create(ownerId: string): Promise<T>
  invalidate?(value: T): void
  dispose(value: T): Promise<void>
  unavailable(): Error
}

/** Native per-owner construction and disposal. In particular, B must never
 * receive the result of an A construction which was already in flight. */
export class PasswordAccountLifetime<T extends { ownerId: string }> {
  private readonly creating = new Map<string, Promise<T>>()
  private readonly disposing = new WeakMap<T, Promise<void>>()
  private readonly operations = new WeakMap<T, Set<Promise<unknown>>>()
  private readonly closedOwners = new Set<string>()
  current: T | undefined

  constructor(private readonly ports: Ports<T>) {}
  isClosing(ownerId: string): boolean { return this.closedOwners.has(ownerId) }

  async get(): Promise<T> {
    const ownerId = await this.ports.currentOwner()
    if (!ownerId || this.isClosing(ownerId)) throw this.ports.unavailable()
    if (this.current && this.current.ownerId !== ownerId) await this.dispose(this.current)
    const pending = this.current?.ownerId === ownerId ? Promise.resolve(this.current) : this.creating.get(ownerId) ?? this.ports.create(ownerId)
    if (this.current?.ownerId !== ownerId) this.creating.set(ownerId, pending)
    try {
      const value = await pending
      const actual = await this.ports.currentOwner()
      if (value.ownerId !== ownerId || actual !== ownerId || this.isClosing(ownerId)) {
        if (actual !== value.ownerId || this.isClosing(value.ownerId)) await this.dispose(value)
        throw this.ports.unavailable()
      }
      this.current = value
      return value
    } finally { if (this.creating.get(ownerId) === pending) this.creating.delete(ownerId) }
  }

  private dispose(value: T): Promise<void> {
    const existing = this.disposing.get(value)
    if (existing) return existing
    const pending = (async () => {
      // Revoke first so an operation waiting for a person can settle. Waiting
      // for its promise before revocation would deadlock account cleanup.
      this.ports.invalidate?.(value)
      await Promise.allSettled([...(this.operations.get(value) ?? [])])
      await this.ports.dispose(value)
      if (this.current === value) this.current = undefined
    })()
    this.disposing.set(value, pending)
    void pending.catch(() => { if (this.disposing.get(value) === pending) this.disposing.delete(value) })
    return pending
  }

  async run<R>(value: T, operation: () => Promise<R>): Promise<R> {
    if (await this.ports.currentOwner() !== value.ownerId || this.current !== value || this.isClosing(value.ownerId) || this.disposing.has(value)) throw this.ports.unavailable()
    const pending = Promise.resolve().then(() => {
      if (this.isClosing(value.ownerId) || this.disposing.has(value)) throw this.ports.unavailable()
      return operation()
    })
    const jobs = this.operations.get(value) ?? new Set<Promise<unknown>>()
    jobs.add(pending); this.operations.set(value, jobs)
    try { return await pending }
    finally { jobs.delete(pending) }
  }

  async close(ownerId: string): Promise<void> {
    this.closedOwners.add(ownerId)
    if (this.current?.ownerId === ownerId) await this.dispose(this.current)
    const pending = this.creating.get(ownerId)
    if (pending) {
      const value = await pending.catch(() => null)
      if (value?.ownerId === ownerId) await this.dispose(value)
    }
  }
}
