/**
 * First-class CLI for `@marianmeres/send-email`.
 *
 * The dream invocation is the bare module entrypoint:
 *
 * ```bash
 * deno run -A jsr:@marianmeres/send-email send --to a@b.com --subject "Hi" --text "Hello"
 * deno run -A jsr:@marianmeres/send-email verify
 * ```
 *
 * All logic lives in {@link runCli}, which takes an args array and returns an
 * exit code (it never calls `Deno.exit`), so it is unit-testable without
 * spawning a process. Every external dependency (stdout/stderr, process env,
 * `.env` loading, stdin, transport construction) is injectable via {@link CliIo}.
 *
 * **This is the only layer that reads the environment.** The library never does.
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import { parse as parseDotenv } from "@std/dotenv";
import { basename } from "@std/path";
import denoJson from "../deno.json" with { type: "json" };
import { createMockTransport } from "./transport-mock.ts";
import {
	createNodemailerTransport,
	type NodemailerTransportOptions,
} from "./transport-nodemailer.ts";
import type { EmailTransport, SendOptions } from "./types.ts";

/** Package version, read from `deno.json` (works when published to JSR). */
const VERSION: string = denoJson.version;

/**
 * Injectable I/O + collaborators for {@link runCli}. All fields are optional;
 * omitted ones fall back to real implementations (stdout/stderr, `Deno.env`,
 * `.env` file loading, `Deno.stdin`, the nodemailer transport). Tests override
 * them to stay hermetic and offline.
 */
export interface CliIo {
	/** stdout line writer. Default: `console.log`. */
	out?: (line: string) => void;
	/** stderr line writer. Default: `console.error`. */
	err?: (line: string) => void;
	/** Process-env getter. Default: `Deno.env.get`. */
	env?: (key: string) => string | undefined;
	/** Loads a `.env` file into a record. Default: read + parse via `@std/dotenv`. */
	loadEnv?: (
		envPath: string,
		explicit: boolean,
	) => Promise<Record<string, string>>;
	/** stdin probe + reader. Default: wraps `Deno.stdin`. */
	stdin?: { isTerminal(): boolean; read(): Promise<string> };
	/** SMTP transport factory. Default: {@link createNodemailerTransport}. */
	createTransport?: (options: NodemailerTransportOptions) => EmailTransport;
}

/** Fully-resolved {@link CliIo} with every collaborator present. */
interface ResolvedIo {
	out: (line: string) => void;
	err: (line: string) => void;
	env: (key: string) => string | undefined;
	loadEnv: (
		envPath: string,
		explicit: boolean,
	) => Promise<Record<string, string>>;
	stdin: { isTerminal(): boolean; read(): Promise<string> };
	makeTransport: (options: NodemailerTransportOptions) => EmailTransport;
}

/** Signals a usage/configuration error → CLI exit code `2`. */
class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** The `--help` / `help` text. */
const HELP: string = `
send-email v${VERSION} — send an email from the library or the shell.

Usage:
  deno run -A jsr:@marianmeres/send-email <command> [options]

Commands:
  send       Send one message (SMTP transport resolved from env).
  verify     Connect + auth handshake only; no message sent.
  help       Show this help. Also --help / -h.
  version    Print the package version. Also --version.

send options:
  --to <addr>          Recipient. Repeatable, or a comma-separated list.
  --from <addr>        Sender. Defaults to env SMTP_FROM.
  --subject, -s <str>  Subject line.
  --text <str>         Inline plain-text body.
  --html <str>         Inline HTML body. As a bare flag with piped stdin,
                       marks the piped body as HTML.
  --text-file <path>   Read the plain-text body from a file.
  --html-file <path>   Read the HTML body from a file.
  --cc <addr>          CC. Repeatable, or a comma-separated list.
  --bcc <addr>         BCC. Repeatable, or a comma-separated list.
  --reply-to <addr>    Reply-To. Defaults to env SMTP_REPLY_TO.
  --attach <path>      Attachment by path. Repeatable.
  --dry-run            Use the mock transport; print what would be sent.
  --json               Machine-readable output.
  --env-file <path>    .env file to load (default: ./.env).

Body from stdin:
  If no body flag is given and stdin is piped, the body is read from stdin
  (plain text by default; add a bare --html to send it as HTML):
    report | deno run -A jsr:@marianmeres/send-email send --to me@x.com -s Report

Environment (SMTP transport):
  SMTP_HOST (required), SMTP_PORT (default 587), SMTP_SECURE,
  SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_REPLY_TO, SMTP_SERVERNAME,
  SMTP_TLS_REJECT_UNAUTHORIZED, SMTP_CONNECTION_TIMEOUT_MS, SMTP_SOCKET_TIMEOUT_MS.
  Credentials come ONLY from env — never from CLI flags.

Output:
  Human summary (or JSON with --json) to stdout on success.
  Errors to stderr. Exit: 0 ok, 1 runtime failure, 2 usage error.
`.trim();

