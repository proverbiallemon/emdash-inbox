import { describe, it, expect } from "vitest";
import { deriveParticipantChips } from "./participantChips";

const SENDER = "PocketBear@harildkyler.com";

describe("deriveParticipantChips", () => {
	it("single inbound from alice → 1 chip", () => {
		const chips = deriveParticipantChips(
			[{ direction: "inbound", from: "alice@example.com", to: SENDER } as any],
			SENDER,
		);
		expect(chips).toEqual([{ label: "alice", initial: "A", isYou: false }]);
	});

	it("inbound + outbound → 2 chips, alice + sender local-part", () => {
		const chips = deriveParticipantChips(
			[
				{ direction: "inbound", from: "alice@example.com", to: SENDER } as any,
				{ direction: "outbound", from: SENDER, to: "alice@example.com" } as any,
			],
			SENDER,
		);
		expect(chips).toEqual([
			{ label: "alice", initial: "A", isYou: false },
			{ label: "pocketbear", initial: "P", isYou: true },
		]);
	});

	it("3 messages all from alice → 1 chip (dedupe)", () => {
		const chips = deriveParticipantChips(
			[
				{ direction: "inbound", from: "alice@example.com", to: SENDER } as any,
				{ direction: "inbound", from: "alice@example.com", to: SENDER } as any,
				{ direction: "inbound", from: "Alice@Example.com", to: SENDER } as any,
			],
			SENDER,
		);
		expect(chips).toHaveLength(1);
		expect(chips[0].label).toBe("alice");
	});

	it("alice → outbound → bob → outbound → 3 chips in first-seen order", () => {
		const chips = deriveParticipantChips(
			[
				{ direction: "inbound", from: "alice@example.com", to: SENDER } as any,
				{ direction: "outbound", from: SENDER, to: "alice@example.com" } as any,
				{ direction: "inbound", from: "bob@example.com", to: SENDER } as any,
				{ direction: "outbound", from: SENDER, to: "bob@example.com" } as any,
			],
			SENDER,
		);
		expect(chips.map((c) => c.label)).toEqual(["alice", "pocketbear", "bob"]);
	});

	it("empty messages array → empty chip list", () => {
		expect(deriveParticipantChips([], SENDER)).toEqual([]);
	});

	it("falls back to 'you'/'Y' when senderAddress is empty (settings unconfigured)", () => {
		const chips = deriveParticipantChips(
			[{ direction: "outbound", from: "", to: "alice@example.com" } as any],
			"",
		);
		expect(chips).toEqual([{ label: "you", initial: "Y", isYou: true }]);
	});
});
