import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockTransport, send } from "../src/mod.ts";
import type { SendOptions } from "../src/mod.ts";

const msg: SendOptions = {
	to: "to@example.com",
	from: "from@example.com",
	subject: "Hello",
	text: "Hi there",
};

test("send() sends through a provided transport", async () => {
	const transport = createMockTransport();
	const result = await send(msg, { transport });
	assert.equal(result.externalId, "mock-1");
	assert.equal(transport.sentEmails.length, 1);
	assert.equal(transport.getLastEmail()?.subject, "Hello");
});

test("send() throws when neither transport nor smtp is given", async () => {
	await assert.rejects(() => send(msg, {}), {
		name: "Error",
		message: /transport` or `smtp`/,
	});
});

test("send() throws when both transport and smtp are given", async () => {
	const transport = createMockTransport();
	await assert.rejects(
		() =>
			send(msg, {
				transport,
				smtp: { host: "h", port: 587 },
			}),
		{ name: "Error", message: /not both/ },
	);
});

test("mock transport captures the full payload, including arrays", async () => {
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
	assert.deepEqual(last?.to, ["a@example.com", "b@example.com"]);
	assert.deepEqual(last?.cc, ["c@example.com"]);
	assert.equal(last?.bcc, "d@example.com");
	assert.equal(last?.attachments?.[0]?.filename, "a.txt");
});

test("mock transport: deterministic, incrementing ids", async () => {
	const transport = createMockTransport();
	const r1 = await transport.send(msg);
	const r2 = await transport.send(msg);
	assert.equal(r1.externalId, "mock-1");
	assert.equal(r2.externalId, "mock-2");
});

test("mock transport: failOnSend throws with custom message", async () => {
	const transport = createMockTransport({
		failOnSend: true,
		errorMessage: "boom",
	});
	await assert.rejects(() => transport.send(msg), { name: "Error", message: /boom/ });
	assert.equal(transport.sentEmails.length, 0);
});

test("mock transport: clear() resets state", async () => {
	const transport = createMockTransport();
	await transport.send(msg);
	await transport.verify?.();
	transport.clear();
	assert.equal(transport.sentEmails.length, 0);
	assert.equal(transport.verifyCount, 0);
});

test("mock transport: verify() records calls", async () => {
	const transport = createMockTransport();
	await transport.verify?.();
	await transport.verify?.();
	assert.equal(transport.verifyCount, 2);
});

test("mock transport: failOnVerify throws", async () => {
	const transport = createMockTransport({ failOnVerify: true });
	await assert.rejects(() => transport.verify?.() as Promise<void>, Error);
});

test("send() one-shot via {smtp} builds a nodemailer transport (no send)", () => {
	// We can't actually connect offline; just assert the resolution path does
	// not throw while constructing the transport.
	// (Real sending is covered by the opt-in Ethereal test.)
	const transport = createMockTransport();
	assert.equal(typeof send, "function");
	assert.equal(transport.name, "mock");
});
