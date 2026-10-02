export const RECORDING_OUTPUT_ASPECT_RATIOS = ["16:9", "9:16"] as const;

export type RecordingOutputAspectRatio = (typeof RECORDING_OUTPUT_ASPECT_RATIOS)[number];

export const DEFAULT_RECORDING_OUTPUT_ASPECT_RATIO: RecordingOutputAspectRatio = "16:9";

export function recordingOutputAspectRatioFrom(
	value: unknown,
): RecordingOutputAspectRatio {
	return RECORDING_OUTPUT_ASPECT_RATIOS.includes(value as RecordingOutputAspectRatio)
		? (value as RecordingOutputAspectRatio)
		: DEFAULT_RECORDING_OUTPUT_ASPECT_RATIO;
}

export function recordingOutputAspectCss(value: RecordingOutputAspectRatio): string {
	return value === "9:16" ? "9 / 16" : "16 / 9";
}
