/**
 * `@marianmeres/send-email` — public library surface.
 *
 * A single, tested, dependency-light "send an email" path. Import what you
 * need:
 *
 * ```ts
 * import { send } from "@marianmeres/send-email";
 *
 * await send(
 * 	{ to: "to@example.com", from: "no-reply@example.com", subject: "Hi", text: "Hello" },
 * 	{ smtp: { host: "smtp.example.com", port: 587, auth: { user: "u", pass: "p" } } },
 * );
 * ```
 *
 * The library never reads the environment; the CLI is the only layer that does.
 *
 * This module is the **library** entry (and the npm package's `.` export). The
 * **CLI** entry is {@link "./main.ts"}, which re-exports everything here and
 * additionally runs the CLI when executed directly (`deno run`).
 *
 * @module
 */

export * from "./types.ts";
export * from "./transport-nodemailer.ts";
export * from "./transport-mock.ts";
export * from "./send-email.ts";
