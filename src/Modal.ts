import { App, MarkdownView, Modal, Notice } from "obsidian";
import { CameraPluginSettings } from "./SettingsTab";

class CameraModal extends Modal {
	chosenFolderPath: string;
	videoStream: MediaStream = null;
	private _stopPreview: (() => void) | null = null;
	constructor(app: App, cameraSettings: CameraPluginSettings) {
		super(app);
		this.chosenFolderPath = cameraSettings.chosenFolderPath;
	}

	async onOpen() {
		const { contentEl } = this;

		// Show a loading message immediately (synchronous, before any awaits)
		const loadingMsg = contentEl.createEl("p", { text: "Loading camera…" });
		loadingMsg.style.padding = "20px";

		// ── Phase 1: all async work ──────────────────────────────────────────
		// getUserMedia must precede enumerateDevices so macOS grants permission
		// and real deviceIds are returned.

		if (!navigator.mediaDevices?.getUserMedia) {
			loadingMsg.textContent = "Error: mediaDevices API unavailable.";
			new Notice("Camera error: mediaDevices API unavailable.", 10000);
			return;
		}

		try {
			this.videoStream = await navigator.mediaDevices.getUserMedia({
				video: true,
				audio: true,
			});
		} catch (error) {
			const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
			loadingMsg.textContent = `Camera error: ${msg}`;
			new Notice(`Camera error: ${msg}`, 10000);
			return;
		}

		const cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
			(d) => d.kind === "videoinput",
		);

		// Yield past Obsidian's post-open cleanup (which empties contentEl).
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		loadingMsg.remove();

		const cameraLabel = contentEl.createEl("p", { text: cameras[0]?.label ?? "Camera" });
		cameraLabel.style.cssText = "margin:0 0 6px;font-size:0.85em;opacity:0.7;";

		const webCamContainer = contentEl.createDiv();

		const previewCanvas = document.createElement("canvas");
		previewCanvas.style.width = "100%";
		previewCanvas.style.display = "block";
		webCamContainer.appendChild(previewCanvas);

		const buttonsDiv = webCamContainer.createDiv();
		const firstRow = buttonsDiv.createDiv();
		const secondRow = buttonsDiv.createDiv();

		const recordVideoButton = firstRow.createEl("button", { text: "Start recording" });
		const switchCameraButton = firstRow.createEl("button", { text: "Switch Camera" });
		const snapPhotoButton = firstRow.createEl("button", { text: "Take a snap" });

		if (cameras.length <= 1) switchCameraButton.style.display = "none";
		let cameraIndex = 0;

		const filePicker = secondRow.createEl("input", {
			placeholder: "Choose image file from system",
			type: "file",
		});
		filePicker.id = "filepicker";
		filePicker.accept = "image/*,video/*";
		filePicker.capture = "camera";
		filePicker.style.display = "none";

		const label = secondRow.createEl("label");
		label.style.cursor = "pointer";
		label.style.display = "inline-block";
		label.style.margin = "5px 0px";
		label.style.padding = "5px";
		label.style.border = "0.5px solid #555";
		label.htmlFor = "filepicker";
		label.innerHTML = "&#8679; Upload";
		label.appendChild(filePicker);
		secondRow.appendChild(label);

		const startPreview = (stream: MediaStream) => {
			this._stopPreview?.();

			const video = document.createElement("video");
			video.setAttribute("autoplay", "");
			video.setAttribute("muted", "");
			video.setAttribute("playsinline", "");
			video.style.cssText = "width:100%;display:block;";
			webCamContainer.insertBefore(video, previewCanvas);
			previewCanvas.style.display = "none"; // only used for snap capture

			video.srcObject = stream;
			video.play().catch(() => { /* autoplay policy — resolved once frames arrive */ });

			// Keep canvas current so snapPhotoButton can toBlob() from it.
			let previewActive = true;
			let rafId: number | null = null;
			const ctx = previewCanvas.getContext("2d")!;
			const loop = () => {
				if (!previewActive) return;
				if (video.readyState >= 2 && video.videoWidth > 0) {
					if (previewCanvas.width !== video.videoWidth) previewCanvas.width = video.videoWidth;
					if (previewCanvas.height !== video.videoHeight) previewCanvas.height = video.videoHeight;
					ctx.drawImage(video, 0, 0);
				}
				rafId = requestAnimationFrame(loop);
			};
			loop();

			this._stopPreview = () => {
				previewActive = false;
				if (rafId !== null) cancelAnimationFrame(rafId);
				video.pause();
				video.srcObject = null;
				video.remove();
				previewCanvas.style.display = "block";
			};
		};

