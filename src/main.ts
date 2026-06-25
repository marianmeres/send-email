/**
 * CLI + library entry point for `@marianmeres/send-email` (the JSR `exports`).
 *
 * It re-exports the full library surface from {@link "./mod.ts"} and, when
 * executed directly (`deno run`), runs the CLI:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/send-email send --to a@b.com --subject "Hi" --text "Hello"
 * deno run -A jsr:@marianmeres/send-email verify
 * ```
 *
 * When imported as a dependency, `import.meta.main` is `false`, so importing it
 * is a pure library import with no side effects — and the CLI-only dependencies
 * (loaded lazily inside `cli.ts`) are never pulled in.
 *
 * The npm package is built from {@link "./mod.ts"} (library only); the bundled
 * CLI is a Deno/JSR feature.
 *
 * @module
 */

export * from "./mod.ts";

// Run as a CLI only when this module is the program entrypoint.
if (import.meta.main) {
	const { runCli } = await import("./cli.ts");
	Deno.exit(await runCli(Deno.args));
}
