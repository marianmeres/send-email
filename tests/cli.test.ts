import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
		stdin: overrides.stdin ?? {
			isTerminal: () => true,
			read: () => Promise.resolve(""),
		},
		createTransport: overrides.createTransport,
	};
	return { io, out, err };
}

/** Env getter from a plain record. */
const envFrom =
	(rec: Record<string, string>) =>
	(k: string): string | undefined =>
		rec[k];

const SMTP_ENV = { SMTP_HOST: "smtp.example.com", SMTP_FROM: "from@example.com" };

// --- help / version / dispatch ------------------------------------------

test("help: `help` prints usage, exit 0", async () => {
	const { io, out } = makeIo();
	assert.equal(await runCli(["help"], io), 0);
	assert.match(out.join("\n"), /Commands:/);
});

test("help: no args prints usage, exit 0", async () => {
	const { io, out } = makeIo();
	assert.equal(await runCli([], io), 0);
	assert.match(out.join("\n"), /send-email v/);
});

test("version: --version prints a semver, exit 0", async () => {
	const { io, out } = makeIo();
	assert.equal(await runCli(["--version"], io), 0);
	assert.match(out[0] ?? "", /^\d+\.\d+\.\d+/);
});

test("dispatch: bare flags without subcommand → usage error (exit 2)", async () => {
	const { io, err } = makeIo();
	assert.equal(await runCli(["--to", "a@b.com"], io), 2);
	assert.match(err.join("\n"), /subcommand is required/);
});

test("dispatch: unknown command → usage error (exit 2)", async () => {
	const { io, err } = makeIo();
	assert.equal(await runCli(["frobnicate"], io), 2);
	assert.match(err.join("\n"), /unknown command/);
});

// --- send: success + arg parsing ----------------------------------------

test("send: --json success shape { ok, externalId, transport }", async () => {
	const transport = createMockTransport();
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
	});
	const code = await runCli(
		["send", "--to", "a@b.com", "--subject", "Hi", "--text", "yo", "--json"],
		io,
	);
	assert.equal(code, 0);
	const parsed = JSON.parse(out[0]!);
	assert.deepEqual(parsed, { ok: true, externalId: "mock-1", transport: "mock" });
	assert.equal(transport.getLastEmail()?.text, "yo");
});

test("send: repeatable --to and comma lists flatten into recipients", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli(
		["send", "--to", "a@b.com", "--to", "b@c.com,d@e.com", "--text", "x"],
		io,
	);
	assert.deepEqual(transport.getLastEmail()?.to, ["a@b.com", "b@c.com", "d@e.com"]);
});

test("send: maps cc/bcc/reply-to/html/attach", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli(
		[
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
		],
		io,
	);
	const m = transport.getLastEmail();
	assert.equal(m?.cc, "c@x.com");
	assert.equal(m?.bcc, "d@x.com");
	assert.equal(m?.replyTo, "r@x.com");
	assert.equal(m?.html, "<p>h</p>");
	assert.deepEqual(m?.attachments, [{ path: "/tmp/x.pdf", filename: "x.pdf" }]);
});

test("send: -s aliases --subject", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({ env: envFrom(SMTP_ENV), createTransport: () => transport });
	await runCli(["send", "--to", "a@b.com", "-s", "Aliased", "--text", "x"], io);
	assert.equal(transport.getLastEmail()?.subject, "Aliased");
});

// --- send: body from file + stdin ---------------------------------------

test("send: --text-file reads body from a file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "send-email-"));
	const path = join(dir, "body.txt");
	await writeFile(path, "body from file");
	try {
		const transport = createMockTransport();
		const { io } = makeIo({
			env: envFrom(SMTP_ENV),
			createTransport: () => transport,
		});
		await runCli(["send", "--to", "a@b.com", "--text-file", path], io);
		assert.equal(transport.getLastEmail()?.text, "body from file");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("send: missing body file → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => createMockTransport(),
	});
	const code = await runCli(
		["send", "--to", "a@b.com", "--text-file", "/no/such/file.txt"],
		io,
	);
	assert.equal(code, 2);
	assert.match(err.join("\n"), /file not found/);
});

test("send: body from piped stdin defaults to text", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
		stdin: { isTerminal: () => false, read: () => Promise.resolve("piped body") },
	});
	await runCli(["send", "--to", "a@b.com"], io);
	assert.equal(transport.getLastEmail()?.text, "piped body");
	assert.equal(transport.getLastEmail()?.html, undefined);
});

test("send: bare --html marks piped stdin as HTML", async () => {
	const transport = createMockTransport();
	const { io } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
		stdin: { isTerminal: () => false, read: () => Promise.resolve("<p>piped</p>") },
	});
	await runCli(["send", "--to", "a@b.com", "--html"], io);
	assert.equal(transport.getLastEmail()?.html, "<p>piped</p>");
	assert.equal(transport.getLastEmail()?.text, undefined);
});

// --- send: dry run ------------------------------------------------------

test("send: --dry-run uses the mock transport and needs no SMTP_HOST", async () => {
	const { io, out } = makeIo({ env: envFrom({ SMTP_FROM: "from@example.com" }) });
	const code = await runCli(
		["send", "--to", "a@b.com", "--text", "hello", "--dry-run"],
		io,
	);
	assert.equal(code, 0);
	const joined = out.join("\n");
	assert.match(joined, /\[dry-run\]/);
	assert.match(joined, /a@b\.com/);
});

test("send: --dry-run --json shape", async () => {
	const { io, out } = makeIo({ env: envFrom({ SMTP_FROM: "from@example.com" }) });
	await runCli(["send", "--to", "a@b.com", "--text", "x", "--dry-run", "--json"], io);
	assert.deepEqual(JSON.parse(out[0]!), {
		ok: true,
		externalId: "mock-1",
		transport: "mock",
	});
});

