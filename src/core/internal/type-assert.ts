/**
 * Internal compile-time type-equality assertion helpers. NOT re-exported from the
 * public barrel (src/index.ts). Used to lock a resolved public shape against a
 * frozen reference type so a refactor cannot silently change a consumer-facing
 * contract: a drift makes `Assert<false>` fail its `extends true` constraint at
 * the declaration site (a loud `TS2344`), forcing a deliberate reference update.
 */

/**
 * `Equals<A, B>` is `true` iff A and B are the identical type. The `(<T>() => …)`
 * variance trick is stricter than mutual `extends`: it distinguishes
 * optional-vs-required, `readonly`, and `X` vs `X | undefined` — the last is
 * critical under exactOptionalPropertyTypes.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the Equals identity trick uses T once per side by design
export type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false;

/** Compile error unless `T` resolves to exactly `true`. */
export type Assert<T extends true> = T;

/** Flatten an intersection into one object type (preserves readonly + optional). */
export type Resolve<T> = { [K in keyof T]: T[K] };
