/**
 * Environment-shaped configuration → {@link NodemailerTransportOptions}.
 *
 * This module is **pure**: it never touches `Deno.env`, `process.env`, or a
 * `.env` file. The caller supplies an {@link EnvGetter} (any `key → value`
 * lookup) and gets validated transport options back. That keeps the library's
 * hard invariant — *the library never reads the environment* — while letting
 * higher-level tools (this package's CLI, bulk senders, cron jobs) share one
 * definition of what `SMTP_HOST`, `SMTP_PORT`, … mean.
 *
 * ```ts
 * import { createNodemailerTransport, resolveSmtpOptions } from "@marianmeres/send-email";
 *
 * const transport = createNodemailerTransport(
 * 	resolveSmtpOptions((key) => Deno.env.get(key)),
 * );
 * ```
 *
 * @module
 */

import type { NodemailerTransportOptions } from "./transport-nodemailer.ts";

/**
 * A `key → value` lookup over environment-shaped configuration. Return
 * `undefined` for an unset key. Typically `(k) => Deno.env.get(k)`, a parsed
 * `.env` record wrapped in a function, or a merge of the two.
 */
export type EnvGetter = (key: string) => string | undefined;

/**
 * Thrown by {@link resolveSmtpOptions} when a required variable is missing or
 * a value is malformed (e.g. a non-numeric `SMTP_PORT`). This is a
 * *configuration* error, not a runtime one — CLIs conventionally map it to a
 * usage exit code (`2`).
 */
export class SmtpEnvError extends Error {
	/**
	 * Creates a configuration error.
	 *
	 * @param message - Which key is wrong and why.
	 */
	constructor(message: string) {
		super(message);
		this.name = "SmtpEnvError";
	}
}

/** Parses a boolean-ish env value. Throws {@link SmtpEnvError} on garbage. */
function parseBoolEnv(value: string | undefined, name: string): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const s = value.trim().toLowerCase();
	if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
	if (s === "false" || s === "0" || s === "no" || s === "off") return false;
	throw new SmtpEnvError(`${name}: invalid boolean value: "${value}"`);
}

/**
 * Parses a strict non-negative decimal integer env value, optionally
 * range-checked. Rejects hex/scientific/whitespace/negative forms (which
 * `Number()` would otherwise silently accept) so misconfigs fail here with a
 * friendly configuration error rather than later as an opaque socket error.
 * Throws {@link SmtpEnvError} on anything invalid.
 */
function parseIntEnv(
	value: string | undefined,
	name: string,
	range?: { min: number; max: number },
): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new SmtpEnvError(
			`${name} must be a non-negative integer, got "${value}"`,
		);
	}
	const n = Number(trimmed);
	if (range && (n < range.min || n > range.max)) {
		throw new SmtpEnvError(
			`${name} must be between ${range.min} and ${range.max}, got ${n}`,
		);
	}
	return n;
}

/**
 * Resolves {@link NodemailerTransportOptions} from environment-shaped values.
 *
 * Recognized keys (all read through `env`, nothing ambient):
 *
 * | Key                            | Required | Maps to                                    |
 * | ------------------------------ | -------- | ------------------------------------------ |
 * | `SMTP_HOST`                    | yes      | `host`                                     |
 * | `SMTP_PORT`                    | no       | `port` (default `587`, range 1–65535)      |
 * | `SMTP_SECURE`                  | no       | `secure` (bool; default `port === 465`)    |
 * | `SMTP_USER` / `SMTP_PASS`      | no       | `auth` (set when either is present)        |
 * | `SMTP_REPLY_TO`                | no       | `defaultReplyTo`                           |
 * | `SMTP_SERVERNAME`              | no       | `tls.servername`                           |
 * | `SMTP_TLS_REJECT_UNAUTHORIZED` | no       | `tls.rejectUnauthorized` (bool)            |
 * | `SMTP_CONNECTION_TIMEOUT_MS`   | no       | `connectionTimeout`                        |
 * | `SMTP_SOCKET_TIMEOUT_MS`       | no       | `socketTimeout`                            |
 *
 * `SMTP_FROM` is deliberately **not** consumed here — a default sender is a
 * message concern, not a transport one. Read it yourself alongside this call.
 *
 * @param env - The lookup to read from. Never called for keys outside the table above.
 * @returns Validated transport options, ready for `createNodemailerTransport()`.
 * @throws {SmtpEnvError} when `SMTP_HOST` is missing or any value is malformed.
 *
 * @example
 * ```ts
 * import { createNodemailerTransport, resolveSmtpOptions } from "@marianmeres/send-email";
 *
 * const options = resolveSmtpOptions((key) => Deno.env.get(key));
 * const transport = createNodemailerTransport(options);
 * ```
 */
export function resolveSmtpOptions(env: EnvGetter): NodemailerTransportOptions {
	const host = env("SMTP_HOST");
	if (!host) {
		throw new SmtpEnvError(
			"missing required env SMTP_HOST (set it in your .env or environment)",
		);
	}

	const options: NodemailerTransportOptions = {
		host,
		port: parseIntEnv(env("SMTP_PORT"), "SMTP_PORT", { min: 1, max: 65535 }) ??
			587,
	};

	const secure = parseBoolEnv(env("SMTP_SECURE"), "SMTP_SECURE");
	if (secure !== undefined) options.secure = secure;

	const user = env("SMTP_USER");
	const pass = env("SMTP_PASS");
	if (user !== undefined || pass !== undefined) {
		options.auth = { user: user ?? "", pass: pass ?? "" };
	}

	const defaultReplyTo = env("SMTP_REPLY_TO");
	if (defaultReplyTo) options.defaultReplyTo = defaultReplyTo;

	const servername = env("SMTP_SERVERNAME");
	const rejectUnauthorized = parseBoolEnv(
		env("SMTP_TLS_REJECT_UNAUTHORIZED"),
		"SMTP_TLS_REJECT_UNAUTHORIZED",
	);
	if ((servername && servername.trim() !== "") || rejectUnauthorized !== undefined) {
		options.tls = {};
		if (servername && servername.trim() !== "") {
			options.tls.servername = servername.trim();
		}
		if (rejectUnauthorized !== undefined) {
			options.tls.rejectUnauthorized = rejectUnauthorized;
		}
	}

	const connectionTimeout = parseIntEnv(
		env("SMTP_CONNECTION_TIMEOUT_MS"),
		"SMTP_CONNECTION_TIMEOUT_MS",
	);
	if (connectionTimeout !== undefined) {
		options.connectionTimeout = connectionTimeout;
	}
	const socketTimeout = parseIntEnv(
		env("SMTP_SOCKET_TIMEOUT_MS"),
		"SMTP_SOCKET_TIMEOUT_MS",
	);
	if (socketTimeout !== undefined) options.socketTimeout = socketTimeout;

	return options;
}
