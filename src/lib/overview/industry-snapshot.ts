export interface SnapshotPolicy {
  freshMs: number;
  staleMs: number;
}

export interface SnapshotView<T> {
  value: T | null;
  state: 'ready' | 'refreshing' | 'unavailable';
  storedAt: number | null;
}

interface StoredSnapshot<T> {
  key: string;
  value: T;
  storedAt: number;
  version: number;
}

/**
 * Keeps one last-good value while refreshes run in the background.
 *
 * Refreshes are singleflight per trading-date key. A late result from an older
 * key cannot replace a newer committed snapshot.
 */
export class LastGoodSnapshotCoordinator<T> {
  private snapshot: StoredSnapshot<T> | null = null;
  private readonly inflight = new Map<string, Promise<T | null>>();
  private nextVersion = 0;
  private committedVersion = 0;

  constructor(
    private readonly policy: SnapshotPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  read(key: string): SnapshotView<T> {
    const current = this.snapshot;
    if (!current || current.key !== key) {
      return { value: null, state: 'unavailable', storedAt: null };
    }
    const age = this.now() - current.storedAt;
    if (age <= this.policy.freshMs) {
      return { value: current.value, state: 'ready', storedAt: current.storedAt };
    }
    if (age <= this.policy.freshMs + this.policy.staleMs) {
      return { value: current.value, state: 'refreshing', storedAt: current.storedAt };
    }
    return { value: null, state: 'unavailable', storedAt: null };
  }

  refresh(
    key: string,
    operation: () => Promise<T>,
    accept: (value: T) => boolean = () => true,
  ): Promise<T | null> {
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const version = ++this.nextVersion;
    const request = operation()
      .then((value) => {
        if (!accept(value)) throw new Error('snapshot rejected');
        if (version >= this.committedVersion) {
          this.snapshot = {
            key,
            value,
            storedAt: this.now(),
            version,
          };
          this.committedVersion = version;
        }
        return value;
      })
      .catch(() => this.read(key).value)
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  isRefreshing(key: string): boolean {
    return this.inflight.has(key);
  }
}

export interface DeadlineResult<R> {
  completed: Array<{ index: number; value: R }>;
  timedOut: boolean;
}

/**
 * Stops scheduling and waiting for new work at the shared deadline. Providers
 * that already own an in-flight request may finish, but their late result is
 * excluded from this immutable aggregation result.
 */
export function mapWithConcurrencyDeadline<T, R>(
  values: readonly T[],
  limit: number,
  deadlineAt: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<DeadlineResult<R>> {
  if (!values.length) return Promise.resolve({ completed: [], timedOut: false });

  return new Promise((resolve) => {
    const completed: Array<{ index: number; value: R }> = [];
    let cursor = 0;
    let settled = false;

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ completed: completed.slice(), timedOut });
    };
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const timer = setTimeout(() => finish(true), remainingMs);

    const worker = async () => {
      while (!settled && cursor < values.length) {
        if (Date.now() >= deadlineAt) {
          finish(true);
          return;
        }
        const index = cursor++;
        try {
          const value = await mapper(values[index]!, index);
          if (!settled) completed.push({ index, value });
        } catch {
          // One failed symbol is excluded; sibling symbols continue.
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(Math.max(1, limit), values.length) },
      () => worker(),
    );
    void Promise.all(workers).then(() => finish(cursor < values.length));
  });
}
