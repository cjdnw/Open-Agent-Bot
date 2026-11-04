/**
 * Resource lock manager for multi-agent workflows.
 *
 * Prevents concurrent unprotected writes to the same directory or file by workers.
 * Supports serializing workers when accessing shared workspace resources.
 */

export interface LockGrant {
  resource: string;
  owner: string;
  acquiredAt: number;
  release: () => void;
}

export class ResourceLockManager {
  private activeLocks = new Map<string, { owner: string; acquiredAt: number }>();
  private waitQueues = new Map<string, Array<{ owner: string; resolve: (grant: LockGrant) => void }>>();

  /**
   * Acquire an exclusive lock on a resource (e.g. "workspace", "main.cpp", "git").
   */
  async acquire(resource: string, owner: string, timeoutMs = 30000): Promise<LockGrant> {
    const existing = this.activeLocks.get(resource);
    if (!existing || existing.owner === owner) {
      this.activeLocks.set(resource, { owner, acquiredAt: Date.now() });
      return {
        resource,
        owner,
        acquiredAt: Date.now(),
        release: () => this.release(resource, owner),
      };
    }

    return new Promise<LockGrant>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.waitQueues.get(resource) || [];
        this.waitQueues.set(resource, queue.filter((item) => item.owner !== owner));
        reject(new Error(`Timeout waiting for resource lock: ${resource} (held by ${existing.owner})`));
      }, timeoutMs);

      const queue = this.waitQueues.get(resource) || [];
      queue.push({
        owner,
        resolve: (grant) => {
          clearTimeout(timer);
          resolve(grant);
        },
      });
      this.waitQueues.set(resource, queue);
    });
  }

  /**
   * Release an exclusive lock and grant it to the next waiting worker in queue.
   */
  release(resource: string, owner: string): void {
    const existing = this.activeLocks.get(resource);
    if (!existing || existing.owner !== owner) {
      return;
    }

    const queue = this.waitQueues.get(resource);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      this.activeLocks.set(resource, { owner: next.owner, acquiredAt: Date.now() });
      next.resolve({
        resource,
        owner: next.owner,
        acquiredAt: Date.now(),
        release: () => this.release(resource, next.owner),
      });
    } else {
      this.activeLocks.delete(resource);
      this.waitQueues.delete(resource);
    }
  }

  /**
   * Helper to execute a function under lock.
   */
  async withLock<T>(resource: string, owner: string, fn: () => Promise<T>, timeoutMs = 30000): Promise<T> {
    const grant = await this.acquire(resource, owner, timeoutMs);
    try {
      return await fn();
    } finally {
      grant.release();
    }
  }

  isLocked(resource: string): boolean {
    return this.activeLocks.has(resource);
  }

  getLockHolder(resource: string): string | undefined {
    return this.activeLocks.get(resource)?.owner;
  }
}

export const globalResourceLockManager = new ResourceLockManager();

