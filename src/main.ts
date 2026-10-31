/**
 * JSR entry point for `@marianmeres/send-email`: the library, plus the CLI when run
 * directly.
 *
 * It re-exports the full library surface from {@link "./mod.ts"} and, when
 * executed as the program entrypoint, runs the CLI:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/send-email send --to a@b.com --subject "Hi" --text "Hello"
 * deno run -A jsr:@marianmeres/send-email verify
 * ```
 *
 * When imported as a dependency, `import.meta.main` is `false`, so importing it
 * is a pure library import with no side effects — and the CLI module (loaded
 * lazily below) is never pulled in.
 *
 * The npm package does not ship this file: its `.` export is {@link "./mod.ts"}
 * and its `send-email` bin is `bin.ts`.
 *
 * @module
 */

import process from "node:process";

export * from "./mod.ts";

// Run as a CLI only when this module is the program entrypoint.
if (import.meta.main) {
	const { runCli } = await import("./cli.ts");
	process.exitCode = await runCli(process.argv.slice(2));
}
