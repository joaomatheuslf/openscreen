import { useEffect, useMemo, useRef, useState } from "react";
import { computeZoomTransform } from "../../lib/zoomMath/zoomTransform";
import styles from "./ConfidenceMonitorWindow.module.css";

type MonitorState = {
	recording: boolean;
	sourceName: string;
	startedAtMs: number | null;
};

type LiveCursorSample = {
	timeMs: number;
	cx: number;
	cy: number;
	visible?: boolean;
	interactionType?: string;
};

const PREVIEW_FPS = 15;
const ZOOM_SCALE = 1.5;
const ZOOM_HOLD_MS = 2200;

function formatElapsed(ms: number) {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopStream(stream: MediaStream | null) {
	stream?.getTracks().forEach((track) => track.stop());
}

export function ConfidenceMonitorWindow() {
	const screenVideoRef = useRef<HTMLVideoElement | null>(null);
	const cameraVideoRef = useRef<HTMLVideoElement | null>(null);
	const screenStreamRef = useRef<MediaStream | null>(null);
	const cameraStreamRef = useRef<MediaStream | null>(null);
	const zoomTimerRef = useRef<number | null>(null);
	const [state, setState] = useState<MonitorState>({ recording: false, sourceName: "Screen", startedAtMs: null });
	const [now, setNow] = useState(() => Date.now());
	const [screenStatus, setScreenStatus] = useState<"idle" | "connecting" | "live" | "error">("idle");
	const [cameraStatus, setCameraStatus] = useState<"off" | "connecting" | "live" | "busy">("off");
	const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
	const [cursor, setCursor] = useState<LiveCursorSample | null>(null);
	const [zoomFocus, setZoomFocus] = useState({ cx: 0.5, cy: 0.5 });
	const [zoomActive, setZoomActive] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void window.electronAPI.getConfidenceMonitorState().then((next) => {
			if (!cancelled) setState(next);
		});
		const offState = window.electronAPI.onConfidenceMonitorState(setState);
		const offCursor = window.electronAPI.onConfidenceMonitorCursor((sample) => {
			setCursor(sample);
			if (sample.visible !== false && ["click", "double-click", "right-click", "middle-click"].includes(sample.interactionType ?? "")) {
				setZoomFocus({ cx: Math.max(0, Math.min(1, sample.cx)), cy: Math.max(0, Math.min(1, sample.cy)) });
				setZoomActive(true);
				if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
				zoomTimerRef.current = window.setTimeout(() => {
					setZoomActive(false);
					zoomTimerRef.current = null;
				}, ZOOM_HOLD_MS);
			}
		});
		return () => {
			cancelled = true;
			offState();
			offCursor();
		};
	}, []);

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		let cancelled = false;
		void window.electronAPI.getRecordingPrefs().then((prefs) => {
			if (!cancelled) setMicrophoneEnabled(prefs.micEnabled);
		});
		const off = window.electronAPI.onRecordingPrefsChanged((prefs) => setMicrophoneEnabled(prefs.micEnabled));
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	useEffect(() => {
		if (!state.recording) {
			stopStream(screenStreamRef.current);
			screenStreamRef.current = null;
			if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
			setScreenStatus("idle");
			return;
		}
		let cancelled = false;
		setScreenStatus("connecting");
		void navigator.mediaDevices.getDisplayMedia({
			audio: false,
			video: {
				width: { max: 1280 },
				height: { max: 720 },
				frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS },
				cursor: "always",
			} as MediaTrackConstraints,
		}).then(async (stream) => {
			if (cancelled) {
				stopStream(stream);
				return;
			}
			screenStreamRef.current = stream;
			if (screenVideoRef.current) {
				screenVideoRef.current.srcObject = stream;
				await screenVideoRef.current.play().catch(() => undefined);
			}
			setScreenStatus("live");
		}).catch(() => {
			if (!cancelled) setScreenStatus("error");
		});
		return () => {
			cancelled = true;
			stopStream(screenStreamRef.current);
			screenStreamRef.current = null;
		};
	}, [state.recording]);

	useEffect(() => {
		if (!state.recording) {
			stopStream(cameraStreamRef.current);
			cameraStreamRef.current = null;
			if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
			setCameraStatus("off");
			return;
		}
		let cancelled = false;
		void window.electronAPI.getRecordingPrefs().then(async (prefs) => {
			if (cancelled || !prefs.camEnabled) {
				setCameraStatus("off");
				return;
			}
			setCameraStatus("connecting");
			try {
				const stream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: {
						...(prefs.camDeviceId ? { deviceId: { exact: prefs.camDeviceId } } : {}),
						width: { ideal: 640, max: 640 },
						height: { ideal: 360, max: 360 },
						frameRate: { ideal: PREVIEW_FPS, max: PREVIEW_FPS },
					},
				});
				if (cancelled) {
					stopStream(stream);
					return;
				}
				cameraStreamRef.current = stream;
				if (cameraVideoRef.current) {
					cameraVideoRef.current.srcObject = stream;
					await cameraVideoRef.current.play().catch(() => undefined);
				}
				setCameraStatus("live");
			} catch {
				if (!cancelled) setCameraStatus("busy");
			}
		});
		return () => {
			cancelled = true;
			stopStream(cameraStreamRef.current);
			cameraStreamRef.current = null;
		};
	}, [state.recording]);

	useEffect(() => () => {
		stopStream(screenStreamRef.current);
		stopStream(cameraStreamRef.current);
		if (zoomTimerRef.current !== null) window.clearTimeout(zoomTimerRef.current);
	}, []);

	const elapsed = state.startedAtMs ? now - state.startedAtMs : 0;
	const zoom = useMemo(() => computeZoomTransform({
		stageSize: { width: 1, height: 1 },
		baseMask: { x: 0, y: 0, width: 1, height: 1 },
		zoomScale: ZOOM_SCALE,
		zoomProgress: zoomActive ? 1 : 0,
		focusX: zoomFocus.cx,
		focusY: zoomFocus.cy,
	}), [zoomActive, zoomFocus]);

	return (
		<div className={styles.shell}>
			<header className={styles.header}>
				<div className={styles.recordingGroup}>
					<span className={state.recording ? styles.recordingDot : styles.idleDot} />
					<strong>{state.recording ? "REC" : "STANDBY"}</strong>
					<span className={styles.timer}>{formatElapsed(elapsed)}</span>
				</div>
				<div className={styles.source} title={state.sourceName}>{state.sourceName}</div>
				<div className={styles.badges}>
					<span data-active={screenStatus === "live"}>SCREEN</span>
					<span data-active={cameraStatus === "live"}>CAM</span>
					<span data-active={microphoneEnabled}>MIC</span>
					<span data-active={zoomActive}>ZOOM {zoomActive ? `${ZOOM_SCALE.toFixed(1)}×` : "AUTO"}</span>
				</div>
			</header>
			<main className={styles.stage}>
				<div className={styles.previewFrame}>
					<div className={styles.screenLayer} style={{
						transform: `translate(${zoom.x * 100}%, ${zoom.y * 100}%) scale(${zoom.scale})`,
						transformOrigin: "0 0",
					}}>
						<video ref={screenVideoRef} muted playsInline className={styles.screenVideo} />
					</div>
					{cursor?.visible !== false && cursor ? (
						<div className={styles.cursor} style={{ left: `${cursor.cx * 100}%`, top: `${cursor.cy * 100}%` }} />
					) : null}
					{screenStatus !== "live" ? (
						<div className={styles.statusOverlay}>
							<strong>{screenStatus === "connecting" ? "Conectando à tela…" : screenStatus === "error" ? "Prévia da tela indisponível" : "Aguardando gravação"}</strong>
							<span>A gravação principal continua independente deste monitor.</span>
						</div>
					) : null}
					{cameraStatus !== "off" ? (
						<div className={styles.cameraCard} data-live={cameraStatus === "live"}>
							{cameraStatus === "live" ? (
								<video ref={cameraVideoRef} muted playsInline className={styles.cameraVideo} />
							) : (
								<div className={styles.cameraFallback}>
									<strong>{cameraStatus === "connecting" ? "CAM…" : "CAM ocupada"}</strong>
									<span>{cameraStatus === "busy" ? "A câmera está sendo usada pelo gravador nativo." : "Prévia indisponível"}</span>
								</div>
							)}
						</div>
					) : null}
				</div>
			</main>
			<footer className={styles.footer}>
				<span>Monitor de retorno · protegido da captura</span>
				<span>Zoom ao vivo é uma aproximação baseada nos cliques; a edição final continua ajustável.</span>
			</footer>
		</div>
	);
}
