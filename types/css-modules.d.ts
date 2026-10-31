/**
 * CSS Modules ambient declaration.
 *
 * `shared/tsdown.client.ts` compiles `*.module.css` with lightningcss and hands the component the
 * hashed class map, so an importing file must know the default export is a `Record<string, string>`.
 * Kept here rather than under `src/`: `src/` is the shipped module tree, and tsc would otherwise copy
 * this file into `lib/types/` as though it were a module the package exports.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
