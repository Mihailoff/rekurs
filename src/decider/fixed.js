/** A decider that returns a fixed vector, or throws — for tests and for the "Jev is down" path. */
export function createFixedDecider(axesOrError, { p99Ms = 0, name = 'fixed' } = {}) {
  return {
    name,
    p99Ms,
    calls: 0,
    async decide() {
      this.calls += 1;
      if (axesOrError instanceof Error) throw axesOrError;
      return typeof axesOrError === 'function' ? axesOrError() : axesOrError;
    },
  };
}