// --- send: validation + env resolution ----------------------------------

test("send: missing --to → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /--to/);
});

test("send: missing --from and no SMTP_FROM → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "smtp.example.com" }),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /--from/);
});

test("send: missing SMTP_HOST → usage error (exit 2), JSON envelope on stderr", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_FROM: "from@example.com" }),
		createTransport: () => createMockTransport(),
	});
	const code = await runCli(["send", "--to", "a@b.com", "--text", "x", "--json"], io);
	assert.equal(code, 2);
	const parsed = JSON.parse(err[0]!);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /SMTP_HOST/);
});

test("send: resolves SMTP options from env (file env, secure default, auth, tls)", async () => {
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
	assert.equal(captured?.host, "smtp.x");
	assert.equal(captured?.port, 465);
	assert.deepEqual(captured?.secure, undefined); // resolved later by the transport
	assert.deepEqual(captured?.auth, { user: "u", pass: "p" });
	assert.equal(captured?.tls?.servername, "real.host");
	assert.equal(captured?.connectionTimeout, 9000);
});

test("send: process env takes precedence over .env file", async () => {
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
	assert.equal(captured?.host, "proc.host");
});

test("send: invalid SMTP_PORT → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "not-a-number", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /SMTP_PORT/);
});

test("send: explicit --env-file that does not exist → usage error (exit 2)", async () => {
	// Uses the real default loader (no loadEnv override) to exercise the
	// missing-explicit-file branch.
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCli(
		["send", "--to", "a@b.com", "--text", "x", "--env-file", "/no/such/.env"],
		{
			out: (l) => out.push(l),
			err: (l) => err.push(l),
			env: () => undefined,
			createTransport: () => createMockTransport(),
		},
	);
	assert.equal(code, 2);
	assert.match(err.join("\n"), /env file not found/);
});

test("send: TLS cert-hostname-mismatch failure prints a SMTP_SERVERNAME hint", async () => {
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
	assert.equal(code, 1);
	assert.match(err.join("\n"), /SMTP_SERVERNAME/);
});

// --- verify -------------------------------------------------------------

test("verify: success prints OK and increments mock verifyCount", async () => {
	const transport = createMockTransport();
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => transport,
	});
	assert.equal(await runCli(["verify", "--json"], io), 0);
	assert.deepEqual(JSON.parse(out[0]!), { ok: true, transport: "mock" });
	assert.equal(transport.verifyCount, 1);
});

test("verify: transport without verify() → 'not supported', exit 0", async () => {
	const noVerify: EmailTransport = {
		name: "no-verify",
		send: () => Promise.resolve({ externalId: "x" }),
	};
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => noVerify,
	});
	assert.equal(await runCli(["verify"], io), 0);
	assert.match(out.join("\n"), /not supported by no-verify/);
});

test("verify --json: unsupported transport → { ok, transport, supported:false }", async () => {
	const noVerify: EmailTransport = {
		name: "no-verify",
		send: () => Promise.resolve({ externalId: "x" }),
	};
	const { io, out } = makeIo({
		env: envFrom(SMTP_ENV),
		createTransport: () => noVerify,
	});
	assert.equal(await runCli(["verify", "--json"], io), 0);
	assert.deepEqual(JSON.parse(out[0]!), {
		ok: true,
		transport: "no-verify",
		supported: false,
	});
});

test("verify: failure → exit 1 with JSON error envelope", async () => {
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
	assert.equal(code, 1);
	const parsed = JSON.parse(err[0]!);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /auth failed/);
});

test("verify: missing SMTP_HOST → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: () => undefined,
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["verify"], io), 2);
	assert.match(err.join("\n"), /SMTP_HOST/);
});

// --- env edge cases -----------------------------------------------------

test("send: invalid boolean SMTP_SECURE → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_SECURE: "maybe", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /invalid boolean value/);
});

test("send: non-decimal SMTP_PORT (hex) → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "0x1bb", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /SMTP_PORT/);
});

test("send: out-of-range SMTP_PORT → usage error (exit 2)", async () => {
	const { io, err } = makeIo({
		env: envFrom({ SMTP_HOST: "h", SMTP_PORT: "70000", SMTP_FROM: "f@x.com" }),
		createTransport: () => createMockTransport(),
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 2);
	assert.match(err.join("\n"), /between 1 and 65535/);
});

test("send: resolves SMTP_SECURE + SMTP_TLS_REJECT_UNAUTHORIZED from env", async () => {
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
	assert.equal(captured?.secure, true);
	assert.equal(captured?.tls?.rejectUnauthorized, false);
	assert.equal(captured?.socketTimeout, 8000);
});

test("send: empty process-env value does not shadow a valid .env value", async () => {
	let captured: NodemailerTransportOptions | undefined;
	const { io } = makeIo({
		env: (k) => (k === "SMTP_HOST" ? "" : undefined), // present but empty
		loadEnv: () => Promise.resolve({ SMTP_HOST: "file.host", SMTP_FROM: "f@x.com" }),
		createTransport: (opts) => {
			captured = opts;
			return createMockTransport();
		},
	});
	assert.equal(await runCli(["send", "--to", "a@b.com", "--text", "x"], io), 0);
	assert.equal(captured?.host, "file.host");
});

test("send: SMTP_REPLY_TO env default shows up in --dry-run preview", async () => {
	const { io, out } = makeIo({
		env: envFrom({ SMTP_FROM: "f@x.com", SMTP_REPLY_TO: "reply@x.com" }),
	});
	await runCli(["send", "--to", "a@b.com", "--text", "x", "--dry-run"], io);
	assert.match(out.join("\n"), /reply-to: reply@x\.com/);
});
