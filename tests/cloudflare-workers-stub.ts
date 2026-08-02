// Test stub for `cloudflare:workers` DurableObject base class.
const ctx = {
  get blockConcurrencyWhile() {
    return async (fn: () => Promise<unknown>) => {
      await fn();
    };
  },
  get storage() {
    return new Map();
  },
};

export class DurableObject<EnvT = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: EnvT,
  ) {}
}