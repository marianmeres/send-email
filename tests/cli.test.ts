import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { type CliIo, runCli } from "../src/cli.ts";
import { createMockTransport } from "../src/transport-mock.ts";
import type { NodemailerTransportOptions } from "../src/transport-nodemailer.ts";
import type { EmailTransport } from "../src/types.ts";

/** Builds a capturing {@link CliIo} plus the captured stdout/stderr buffers. */
function makeIo(overrides: Partial<CliIo> = {}): {
	io: CliIo;
	out: string[];
	err: string[];
} {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIo = {
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		env: overrides.env ?? (() => undefined),
		loadEnv: overrides.loadEnv ?? (() => Promise.resolve({})),
		stdin: overrides.stdin ??
			{ isTerminal: () => true, read: () => Promise.resolve("") },
		createTransport: overrides.createTransport,
	};
	return { io, out, err };
}

/** Env getter from a plain record. */
const envFrom = (rec: Record<string, string>) => (k: string): string | undefined =>
	rec[k];

const SMTP_ENV = { SMTP_HOST: "smtp.example.com", SMTP_FROM: "from@example.com" };

// --- help / version / dispatch ------------------------------------------

Deno.test("help: `help` prints usage, exit 0", async () => {
	const { io, out } = makeIo();
	assertEquals(await runCli(["help"], io), 0);
	assertStringIncludes(out.join("\n"), "Commands:");
});

Deno.test("help: no args prints usage, exit 0", async () => {
	const { io, out } = makeIo();
	assertEquals(await runCli([], io), 0);
	assertStringIncludes(out.join("\n"), "send-email v");
});

Deno.test("version: --version prints a semver, exit 0", async () => {
	const { io, out } = makeIo();
	assertEquals(await runCli(["--version"], io), 0);
	assert(/^\d+\.\d+\.\d+/.test(out[0]), `unexpected version output: ${out[0]}`);
});

Deno.test("dispatch: bare flags without subcommand → usage error (exit 2)", async () => {
	const { io, err } = makeIo();
	assertEquals(await runCli(["--to", "a@b.com"], io), 2);
	assertStringIncludes(err.join("\n"), "subcommand is required");
});

Deno.test("dispatch: unknown command → usage error (exit 2)", async () => {
	const { io, err } = makeIo();
	assertEquals(await runCli(["frobnicate"], io), 2);
	assertStringIncludes(err.join("\n"), "unknown command");
});

// --- send: success + arg parsing ----------------------------------------

Deno.test("send: --json success shape { ok, externalId, transport }", async () => {
	const transport = createMockTransport();
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
	});
	const code = await runCli(
		["send", "--to", "a@b.com", "--subject", "Hi", "--text", "yo", "--json"],
		io,
	);
	assertEquals(code, 0);
	const parsed = JSON.parse(out[0]);
	assertEquals(parsed, { ok: true, externalId: "mock-1", transport: "mock" });
	assertEquals(transport.getLastEmail()?.text, "yo");
});

Deno.test("send: repeatable --to and comma lists flatten into recipients", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli(
		["send", "--to", "a@b.com", "--to", "b@c.com,d@e.com", "--text", "x"],
		io,
	);
	assertEquals(transport.getLastEmail()?.to, ["a@b.com", "b@c.com", "d@e.com"]);
});

Deno.test("send: maps cc/bcc/reply-to/html/attach", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli([
		"send",
		"--to",
		"a@b.com",
		"--cc",
		"c@x.com",
		"--bcc",
		"d@x.com",
		"--reply-to",
		"r@x.com",
		"--subject",
		"S",
		"--html",
		"<p>h</p>",
		"--attach",
		"/tmp/x.pdf",
	], io);
	const m = transport.getLastEmail();
	assertEquals(m?.cc, "c@x.com");
	assertEquals(m?.bcc, "d@x.com");
	assertEquals(m?.replyTo, "r@x.com");
	assertEquals(m?.html, "<p>h</p>");
	assertEquals(m?.attachments, [{ path: "/tmp/x.pdf", filename: "x.pdf" }]);
});

Deno.test("send: -s aliases --subject", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli(["send", "--to", "a@b.com", "-s", "Aliased", "--text", "x"], io);
	assertEquals(transport.getLastEmail()?.subject, "Aliased");
});

// --- send: body from file + stdin ---------------------------------------

Deno.test("send: --text-file reads body from a file", async () => {
	const path = await Deno.makeTempFile();
	await Deno.writeTextFile(path, "body from file");
	try {
		const transport = createMockTransport();
		const { io } = makeIo({
			env: envFrom(SMTP_ENV),
			createTransport: () => transport,
		});
		await runCli(["send", "--to", "a@b.com", "--text-file", path], io);
		assertEquals(transport.getLastEmail()?.text, "body from file");
	} finally {
		await Deno.remove(path);
	}
});

