import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { voiceTestWav } from "./voice-converter.test-support.js";

// Generate tagged music with an embedded cover locally, without network fixtures.
export async function taggedMusic() {
	const directory = await mkdtemp(join(tmpdir(), "reducto-test-music-"));
	try {
		const audio = join(directory, "audio.wav");
		const cover = join(directory, "cover.png");
		const output = join(directory, "music.mp3");
		await writeFile(audio, voiceTestWav());
		await sharp({
			create: { width: 800, height: 400, channels: 3, background: "red" },
		})
			.png()
			.toFile(cover);
		await promisify(execFile)(
			"ffmpeg",
			[
				"-nostdin",
				"-v",
				"error",
				"-i",
				audio,
				"-i",
				cover,
				"-map",
				"0:a",
				"-map",
				"1:v",
				"-c:a",
				"libmp3lame",
				"-c:v",
				"copy",
				"-disposition:v",
				"attached_pic",
				"-id3v2_version",
				"3",
				"-metadata",
				"title=آهنگ Test",
				"-metadata",
				"artist=Test Artist",
				output,
			],
			{ timeout: 30_000 },
		);
		return await readFile(output);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
