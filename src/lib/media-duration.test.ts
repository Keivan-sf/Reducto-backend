import { expect, test } from "@jest/globals";
import { voiceTestWav } from "./voice-converter.test-support.js";
import { FfprobeDurationReader } from "./media-duration.js";

test("reads media duration in seconds and rejects invalid media", async () => {
	const reader = new FfprobeDurationReader();
	await expect(reader.read(voiceTestWav(2))).resolves.toBeCloseTo(2, 1);
	await expect(reader.read(Buffer.from("invalid"))).rejects.toMatchObject({
		status: 400,
	});
});