Deno.test("send: missing body file → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => createMockTransport(),
	});
	const code = await runCli(
		["send", "--to", "a@b.com", "--text-file", "/no/such/file.txt"],
		io,
	);
	assertEquals(code, 2);
	assertStringIncludes(err.join("\n"), "file not found");
});

Deno.test("send: body from piped stdin defaults to text", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
		stdin: { isTerminal: () => false, read: () => Promise.resolve("piped body") },
	});
	await runCli(["send", "--to", "a@b.com"], io);
	assertEquals(transport.getLastEmail()?.text, "piped body");
	assertEquals(transport.getLastEmail()?.html, undefined);
});

Deno.test("send: bare --html marks piped stdin as HTML", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
		stdin: { isTerminal: () => false, read: () => Promise.resolve("<p>piped</p>") },
	});
	await runCli(["send", "--to", "a@b.com", "--html"], io);
	assertEquals(transport.getLastEmail()?.html, "<p>piped</p>");
	assertEquals(transport.getLastEmail()?.text, undefined);
});

// --- send: dry run ------------------------------------------------------

Deno.test("send: --dry-run uses the mock transport and needs no SMTP_HOST", async () => {
	const { io, out } = makeIo({ env: envFrom({ SMTP_FROM: "from@example.com" }) });
	const code = await runCli(
		["send", "--to", "a@b.com", "--text", "hello", "--dry-run"],
		io,
	);
	assertEquals(code, 0);
	const joined = out.join("\n");
	assertStringIncludes(joined, "[dry-run]");
	assertStringIncludes(joined, "a@b.com");
});

Deno.test("send: --dry-run --json shape", async () => {
	const { io, out } = makeIo({ env: envFrom({ SMTP_FROM: "from@example.com" }) });
	await runCli(["send", "--to", "a@b.com", "--text", "x", "--dry-run", "--json"], io);
	assertEquals(JSON.parse(out[0]), {
		ok: true,
		externalId: "mock-1",
		transport: "mock",
	});
});

// --- send: validation + env resolution ----------------------------------

Deno.test("send: missing --to → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "--to");
});

Deno.test("send: missing --from and no SMTP_FROM → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "smtp.example.com" }),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "--from");
});

Deno.test("send: missing SMTP_HOST → usage error (exit 2), JSON envelope on stderr", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_FROM: "from@example.com" }),
		createTransport: () => createMockTransport(),
	});
	const code = await runCli(["send", "--to", "a@b.com", "--text", "x", "--json"], io);
	assertEquals(code, 2);
	const parsed = JSON.parse(err[0]);
	assertEquals(parsed.ok, false);
	assertStringIncludes(parsed.error, "SMTP_HOST");
});

Deno.test("send: resolves SMTP options from env (file env, secure default, auth, tls)", async () => {
	let captured: NodemailerTransportOptions | undefined;
	const { io } = makeIo({
		env: () => undefined,
		loadEnv: () =>
			Promise.resolve({
				SMTP_HOST: "smtp.x",
				SMTP_PORT: "465",
				SMTP_USER: "u",
				SMTP_PASS: "p",
				SMTP_FROM: "f@x.com",
				SMTP_SERVERNAME: "real.host",
				SMTP_CONNECTION_TIMEOUT_MS: "9000",
			}),
		createTransport: (opts) => {
			captured = opts;
			return createMockTransport();
		},
	});
	await runCli(["send", "--to", "a@b.com", "--text", "x"], io);
	assertEquals(captured?.host, "smtp.x");
	assertEquals(captured?.port, 465);
	assertEquals(captured?.secure, undefined); // resolved later by the transport
	assertEquals(captured?.auth, { user: "u", pass: "p" });
	assertEquals(captured?.tls?.servername, "real.host");
	assertEquals(captured?.connectionTimeout, 9000);
});

Deno.test("send: process env takes precedence over .env file", async () => {
	let captured: NodemailerTransportOptions | undefined;
	const { io } = makeIo({
		env: (k) => (k === "SMTP_HOST" ? "proc.host" : undefined),
		loadEnv: () => Promise.resolve({ SMTP_HOST: "file.host", SMTP_FROM: "f@x.com" }),
		createTransport: (opts) => {
			captured = opts;
			return createMockTransport();
		},
	});
	await runCli(["send", "--to", "a@b.com", "--text", "x"], io);
	assertEquals(captured?.host, "proc.host");
});

Deno.test("send: invalid SMTP_PORT → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "not-a-number", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "SMTP_PORT");
});

Deno.test("send: explicit --env-file that does not exist → usage error (exit 2)", async () => {
	// Uses the real default loader (no loadEnv override) to exercise the
	// missing-explicit-file branch.
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli([
		"send",
		"--to",
		"a@b.com",
		"--text",
		"x",
		"--env-file",
		"/no/such/.env",
	], {
		out: (l) => out.push(l),
		err: (l) => err.push(l),
		env: () => undefined,
		createTransport: () => createMockTransport(),
	});
	assertEquals(code, 2);
	assertStringIncludes(err.join("\n"), "env file not found");
});

