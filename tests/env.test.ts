import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSmtpOptions, SmtpEnvError } from "../src/env.ts";

const envFrom = (rec: Record<string, string>) => (k: string) => rec[k];

test("resolveSmtpOptions: minimal — host only, port defaults to 587", () => {
	assert.deepEqual(resolveSmtpOptions(envFrom({ SMTP_HOST: "smtp.x" })), {
		host: "smtp.x",
		port: 587,
	});
});

test("resolveSmtpOptions: missing SMTP_HOST → SmtpEnvError", () => {
	assert.throws(
		() => resolveSmtpOptions(envFrom({})),
		(e) =>
			e instanceof SmtpEnvError &&
			e.name === "SmtpEnvError" &&
			e.message.includes("SMTP_HOST"),
	);
});

test("resolveSmtpOptions: full mapping", () => {
	const options = resolveSmtpOptions(envFrom({
		SMTP_HOST: "smtp.x",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "u",
		SMTP_PASS: "p",
		SMTP_REPLY_TO: "r@x.com",
		SMTP_SERVERNAME: " cert.host ",
		SMTP_TLS_REJECT_UNAUTHORIZED: "false",
		SMTP_CONNECTION_TIMEOUT_MS: "1000",
		SMTP_SOCKET_TIMEOUT_MS: "2000",
	}));
	assert.deepEqual(options, {
		host: "smtp.x",
		port: 465,
		secure: true,
		auth: { user: "u", pass: "p" },
		defaultReplyTo: "r@x.com",
		tls: { servername: "cert.host", rejectUnauthorized: false },
		connectionTimeout: 1000,
		socketTimeout: 2000,
	});
});

test("resolveSmtpOptions: auth is set when only one of user/pass is present", () => {
	assert.deepEqual(
		resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_USER: "u" })).auth,
		{ user: "u", pass: "" },
	);
});

test("resolveSmtpOptions: blank optional values are treated as unset", () => {
	const options = resolveSmtpOptions(envFrom({
		SMTP_HOST: "h",
		SMTP_PORT: "",
		SMTP_SECURE: " ",
		SMTP_SERVERNAME: "",
		SMTP_REPLY_TO: "",
	}));
	assert.deepEqual(options, { host: "h", port: 587 });
});

test("resolveSmtpOptions: SMTP_FROM is not consumed", () => {
	const asked: string[] = [];
	resolveSmtpOptions((k) => {
		asked.push(k);
		return k === "SMTP_HOST" ? "h" : undefined;
	});
	assert.equal(asked.includes("SMTP_FROM"), false);
});

test("resolveSmtpOptions: invalid boolean → SmtpEnvError naming the key", () => {
	assert.throws(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_SECURE: "maybe" })),
		{ name: "SmtpEnvError", message: /SMTP_SECURE.*invalid boolean value/ },
	);
});

test("resolveSmtpOptions: non-decimal / out-of-range port → SmtpEnvError", () => {
	assert.throws(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "0x1bb" })),
		{ name: "SmtpEnvError", message: /SMTP_PORT/ },
	);
	assert.throws(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "70000" })),
		{ name: "SmtpEnvError", message: /between 1 and 65535/ },
	);
	assert.throws(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "-1" })),
		SmtpEnvError,
	);
});

test("resolveSmtpOptions: timeouts must be non-negative integers", () => {
	assert.throws(
		() =>
			resolveSmtpOptions(
				envFrom({ SMTP_HOST: "h", SMTP_CONNECTION_TIMEOUT_MS: "1e3" }),
			),
		{ name: "SmtpEnvError", message: /SMTP_CONNECTION_TIMEOUT_MS/ },
	);
});