/** Default stdin probe/reader over `Deno.stdin`. */
const defaultStdin: { isTerminal(): boolean; read(): Promise<string> } = {
	isTerminal(): boolean {
		try {
			return Deno.stdin.isTerminal();
		} catch {
			// No stdin handle available → behave like an interactive terminal
			// (i.e. do not attempt to read a body from stdin).
			return true;
		}
	},
	async read(): Promise<string> {
		return await new Response(Deno.stdin.readable).text();
	},
};

/** Default `.env` loader: read the file and parse it with `@std/dotenv`. */
async function defaultLoadEnv(
	envPath: string,
	explicit: boolean,
): Promise<Record<string, string>> {
	let text: string;
	try {
		text = await Deno.readTextFile(envPath);
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			if (explicit) throw new UsageError(`env file not found: ${envPath}`);
			return {};
		}
		throw e;
	}
	return parseDotenv(text);
}

/** Fills in defaults for any omitted {@link CliIo} collaborators. */
function resolveIo(io: CliIo): ResolvedIo {
	return {
		out: io.out ?? ((line: string) => console.log(line)),
		err: io.err ?? ((line: string) => console.error(line)),
		env: io.env ?? ((key: string) => Deno.env.get(key)),
		loadEnv: io.loadEnv ?? defaultLoadEnv,
		stdin: io.stdin ?? defaultStdin,
		makeTransport: io.createTransport ?? createNodemailerTransport,
	};
}

/** Parses a boolean-ish env value. Throws {@link UsageError} on garbage. */
function parseBoolEnv(value: string | undefined): boolean | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const s = value.trim().toLowerCase();
	if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
	if (s === "false" || s === "0" || s === "no" || s === "off") return false;
	throw new UsageError(`invalid boolean value: "${value}"`);
}

/**
 * Parses a strict non-negative decimal integer env value, optionally
 * range-checked. Rejects hex/scientific/whitespace/negative forms (which
 * `Number()` would otherwise silently accept) so misconfigs fail here with a
 * friendly usage error rather than later as an opaque socket error.
 * Throws {@link UsageError} on anything invalid.
 */
function parseIntEnv(
	value: string | undefined,
	name: string,
	range?: { min: number; max: number },
): number | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) {
		throw new UsageError(
			`${name} must be a non-negative integer, got "${value}"`,
		);
	}
	const n = Number(trimmed);
	if (range && (n < range.min || n > range.max)) {
		throw new UsageError(
			`${name} must be between ${range.min} and ${range.max}, got ${n}`,
		);
	}
	return n;
}

/**
 * Resolves SMTP transport options from environment values. This is the CLI's
 * env → options seam; the library itself never reads env.
 */
function resolveSmtpOptions(
	env: (key: string) => string | undefined,
): NodemailerTransportOptions {
	const host = env("SMTP_HOST");
	if (!host) {
		throw new UsageError(
			"missing required env SMTP_HOST (set it in your .env or environment)",
		);
	}

	const options: NodemailerTransportOptions = {
		host,
		port: parseIntEnv(env("SMTP_PORT"), "SMTP_PORT", { min: 1, max: 65535 }) ??
			587,
	};

	const secure = parseBoolEnv(env("SMTP_SECURE"));
	if (secure !== undefined) options.secure = secure;

	const user = env("SMTP_USER");
	const pass = env("SMTP_PASS");
	if (user !== undefined || pass !== undefined) {
		options.auth = { user: user ?? "", pass: pass ?? "" };
	}

	const defaultReplyTo = env("SMTP_REPLY_TO");
	if (defaultReplyTo) options.defaultReplyTo = defaultReplyTo;

	const servername = env("SMTP_SERVERNAME");
	const rejectUnauthorized = parseBoolEnv(env("SMTP_TLS_REJECT_UNAUTHORIZED"));
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

/** Flattens a repeatable/comma-separated address flag into a clean list. */
function collectAddresses(value: unknown): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : [value];
	const out: string[] = [];
	for (const item of items) {
		for (const part of String(item).split(",")) {
			const trimmed = part.trim();
			if (trimmed) out.push(trimmed);
		}
	}
	return out;
}

/** Flattens a repeatable string flag into a list (no comma splitting). */
function collectStrings(value: unknown): string[] {
	if (value === undefined) return [];
	const items = Array.isArray(value) ? value : [value];
	return items.map((i) => String(i)).filter((s) => s.length > 0);
}

