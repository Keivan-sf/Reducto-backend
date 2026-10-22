import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FfmpegVoiceConverter } from "./voice-converter.js";
import { voiceTestWav } from "./voice-converter.test-support.js";

const executeFile = promisify(execFile);

test.each([
	{ format: "ogg", codec: "libvorbis" },
	{ format: "mp3", codec: "libmp3lame" },
	{ format: "mp4", codec: "aac" },
	{ format: "webm", codec: "libopus" },
	{ format: "wav", codec: "pcm_s16le" },
	{ format: "flac", codec: "flac" },
])(
	"$format voice recordings become low-bitrate mono Ogg Opus",
	async ({ format, codec }) => {
		const directory = await mkdtemp(join(tmpdir(), "reducto-voice-test-"));
		try {
			const wav = join(directory, "source.wav");
			const input = join(directory, `input.${format}`);
			const output = join(directory, "voice.ogg");
			await writeFile(wav, voiceTestWav(3));
			await executeFile("ffmpeg", [
				"-v",
				"error",
				"-i",
				wav,
				"-c:a",
				codec,
				input,
			]);
			const converted = await new FfmpegVoiceConverter().convertToOgg(
				await readFile(input),
			);
			await writeFile(output, converted);
			const { stdout } = await executeFile("ffprobe", [
				"-v",
				"error",
				"-show_streams",
				"-show_format",
				"-of",
				"json",
				output,
			]);
			const metadata = JSON.parse(stdout);
			expect(converted.toString("ascii", 0, 4)).toBe("OggS");
			expect(metadata.format.format_name).toBe("ogg");
			expect(metadata.streams).toHaveLength(1);
			expect(metadata.streams[0]).toMatchObject({
				codec_name: "opus",
				codec_type: "audio",
				channels: 1,
				sample_rate: "48000",
			});
			expect(Number(metadata.format.duration)).toBeCloseTo(3, 1);
			const bitrate = (converted.length * 8) / Number(metadata.format.duration);
			expect(bitrate).toBeGreaterThan(15000);
			expect(bitrate).toBeLessThan(45000);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("invalid or empty audio is rejected", async () => {
	const converter = new FfmpegVoiceConverter();
	for (const input of [
		Buffer.from("not audio"),
		Buffer.alloc(0),
		voiceTestWav(0),
	])
		await expect(converter.convertToOgg(input)).rejects.toMatchObject({
			status: 400,
		});
});
