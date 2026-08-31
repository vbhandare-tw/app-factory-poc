import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DivideByZeroError,
  OPERATIONS,
  UnknownOperationError,
  add,
  applyOperation,
  divide,
  findOperation,
  multiply,
  operationNames,
  subtract,
} from './calc.ts';

describe('arithmetic', () => {
  test('add', () => {
    assert.equal(add(2, 3), 5);
    assert.equal(add(-1, 1), 0);
  });

  test('subtract', () => {
    assert.equal(subtract(5, 3), 2);
  });

  test('multiply', () => {
    assert.equal(multiply(4, 3), 12);
  });

  test('divide', () => {
    assert.equal(divide(9, 3), 3);
  });

  test('divide by zero throws', () => {
    assert.throws(() => divide(1, 0), DivideByZeroError);
  });
});

describe('operation registry', () => {
  test('every registered operation has a unique name', () => {
    const names = operationNames();
    assert.equal(new Set(names).size, names.length);
  });

  test('every registered operation is callable', () => {
    for (const operation of OPERATIONS) {
      assert.equal(typeof operation.apply(6, 3), 'number');
    }
  });

  test('findOperation returns undefined for an unknown name', () => {
    assert.equal(findOperation('modulo'), undefined);
  });

  test('applyOperation dispatches by name', () => {
    assert.equal(applyOperation('multiply', 6, 7), 42);
  });

  test('applyOperation throws on an unknown name', () => {
    assert.throws(() => applyOperation('modulo', 1, 2), UnknownOperationError);
  });
});