/** Reads a body from a file, mapping not-found to a friendly usage error. */
async function readFileBody(path: string): Promise<string> {
	try {
		return await Deno.readTextFile(path);
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			throw new UsageError(`file not found: ${path}`);
		}
		throw e;
	}
}

// deno-lint-ignore no-explicit-any -- parseArgs returns a loosely-typed bag.
type ParsedArgs = Record<string, any>;

/** Builds a {@link SendOptions} from parsed CLI args, env defaults, and stdin. */
async function buildMessage(
	parsed: ParsedArgs,
	env: (key: string) => string | undefined,
	stdin: { isTerminal(): boolean; read(): Promise<string> },
): Promise<SendOptions> {
	const to = collectAddresses(parsed.to);
	if (to.length === 0) {
		throw new UsageError("at least one --to recipient is required");
	}

	const fromFlag = typeof parsed.from === "string" ? parsed.from : undefined;
	const from = (fromFlag && fromFlag.length > 0 ? fromFlag : undefined) ??
		env("SMTP_FROM");
	if (!from) {
		throw new UsageError("--from is required (or set env SMTP_FROM)");
	}

	const message: SendOptions = {
		to: to.length === 1 ? to[0] : to,
		from,
		subject: typeof parsed.subject === "string" ? parsed.subject : "",
	};

	const cc = collectAddresses(parsed.cc);
	if (cc.length > 0) message.cc = cc.length === 1 ? cc[0] : cc;
	const bcc = collectAddresses(parsed.bcc);
	if (bcc.length > 0) message.bcc = bcc.length === 1 ? bcc[0] : bcc;

	// --reply-to, else the SMTP_REPLY_TO env default. Resolving it here (rather
	// than relying on the transport's defaultReplyTo) keeps the --dry-run preview
	// honest about the Reply-To a real send would stamp.
	const replyToFlag = typeof parsed["reply-to"] === "string"
		? parsed["reply-to"]
		: undefined;
	const replyTo = (replyToFlag && replyToFlag.length > 0 ? replyToFlag : undefined) ??
		env("SMTP_REPLY_TO");
	if (replyTo && replyTo.length > 0) message.replyTo = replyTo;

	// Body resolution: file > inline flag > stdin (when piped).
	const htmlFlag = parsed.html;
	const textFlag = parsed.text;
	const htmlFile = typeof parsed["html-file"] === "string"
		? parsed["html-file"]
		: undefined;
	const textFile = typeof parsed["text-file"] === "string"
		? parsed["text-file"]
		: undefined;

	if (htmlFile) message.html = await readFileBody(htmlFile);
	else if (typeof htmlFlag === "string" && htmlFlag.length > 0) message.html = htmlFlag;

	if (textFile) message.text = await readFileBody(textFile);
	else if (typeof textFlag === "string" && textFlag.length > 0) message.text = textFlag;

	const hasBody = message.html !== undefined || message.text !== undefined;
	if (!hasBody && !stdin.isTerminal()) {
		const piped = await stdin.read();
		if (piped.length > 0) {
			// A bare `--html` (present but empty) marks the piped body as HTML.
			const asHtml = htmlFlag === "" || htmlFlag === true;
			if (asHtml) message.html = piped;
			else message.text = piped;
		}
	}

	const attachments = collectStrings(parsed.attach).map((path) => ({
		path,
		filename: basename(path),
	}));
	if (attachments.length > 0) message.attachments = attachments;

	return message;
}

/** Builds an env getter that prefers process env, falling back to the `.env` file. */
async function buildEnvGetter(
	parsed: ParsedArgs,
	io: ResolvedIo,
): Promise<(key: string) => string | undefined> {
	const explicit = typeof parsed["env-file"] === "string";
	const envPath = explicit ? (parsed["env-file"] as string) : "./.env";
	const fileEnv = await io.loadEnv(envPath, explicit);
	// Process env wins over the .env file — but a present-but-empty process
	// value (e.g. `export SMTP_HOST=`) is treated as absent so it can't shadow a
	// valid .env value.
	return (key: string): string | undefined => {
		const fromProcess = io.env(key);
		if (fromProcess !== undefined && fromProcess.trim() !== "") {
			return fromProcess;
		}
		return fileEnv[key];
	};
}

/** Human-readable dry-run summary (no secrets — the message carries none). */
function formatDryRun(message: SendOptions, externalId: string): string {
	const list = (v: string | string[] | undefined): string =>
		v === undefined ? "" : Array.isArray(v) ? v.join(", ") : v;
	const lines = [
		"[dry-run] would send via mock transport:",
		`  to:       ${list(message.to)}`,
		`  from:     ${message.from}`,
		`  subject:  ${message.subject}`,
	];
	if (message.cc) lines.push(`  cc:       ${list(message.cc)}`);
	if (message.bcc) lines.push(`  bcc:      ${list(message.bcc)}`);
	if (message.replyTo) lines.push(`  reply-to: ${message.replyTo}`);
	if (message.html !== undefined) {
		lines.push(`  html:     ${message.html.length} chars`);
	}
	if (message.text !== undefined) {
		lines.push(`  text:     ${message.text.length} chars`);
	}
	if (message.attachments && message.attachments.length > 0) {
		lines.push(
			`  attach:   ${message.attachments.map((a) => a.filename).join(", ")}`,
		);
	}
	lines.push(`  id:       ${externalId}`);
	return lines.join("\n");
}

