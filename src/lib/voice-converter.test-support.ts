// A small stereo PCM recording generated locally; no network or binary fixture.
export function voiceTestWav(seconds = 1): Buffer {
	const sampleRate = 44100;
	const frames = sampleRate * seconds;
	const dataSize = frames * 4;
	const wav = Buffer.alloc(44 + dataSize);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + dataSize, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(2, 22);
	wav.writeUInt32LE(sampleRate, 24);
	wav.writeUInt32LE(sampleRate * 4, 28);
	wav.writeUInt16LE(4, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(dataSize, 40);
	for (let frame = 0; frame < frames; frame++) {
		const sample = Math.round(
			10000 * Math.sin((2 * Math.PI * 440 * frame) / sampleRate),
		);
		wav.writeInt16LE(sample, 44 + frame * 4);
		wav.writeInt16LE(sample, 46 + frame * 4);
	}
	return wav;
}
