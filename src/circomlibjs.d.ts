declare module '@railgun-community/circomlibjs' {
  export const poseidon: (inputs: readonly bigint[]) => bigint;

  export const babyjub: {
    packPoint(point: readonly [bigint, bigint]): Uint8Array;
    unpackPoint(point: Uint8Array | ArrayLike<number>): [bigint, bigint] | null;
  };

  const defaultExport: {
    poseidon?: typeof poseidon;
    babyjub?: typeof babyjub;
  };

  export default defaultExport;
}