import { assertEquals, assertThrows } from "@std/assert";
import { resolveSmtpOptions, SmtpEnvError } from "../src/env.ts";

const envFrom = (rec: Record<string, string>) => (k: string) => rec[k];

Deno.test("resolveSmtpOptions: minimal — host only, port defaults to 587", () => {
	assertEquals(resolveSmtpOptions(envFrom({ SMTP_HOST: "smtp.x" })), {
		host: "smtp.x",
		port: 587,
	});
});

Deno.test("resolveSmtpOptions: missing SMTP_HOST → SmtpEnvError", () => {
	const e = assertThrows(() => resolveSmtpOptions(envFrom({})), SmtpEnvError);
	assertEquals(e.name, "SmtpEnvError");
	assertEquals(e.message.includes("SMTP_HOST"), true);
});

Deno.test("resolveSmtpOptions: full mapping", () => {
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
	assertEquals(options, {
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

Deno.test("resolveSmtpOptions: auth is set when only one of user/pass is present", () => {
	assertEquals(
		resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_USER: "u" })).auth,
		{ user: "u", pass: "" },
	);
});

Deno.test("resolveSmtpOptions: blank optional values are treated as unset", () => {
	const options = resolveSmtpOptions(envFrom({
		SMTP_HOST: "h",
		SMTP_PORT: "",
		SMTP_SECURE: " ",
		SMTP_SERVERNAME: "",
		SMTP_REPLY_TO: "",
	}));
	assertEquals(options, { host: "h", port: 587 });
});

Deno.test("resolveSmtpOptions: SMTP_FROM is not consumed", () => {
	const asked: string[] = [];
	resolveSmtpOptions((k) => {
		asked.push(k);
		return k === "SMTP_HOST" ? "h" : undefined;
	});
	assertEquals(asked.includes("SMTP_FROM"), false);
});

Deno.test("resolveSmtpOptions: invalid boolean → SmtpEnvError naming the key", () => {
	const e = assertThrows(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_SECURE: "maybe" })),
		SmtpEnvError,
	);
	assertEquals(e.message.includes("SMTP_SECURE"), true);
	assertEquals(e.message.includes("invalid boolean value"), true);
});

Deno.test("resolveSmtpOptions: non-decimal / out-of-range port → SmtpEnvError", () => {
	assertThrows(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "0x1bb" })),
		SmtpEnvError,
		"SMTP_PORT",
	);
	assertThrows(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "70000" })),
		SmtpEnvError,
		"between 1 and 65535",
	);
	assertThrows(
		() => resolveSmtpOptions(envFrom({ SMTP_HOST: "h", SMTP_PORT: "-1" })),
		SmtpEnvError,
	);
});

Deno.test("resolveSmtpOptions: timeouts must be non-negative integers", () => {
	assertThrows(
		() =>
			resolveSmtpOptions(
				envFrom({ SMTP_HOST: "h", SMTP_CONNECTION_TIMEOUT_MS: "1e3" }),
			),
		SmtpEnvError,
		"SMTP_CONNECTION_TIMEOUT_MS",
	);
});