Deno.test("send: TLS cert-hostname-mismatch failure prints a SMTP_SERVERNAME hint", async () => {
	const failing: EmailTransport = {
		name: "nodemailer-smtp",
		send: () =>
			Promise.reject(new Error("ERR_TLS_CERT_ALTNAME_INVALID: host mismatch")),
	};
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => failing,
	});
	const code = await runCli(["send", "--to", "a@b.com", "--text", "x"], io);
	assertEquals(code, 1);
	assertStringIncludes(err.join("\n"), "SMTP_SERVERNAME");
});

// --- verify -------------------------------------------------------------

Deno.test("verify: success prints OK and increments mock verifyCount", async () => {
	const transport = createMockTransport();
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
	});
	assertEquals(await runCli(["verify", "--json"], io), 0);
	assertEquals(JSON.parse(out[0]), { ok: true, transport: "mock" });
	assertEquals(transport.verifyCount, 1);
});

Deno.test("verify: transport without verify() → 'not supported', exit 0", async () => {
	const noVerify: EmailTransport = {
		name: "no-verify",
		send: () => Promise.resolve({ externalId: "x" }),
	};
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => noVerify,
	});
	assertEquals(await runCli(["verify"], io), 0);
	assertStringIncludes(out.join("\n"), "not supported by no-verify");
});

Deno.test("verify --json: unsupported transport → { ok, transport, supported:false }", async () => {
	const noVerify: EmailTransport = {
		name: "no-verify",
		send: () => Promise.resolve({ externalId: "x" }),
	};
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => noVerify,
	});
	assertEquals(await runCli(["verify", "--json"], io), 0);
	assertEquals(JSON.parse(out[0]), {
		ok: true,
		transport: "no-verify",
		supported: false,
	});
});

Deno.test("verify: failure → exit 1 with JSON error envelope", async () => {
	const failing: EmailTransport = {
		name: "nodemailer-smtp",
		send: () => Promise.resolve({ externalId: "x" }),
		verify: () => Promise.reject(new Error("auth failed")),
	};
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => failing,
	});
	const code = await runCli(["verify", "--json"], io);
	assertEquals(code, 1);
	const parsed = JSON.parse(err[0]);
	assertEquals(parsed.ok, false);
	assertStringIncludes(parsed.error, "auth failed");
});

Deno.test("verify: missing SMTP_HOST → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: () => undefined,
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["verify"], io), 2);
	assertStringIncludes(err.join("\n"), "SMTP_HOST");
});

// --- env edge cases -----------------------------------------------------

Deno.test("send: invalid boolean SMTP_SECURE → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_SECURE: "maybe", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "invalid boolean value");
});

Deno.test("send: non-decimal SMTP_PORT (hex) → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "0x1bb", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "SMTP_PORT");
});

Deno.test("send: out-of-range SMTP_PORT → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "70000", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assertStringIncludes(err.join("\n"), "between 1 and 65535");
});

Deno.test("send: resolves SMTP_SECURE + SMTP_TLS_REJECT_UNAUTHORIZED from env", async () => {
	let captured: NodemailerTransportOptions | undefined;
	const { io } = makeIo({
		env: envFrom({
			SMTP_HOST: "h",
			SMTP_SECURE: "true",
			SMTP_TLS_REJECT_UNAUTHORIZED: "false",
			SMTP_SOCKET_TIMEOUT_MS: "8000",
			SMTP_FROM: "f@x.com",
		}),
		createTransport: (opts) => {
			captured = opts;
			return createMockTransport();
		},
	});
	await runCli(["send", "--to", "a@b.com", "--text", "x"], io);
	assertEquals(captured?.secure, true);
	assertEquals(captured?.tls?.rejectUnauthorized, false);
	assertEquals(captured?.socketTimeout, 8000);
});

Deno.test("send: empty process-env value does not shadow a valid .env value", async () => {
	let captured: NodemailerTransportOptions | undefined;
	const { io } = makeIo({
		env: (k) => (k === "SMTP_HOST" ? "" : undefined), // present but empty
		loadEnv: () => Promise.resolve({ SMTP_HOST: "file.host", SMTP_FROM: "f@x.com" }),
		createTransport: (opts) => {
			captured = opts;
			return createMockTransport();
		},
	});
	assertEquals(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 0);
	assertEquals(captured?.host, "file.host");
});

Deno.test("send: SMTP_REPLY_TO env default shows up in --dry-run preview", async () => {
	const { io, out } = makeIo({
		env: envFrom({ SMTP_FROM: "f@x.com", SMTP_REPLY_TO: "reply@x.com" }),
	});
	await runCli(["send", "--to", "a@b.com", "--text", "x", "--dry-run"], io);
	assertStringIncludes(out.join("\n"), "reply-to: reply@x.com");
});
