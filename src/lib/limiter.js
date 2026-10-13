export function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    while (active < max && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    }
  };

  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    setMax(n) {
      max = Math.max(1, Math.floor(n) || 1);
      next();
    },
    get active() {
      return active;
    },
  };
}
