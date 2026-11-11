// expect: @typescript-eslint/no-unsafe-type-assertion
export function tokenCount(value: unknown): number {
  return value as number;
}
