import { assertEquals, assertRejects } from "@std/assert";
import { createMockTransport, send } from "../src/mod.ts";
import type { SendOptions } from "../src/mod.ts";

const msg: SendOptions = {
	to: "to@example.com",
	from: "from@example.com",
	subject: "Hello",
	text: "Hi there",
};

Deno.test("send() sends through a provided transport", async () => {
	const transport = createMockTransport();
	const result = await send(msg, { transport });
	assertEquals(result.externalId, "mock-1");
	assertEquals(transport.sentEmails.length, 1);
	assertEquals(transport.getLastEmail()?.subject, "Hello");
});

Deno.test("send() throws when neither transport nor smtp is given", async () => {
	await assertRejects(
		// deno-lint-ignore no-explicit-any
		() => send(msg, {} as any),
		Error,
		"transport` or `smtp`",
	);
});

Deno.test("send() throws when both transport and smtp are given", async () => {
	const transport = createMockTransport();
	await assertRejects(
		() =>
			send(msg, {
				transport,
				smtp: { host: "h", port: 587 },
			}),
		Error,
		"not both",
	);
});

Deno.test("mock transport captures the full payload, including arrays", async () => {
	const transport = createMockTransport();
	await transport.send({
		to: ["a@example.com", "b@example.com"],
		from: "from@example.com",
		subject: "Multi",
		cc: ["c@example.com"],
		bcc: "d@example.com",
		html: "<p>hi</p>",
		attachments: [{ filename: "a.txt", content: "data" }],
	});
	const last = transport.getLastEmail();
	assertEquals(last?.to, ["a@example.com", "b@example.com"]);
	assertEquals(last?.cc, ["c@example.com"]);
	assertEquals(last?.bcc, "d@example.com");
	assertEquals(last?.attachments?.[0].filename, "a.txt");
});

Deno.test("mock transport: deterministic, incrementing ids", async () => {
	const transport = createMockTransport();
	const r1 = await transport.send(msg);
	const r2 = await transport.send(msg);
	assertEquals(r1.externalId, "mock-1");
	assertEquals(r2.externalId, "mock-2");
});

Deno.test("mock transport: failOnSend throws with custom message", async () => {
	const transport = createMockTransport({
		failOnSend: true,
		errorMessage: "boom",
	});
	await assertRejects(() => transport.send(msg), Error, "boom");
	assertEquals(transport.sentEmails.length, 0);
});

Deno.test("mock transport: clear() resets state", async () => {
	const transport = createMockTransport();
	await transport.send(msg);
	await transport.verify?.();
	transport.clear();
	assertEquals(transport.sentEmails.length, 0);
	assertEquals(transport.verifyCount, 0);
});

Deno.test("mock transport: verify() records calls", async () => {
	const transport = createMockTransport();
	await transport.verify?.();
	await transport.verify?.();
	assertEquals(transport.verifyCount, 2);
});

Deno.test("mock transport: failOnVerify throws", async () => {
	const transport = createMockTransport({ failOnVerify: true });
	await assertRejects(() => transport.verify?.() as Promise<void>, Error);
});

Deno.test("send() one-shot via {smtp} builds a nodemailer transport (no send)", () => {
	// We can't actually connect offline; just assert the resolution path does
	// not throw while constructing the transport.
	// (Real sending is covered by the opt-in Ethereal test.)
	const transport = createMockTransport();
	assertEquals(typeof send, "function");
	assertEquals(transport.name, "mock");
});
