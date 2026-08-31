/**
 * A deliberately extensible calculator.
 *
 * The sample feature the factory builds adds new operations here, so keep the
 * shape open: one pure function per operation, registered in `OPERATIONS`.
 */

export interface Operation {
  readonly name: string;
  readonly symbol: string;
  readonly apply: (a: number, b: number) => number;
}

export class UnknownOperationError extends Error {
  readonly operationName: string;

  constructor(operationName: string) {
    super(`Unknown operation: ${operationName}`);
    this.name = 'UnknownOperationError';
    this.operationName = operationName;
  }
}

export class DivideByZeroError extends Error {
  constructor() {
    super('Cannot divide by zero');
    this.name = 'DivideByZeroError';
  }
}

export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) {
    throw new DivideByZeroError();
  }
  return a / b;
}

export const OPERATIONS: readonly Operation[] = [
  { name: 'add', symbol: '+', apply: add },
  { name: 'subtract', symbol: '-', apply: subtract },
  { name: 'multiply', symbol: '*', apply: multiply },
  { name: 'divide', symbol: '/', apply: divide },
];

export function operationNames(): string[] {
  return OPERATIONS.map((operation) => operation.name);
}

export function findOperation(name: string): Operation | undefined {
  return OPERATIONS.find((operation) => operation.name === name);
}

export function applyOperation(name: string, a: number, b: number): number {
  const operation = findOperation(name);
  if (operation === undefined) {
    throw new UnknownOperationError(name);
  }
  return operation.apply(a, b);
}