		startPreview(this.videoStream);

		const chunks: BlobPart[] = [];
		let recorder: MediaRecorder = null;

		const getVideoStream = async () => {
			try {
				return await navigator.mediaDevices.getUserMedia({
					video: cameras[cameraIndex]?.deviceId
						? { deviceId: cameras[cameraIndex].deviceId }
						: true,
					audio: true,
				});
			} catch {
				return null;
			}
		};

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);

		const saveFile = async (
			file: ArrayBuffer,
			isImage = false,
			fileName = "",
		) => {
			if (!fileName) {
				const dateString = (new Date() + "")
					.slice(4, 28)
					.split(" ")
					.join("_")
					.split(":")
					.join("-");
				fileName = isImage
					? `image_${dateString}.png`
					: `video_${dateString}.webm`;
			}
			new Notice(`Adding new ${isImage ? "Image" : "Video"} to vault...`);

			const filePath = this.chosenFolderPath + "/" + fileName;
			const folderExists = app.vault.getAbstractFileByPath(this.chosenFolderPath);
			if (!folderExists) await app.vault.createFolder(this.chosenFolderPath);
			const fileExists = app.vault.getAbstractFileByPath(filePath);
			if (!fileExists) await app.vault.createBinary(filePath, file);

			if (!view) return new Notice(`Saved to ${filePath}`);

			const cursor = view.editor.getCursor();
			view.editor.replaceRange(
				isImage
					? `![${fileName}](${filePath})\n`
					: `\n![[${filePath}]]\n`,
				cursor,
			);
			this.close();
		};

		filePicker.onchange = () => {
			if (!filePicker.files?.length) return;
			const selectedFile = filePicker.files[0];
			label.textContent = `Selected: ${selectedFile.name}`;
			const isImage = selectedFile.type.startsWith("image/");
			selectedFile.arrayBuffer().then((buf) =>
				saveFile(buf, isImage, selectedFile.name.split(" ").join("-")),
			);
		};

		switchCameraButton.onclick = async () => {
			cameraIndex = (cameraIndex + 1) % cameras.length;
			const newStream = await getVideoStream();
			if (newStream) {
				this.videoStream.getTracks().forEach(t => t.stop());
				this.videoStream = newStream;
				cameraLabel.textContent = cameras[cameraIndex]?.label ?? "Camera";
				startPreview(newStream);
			}
		};

		snapPhotoButton.onclick = () => {
			previewCanvas.toBlob(async (blob) => {
				if (!blob) return;
				const bufferFile = await blob.arrayBuffer();
				saveFile(bufferFile, true);
			}, "image/png");
		};

		recordVideoButton.onclick = async () => {
			switchCameraButton.disabled = true;
			if (!recorder) {
				recorder = new MediaRecorder(this.videoStream, { mimeType: "video/webm" });
			}

			let isRecording = recorder && recorder.state === "recording";
			if (isRecording) {
				recorder.stop();
			} else {
				recorder.start();
			}
			isRecording = !isRecording;
			recordVideoButton.innerText = isRecording ? "Stop Recording" : "Start Recording";

			recorder.ondataavailable = (e) => chunks.push(e.data);
			recorder.onstop = async (_) => {
				const blob = new Blob(chunks, { type: "audio/ogg; codecs=opus" });
				const bufferFile = await blob.arrayBuffer();
				saveFile(bufferFile, false);
			};
		};
	}

	onClose() {
		const { contentEl } = this;
		this._stopPreview?.();
		this._stopPreview = null;
		this.videoStream?.getTracks().forEach((track) => {
			track.stop();
		});
		contentEl.empty();
	}
}

export default CameraModal;