/** Heuristic hint for the common TLS cert-hostname-mismatch failure. */
function certHint(message: string): string | undefined {
	const m = message.toLowerCase();
	if (
		m.includes("altname") ||
		m.includes("hostname/ip does not match") ||
		m.includes("does not match certificate") ||
		m.includes("cert")
	) {
		return "Hint: looks like a TLS certificate hostname mismatch — set " +
			"SMTP_SERVERNAME to the certificate's hostname, or " +
			"SMTP_TLS_REJECT_UNAUTHORIZED=false as an insecure last resort.";
	}
	return undefined;
}

/** Handles `send`. */
async function handleSend(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const env = await buildEnvGetter(parsed, io);
	const message = await buildMessage(parsed, env, io.stdin);

	const dryRun = parsed["dry-run"] === true;
	const transport: EmailTransport = dryRun
		? createMockTransport()
		: io.makeTransport(resolveSmtpOptions(env));

	const result = await transport.send(message);

	if (parsed.json === true) {
		io.out(JSON.stringify({
			ok: true,
			externalId: result.externalId,
			transport: transport.name,
		}));
	} else if (dryRun) {
		io.out(formatDryRun(message, result.externalId));
	} else {
		io.out(`✅ sent via ${transport.name} (id: ${result.externalId})`);
	}
	return 0;
}

/** Handles `verify`. */
async function handleVerify(parsed: ParsedArgs, io: ResolvedIo): Promise<number> {
	const env = await buildEnvGetter(parsed, io);
	const transport = io.makeTransport(resolveSmtpOptions(env));

	if (typeof transport.verify !== "function") {
		if (parsed.json === true) {
			io.out(JSON.stringify({
				ok: true,
				transport: transport.name,
				supported: false,
			}));
		} else {
			io.out(`verification not supported by ${transport.name}`);
		}
		return 0;
	}

	await transport.verify();

	if (parsed.json === true) {
		io.out(JSON.stringify({ ok: true, transport: transport.name }));
	} else {
		io.out(`✅ ${transport.name}: connection + auth OK`);
	}
	return 0;
}

/**
 * Runs the CLI and returns a process exit code. Never calls `Deno.exit`.
 *
 * @param args - Argument vector (e.g. `Deno.args`).
 * @param io - Optional injected I/O + collaborators (see {@link CliIo}).
 * @returns The exit code: `0` success, `1` runtime failure, `2` usage error.
 */
export async function runCli(args: string[], io: CliIo = {}): Promise<number> {
	const resolved = resolveIo(io);
	const parsed = parseArgs(args, {
		string: [
			"from",
			"subject",
			"text",
			"html",
			"html-file",
			"text-file",
			"reply-to",
			"env-file",
		],
		boolean: ["json", "dry-run", "help", "version"],
		collect: ["to", "cc", "bcc", "attach"],
		alias: { h: "help", s: "subject" },
	});

	const command = parsed._[0] !== undefined ? String(parsed._[0]) : undefined;

	// Fast paths that never throw.
	if (parsed.version === true) {
		resolved.out(VERSION);
		return 0;
	}
	if (command === "version") {
		resolved.out(VERSION);
		return 0;
	}
	if (command === "help") {
		resolved.out(HELP);
		return 0;
	}
	if (!command) {
		if (parsed.help === true || args.length === 0) {
			resolved.out(HELP);
			return 0;
		}
		resolved.err(
			"Error: a subcommand is required: send | verify. Run with --help for usage.",
		);
		return 2;
	}
	if (parsed.help === true) {
		resolved.out(HELP);
		return 0;
	}

	try {
		switch (command) {
			case "send":
				return await handleSend(parsed, resolved);
			case "verify":
				return await handleVerify(parsed, resolved);
			default:
				throw new UsageError(
					`unknown command "${command}". Valid: send, verify, help, version.`,
				);
		}
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		if (parsed.json === true) {
			resolved.err(JSON.stringify({ ok: false, error: message }));
		} else {
			resolved.err(`Error: ${message}`);
			const hint = certHint(message);
			if (hint) resolved.err(hint);
		}
		return e instanceof UsageError ? 2 : 1;
	}
}
