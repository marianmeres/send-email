import { npmBuild, versionizeDeps } from "@marianmeres/npmbuild";

const denoJson = JSON.parse(Deno.readTextFileSync("deno.json"));

await npmBuild({
	name: denoJson.name,
	version: denoJson.version,
	repository: denoJson.name.replace(/^@/, ""),
	// The CLI (cli.ts) and the CLI entry guard (main.ts) are Deno-only — they
	// use @std/* and Deno globals and cannot compile under tsc. The npm artifact
	// is the LIBRARY only (mod.ts is its "." entry); the bundled CLI stays a
	// Deno/JSR feature.
	sourceFiles: [
		"mod.ts",
		"types.ts",
		"transport-nodemailer.ts",
		"transport-mock.ts",
		"send-email.ts",
	],
	dependencies: versionizeDeps(["nodemailer"], denoJson),
});
