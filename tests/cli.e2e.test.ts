// End-to-end: spawn the CLI and check the stream contract and exit codes, through the
// real defaults the unit tests inject away — `process.env`, `./.env` loading, stdin.
// Only `--dry-run` sends, so nothing touches the network.
//
// The CLI runs on Node from source (src/bin.ts, the npm bin). `CLI_RUNTIME=deno` runs
// src/main.ts on Deno instead (`pnpm run test:deno`): the JSR entry, as
// `deno run -A jsr:@marianmeres/send-email` executes it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/** How the CLI is started: Node by default, Deno under `CLI_RUNTIME=deno`. */
const CLI_ARGV: [string, ...string[]] =
	process.env.CLI_RUNTIME === "deno"
		? [
				"deno",
				"run",
				"-A",
				"--no-lock",
				"--config",
				path("../jsr.json"),
				path("../src/main.ts"),
			]
		: [process.execPath, path("../src/bin.ts")];

/** The caller's environment minus any `SMTP_*`, so a developer's setup cannot leak in. */
const BASE_ENV: Record<string, string | undefined> = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !k.startsWith("SMTP_")),
);

/** Each test runs in its own scratch cwd, so `./.env` is the one the test writes. */
let cwd: string;
before(async () => {
	cwd = await mkdtemp(join(tmpdir(), "send-email-e2e-"));
});
after(async () => {
	await rm(cwd, { recursive: true, force: true });
});

function cli(
	args: string[],
	opts: { env?: Record<string, string>; input?: string } = {},
): { code: number | null; stdout: string; stderr: string } {
	const { status, stdout, stderr } = spawnSync(
		CLI_ARGV[0],
		[...CLI_ARGV.slice(1), ...args],
		{
			cwd,
			env: { ...BASE_ENV, ...opts.env },
			encoding: "utf8",
			input: opts.input,
			// Without `input`, stdin is /dev/null: not a TTY, empty.
			stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		},
	);
	return { code: status, stdout, stderr };
}

test("--version prints the package version, exit 0", async () => {
	const pkg = JSON.parse(await readFile(path("../package.json"), "utf8"));
	assert.deepEqual(cli(["--version"]), {
		code: 0,
		stdout: `${pkg.version}\n`,
		stderr: "",
	});
});

test("--help prints usage, exit 0", () => {
	const r = cli(["--help"]);
	assert.equal(r.code, 0);
	assert.match(r.stdout, /Usage:\n {2}send-email <command> \[options\]/);
});

test("send --dry-run --json: SMTP_FROM from the process env", () => {
	const r = cli(["send", "--to", "a@b.com", "--text", "hi", "--dry-run", "--json"], {
		env: { SMTP_FROM: "from@example.com" },
	});
	assert.deepEqual(r, {
		code: 0,
		stdout: `${JSON.stringify({ ok: true, externalId: "mock-1", transport: "mock" })}\n`,
		stderr: "",
	});
});

test("send --dry-run: ./.env is loaded (BOM and all); the process env wins over it", async () => {
	await writeFile(
		join(cwd, ".env"),
		"﻿SMTP_FROM=file@example.com\nSMTP_REPLY_TO='reply@example.com' # comment\n",
	);
	try {
		const fromFile = cli(["send", "--to", "a@b.com", "--text", "hi", "--dry-run"]);
		assert.equal(fromFile.code, 0, fromFile.stderr);
		assert.match(fromFile.stdout, /from: {5}file@example\.com/);
		assert.match(fromFile.stdout, /reply-to: reply@example\.com\n/);

		const fromProcess = cli(
			["send", "--to", "a@b.com", "--text", "hi", "--dry-run"],
			{
				env: { SMTP_FROM: "proc@example.com" },
			},
		);
		assert.match(fromProcess.stdout, /from: {5}proc@example\.com/);
	} finally {
		await rm(join(cwd, ".env"));
	}
});

test("send --dry-run: body from piped stdin, as HTML with a bare --html", () => {
	const env = { SMTP_FROM: "from@example.com" };
	const asText = cli(["send", "--to", "a@b.com", "--dry-run"], {
		env,
		input: "piped body",
	});
	assert.equal(asText.code, 0, asText.stderr);
	assert.match(asText.stdout, /text: {5}10 chars/);

	const asHtml = cli(["send", "--to", "a@b.com", "--html", "--dry-run"], {
		env,
		input: "<p>piped</p>",
	});
	assert.equal(asHtml.code, 0, asHtml.stderr);
	assert.match(asHtml.stdout, /html: {5}12 chars/);
	assert.doesNotMatch(asHtml.stdout, /text:/);
});

test("send --dry-run: --text-file reads the body from a file", async () => {
	await writeFile(join(cwd, "body.txt"), "from a file");
	const r = cli(["send", "--to", "a@b.com", "--text-file", "body.txt", "--dry-run"], {
		env: { SMTP_FROM: "from@example.com" },
	});
	assert.equal(r.code, 0, r.stderr);
	assert.match(r.stdout, /text: {5}11 chars/);
});

test("unknown flag → usage error, exit 2", () => {
	const r = cli(["send", "--to", "a@b.com", "--subjet", "typo"]);
	assert.equal(r.code, 2);
	assert.equal(r.stdout, "");
	assert.match(r.stderr, /Unknown option '--subjet'/);
	assert.match(r.stderr, /--help/);
});

test("missing SMTP_HOST → usage error, exit 2, JSON envelope on stderr", () => {
	const r = cli(["send", "--to", "a@b.com", "--text", "hi", "--json"], {
		env: { SMTP_FROM: "from@example.com" },
	});
	assert.equal(r.code, 2);
	assert.equal(r.stdout, "");
	const parsed = JSON.parse(r.stderr);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error, /SMTP_HOST/);
});
