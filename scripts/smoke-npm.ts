/**
 * Smoke-tests the built npm package (`pnpm run smoke`, or
 * `node scripts/smoke-npm.ts` after `pnpm run build`).
 *
 * `pnpm pack`s the repo root - the tarball `pnpm publish` would upload - and in a
 * throw-away project under the OS temp dir installs it with npm, as a consumer gets
 * it, then on Node:
 *
 *  1. checks the installed package.json (the `.` export and its files, the
 *     `send-email` bin, `nodemailer` as a runtime dependency, `engines.node`) and
 *     that the tarball carries `dist/` without the JSR-only `main.js` and without
 *     any repo-only directory;
 *  2. runs the installed `send-email` bin: `--version`, and a `--dry-run --json`
 *     send - the suite runs `src/*.ts`, so only here does the CLI run from
 *     `dist/*.js`, through npm's bin link;
 *  3. imports the library and sends through the mock transport.
 *
 * Repo tool, Node only (nothing here is shipped).
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = "@marianmeres/send-email";
const BIN = "send-email";

/** Repo directories the published tarball must not carry. */
const REPO_ONLY = ["src", "tests", "scripts", "tmp", "node_modules"];

/** Step 3: a library consumer. */
const LIBRARY = `
import assert from "node:assert/strict";
import { createMockTransport, resolveSmtpOptions, send } from "${PKG}";

const transport = createMockTransport();
const { externalId } = await send(
	{ to: "a@b.com", from: "c@d.com", subject: "Hi", text: "yo" },
	{ transport },
);
assert.equal(externalId, "mock-1");
assert.equal(transport.getLastEmail()?.subject, "Hi");
assert.deepEqual(resolveSmtpOptions((k) => ({ SMTP_HOST: "h" })[k]), { host: "h", port: 587 });
console.log("smoke: the library imports and sends through the mock transport");
`;

type Manifest = {
	name?: string;
	version?: string;
	exports?: Record<string, Record<string, string>>;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	engines?: Record<string, string>;
};

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
	console.log(`smoke: $ ${[cmd, ...args].join(" ")}`);
	return execFileSync(cmd, args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
}

function check(condition: unknown, what: string): asserts condition {
	if (!condition) throw new Error(`smoke: ${what}`);
}

function checkInstalledManifest(dir: string): Manifest {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
	check(pkg.name === PKG, `installed package is "${pkg.name}", expected "${PKG}"`);
	const exportKeys = Object.keys(pkg.exports ?? {});
	check(
		JSON.stringify(exportKeys) === JSON.stringify(["."]),
		`exports keys are ${JSON.stringify(exportKeys)}`,
	);
	for (const kind of ["types", "default"]) {
		const file = pkg.exports?.["."]?.[kind];
		check(
			file && existsSync(join(dir, file)),
			`exports["."].${kind} does not exist: ${file}`,
		);
	}
	const bin = pkg.bin?.[BIN];
	check(bin && existsSync(join(dir, bin)), `bin "${BIN}" does not exist: ${bin}`);
	check(
		typeof pkg.dependencies?.nodemailer === "string",
		`nodemailer is not a runtime dependency: ${JSON.stringify(pkg.dependencies)}`,
	);
	check(typeof pkg.engines?.node === "string", "engines.node missing");
	check(
		!existsSync(join(dir, "dist", "main.js")),
		"the tarball carries the JSR-only main.js",
	);
	for (const name of REPO_ONLY) {
		check(!existsSync(join(dir, name)), `the tarball carries "${name}/"`);
	}
	console.log(
		`smoke: ${pkg.name}@${pkg.version} - bin ${BIN}, nodemailer ` +
			`${pkg.dependencies?.nodemailer}, engines.node ${pkg.engines?.node}`,
	);
	return pkg;
}

check(
	existsSync(join(ROOT, "dist", "mod.js")) && existsSync(join(ROOT, "dist", "bin.js")),
	"dist/ is missing - run `pnpm run build` first",
);

const project = mkdtempSync(join(tmpdir(), "send-email-npm-smoke-"));
try {
	writeFileSync(
		join(project, "package.json"),
		JSON.stringify({ name: "send-email-npm-smoke", private: true, type: "module" }),
	);
	const packDir = join(project, "pack");
	mkdirSync(packDir);
	run("pnpm", ["pack", "--pack-destination", packDir], ROOT);
	const tarballs = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
	const [tarball] = tarballs;
	check(
		tarballs.length === 1 && tarball,
		`expected one tarball, got ${JSON.stringify(tarballs)}`,
	);

	run(
		"npm",
		[
			"install",
			"--no-audit",
			"--no-fund",
			"--loglevel=error",
			join(packDir, tarball),
		],
		project,
	);
	const pkg = checkInstalledManifest(join(project, "node_modules", PKG));

	// The bin, as `npx @marianmeres/send-email` / an installed `send-email` runs it.
	// No SMTP_* from the caller, and the project dir has no .env.
	const bin = join(project, "node_modules", ".bin", BIN);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !k.startsWith("SMTP_")),
	);
	const version = run(bin, ["--version"], project, env).trim();
	check(
		version === pkg.version,
		`--version printed "${version}", expected "${pkg.version}"`,
	);
	const sent = run(
		bin,
		["send", "--to", "a@b.com", "--text", "hi", "--dry-run", "--json"],
		project,
		{
			...env,
			SMTP_FROM: "from@example.com",
		},
	).trim();
	check(
		sent === JSON.stringify({ ok: true, externalId: "mock-1", transport: "mock" }),
		`--dry-run --json printed ${sent}`,
	);
	console.log("smoke: the bin runs from dist/ (--version, send --dry-run --json)");

	writeFileSync(join(project, "library.mjs"), LIBRARY);
	process.stdout.write(run(process.execPath, ["library.mjs"], project));
	console.log("smoke: OK");
} finally {
	rmSync(project, { recursive: true, force: true });
}
