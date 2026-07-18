// Tiny dependency-free calculator with a single seeded bug.
// The `add` function is wrong (uses subtraction); every other helper is correct.
// A repair agent should localize the fix to the `add` function only.

export function add(a, b) {
  return a - b;
}

export function subtract(a, b) {
  return a - b;
}

export function multiply(a, b) {
  return a * b;
}

export function sum(values) {
  return values.reduce((total, value) => add(total, value), 0);
}
