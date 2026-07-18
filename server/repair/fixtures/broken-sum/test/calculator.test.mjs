import assert from "node:assert/strict";
import { test } from "node:test";

import { add, multiply, subtract, sum } from "../src/calculator.mjs";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-4, 4), 0);
  assert.equal(add(10, 15), 25);
});

test("subtract returns the difference of two numbers", () => {
  assert.equal(subtract(10, 3), 7);
  assert.equal(subtract(0, 5), -5);
});

test("multiply returns the product of two numbers", () => {
  assert.equal(multiply(3, 4), 12);
  assert.equal(multiply(-2, 5), -10);
});

test("sum adds every value in a list", () => {
  assert.equal(sum([1, 2, 3, 4]), 10);
  assert.equal(sum([]), 0);
});
