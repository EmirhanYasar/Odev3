import React, { useRef, useState, useEffect } from "react";
import Meyda from "meyda";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  LineElement,
  CategoryScale,
  LinearScale,
  PointElement,
  Legend,
  Tooltip,
} from "chart.js";

ChartJS.register(LineElement, CategoryScale, LinearScale, PointElement, Legend, Tooltip);

export default function SpeechAnalyzer() {
  const [recording, setRecording] = useState(false);
  const [energy, setEnergy] = useState([]);
  const [zcr, setZcr] = useState([]);
  const [voiced, setVoiced] = useState([]);
  const [vadUrl, setVadUrl] = useState(null);
  const [originalUrl, setOriginalUrl] = useState(null);
  const [letterAnalysis, setLetterAnalysis] = useState([]);
  const [summaryAnalysis, setSummaryAnalysis] = useState([]);

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const audioBufferRef = useRef(null);
  const vadMaskRef = useRef([]);
  const noiseRMSRef = useRef(0);

  const frameSize = 1024;
  const hopSize = frameSize / 2;

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    sourceRef.current = source;

    chunksRef.current = [];
    const mediaRecorder = new MediaRecorder(stream);
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: "audio/wav" });
      setOriginalUrl(URL.createObjectURL(blob));

      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer);
      audioBufferRef.current = decoded;
    };

    mediaRecorder.start();

    vadMaskRef.current = [];
    const rmsBuffer = [];

    analyserRef.current = Meyda.createMeydaAnalyzer({
      audioContext,
      source,
      bufferSize: frameSize,
      featureExtractors: ["rms", "zcr"],
      callback: (features) => {
        let e = features.rms;
        let z = features.zcr;

        if (rmsBuffer.length < 80) {
          rmsBuffer.push(e);
          noiseRMSRef.current =
            rmsBuffer.reduce((a, b) => a + b, 0) / rmsBuffer.length;
        }

        // ✅ Daha hassas eşik, kısık sesler için
        const dynamicThreshold = Math.max(noiseRMSRef.current * 1.2, 0.0001);

        let speech = e > dynamicThreshold;
        // ✅ Hangover süresi artırıldı
        const lastVoiced = voiced.slice(-6);
        if (!speech && lastVoiced.some((v) => v === 1)) speech = true;

        let v = -1;
        if (speech) {
          if (z < 0.1 && e > dynamicThreshold * 1.2) v = 1; // Voiced
          else v = 0; // Unvoiced
        }

        vadMaskRef.current.push(v);
        setEnergy((prev) => [...prev.slice(-200), e]);
        setZcr((prev) => [...prev.slice(-200), z]);
        setVoiced((prev) => [...prev.slice(-200), v]);
      },
    });

    analyserRef.current.start();
    setRecording(true);
    setVadUrl(null);
    setEnergy([]);
    setZcr([]);
    setVoiced([]);
    setLetterAnalysis([]);
    setSummaryAnalysis([]);
  };

  const stopRecording = async () => {
    if (analyserRef.current) analyserRef.current.stop();
    if (audioContextRef.current) await audioContextRef.current.close();
    if (mediaRecorderRef.current) mediaRecorderRef.current.stop();
    setRecording(false);

    setTimeout(() => createVadWav(), 500);
  };

  const createVadWav = () => {
    if (!audioBufferRef.current) return;

    const mask = vadMaskRef.current;
    const bufferData = audioBufferRef.current.getChannelData(0);
    const sampleRate = audioBufferRef.current.sampleRate;
    const hop = hopSize;

    let selectedSamples = [];
    let analysisData = [];

    const medianFilter = (arr, k = 3) => {
      return arr.map((val, i) => {
        const slice = arr.slice(
          Math.max(0, i - Math.floor(k / 2)),
          i + Math.ceil(k / 2)
        );
        return slice.sort()[Math.floor(slice.length / 2)];
      });
    };
    const filteredMask = medianFilter(mask, 3);

    for (let i = 0; i < filteredMask.length; i++) {
      if (filteredMask[i] === 1) {
        const start = i * hop;
        const end = Math.min(start + frameSize, bufferData.length);
        for (let j = start; j < end; j++) selectedSamples.push(bufferData[j]);

        let frameData = bufferData.slice(start, end);

        // ✅ Normalize edilerek kısık sesleri de al
        const maxVal = Math.max(...frameData.map((v) => Math.abs(v))) || 1;
        frameData = frameData.map((v) => v / maxVal);

        const N = frameData.length;
        const hamming = Array.from(
          { length: N },
          (_, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1))
        );
        const windowed = frameData.map((v, i) => v * hamming[i]);

        const rms = Math.sqrt(windowed.reduce((a, b) => a + b * b, 0) / windowed.length);
        const zeroCrossings = windowed.reduce((acc, val, idx) => {
          if (idx > 0 && (val >= 0) !== (windowed[idx - 1] >= 0)) acc++;
          return acc;
        }, 0);
        const zcrVal = zeroCrossings / windowed.length;

        analysisData.push({ rms, zcr: zcrVal });
      }
    }

    if (!selectedSamples.length) return alert("Konuşma tespit edilemedi!");
    setLetterAnalysis(analysisData);

    // Harf Bazlı Ortalama Hesaplama
    const harfler = ["S", "Ş", "F", "A", "O", "U"];
    const framesPerHarf = Math.floor(analysisData.length / harfler.length);
    const summary = harfler.map((harf, idx) => {
      const start = idx * framesPerHarf;
      const end = start + framesPerHarf;
      const frames = analysisData.slice(start, end);
      const avgRMS = (frames.reduce((sum, f) => sum + f.rms, 0) / frames.length).toFixed(4);
      const avgZCR = (frames.reduce((sum, f) => sum + f.zcr, 0) / frames.length).toFixed(4);
      return { letter: harf, avgRMS, avgZCR };
    });
    setSummaryAnalysis(summary);

    // WAV Oluşturma
    const wavBuffer = new ArrayBuffer(44 + selectedSamples.length * 2);
    const view = new DataView(wavBuffer);
    const writeString = (view, offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + selectedSamples.length * 2, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, selectedSamples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < selectedSamples.length; i++) {
      let s = Math.max(-1, Math.min(1, selectedSamples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    const blob = new Blob([view], { type: "audio/wav" });
    setVadUrl(URL.createObjectURL(blob));
  };

  useEffect(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const width = canvas.width;
    const height = canvas.height;
    const step = width / (voiced.length || 1);
    voiced.forEach((val, i) => {
      if (val === 1) ctx.fillStyle = "lime";
      else if (val === 0) ctx.fillStyle = "yellow";
      else ctx.fillStyle = "gray";
      ctx.fillRect(i * step, height / 4, step, height / 2);
    });
  }, [voiced]);

  return (
    <div
      style={{
        background: "#0f172a",
        color: "white",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: 40,
      }}
    >
      <h1 style={{ textAlign: "center" }}>Speech Signal Analyzer</h1>

      <div style={{ marginTop: 20 }}>
        <button onClick={startRecording} disabled={recording}>
          Start Recording
        </button>
        <button onClick={stopRecording} disabled={!recording} style={{ marginLeft: 10 }}>
          Stop Recording
        </button>
      </div>

      <canvas width={800} height={120} style={{ border: "1px solid #334", marginTop: 20 }} />

      <p style={{ textAlign: "center" }}>Green = Voiced | Yellow = Unvoiced | Gray = Silence</p>

      <div style={{ marginTop: 20, width: "80%" }}>
        <h3>Energy</h3>
        <Line
          data={{
            labels: energy.map((_, i) => i),
            datasets: [{ label: "Energy (RMS)", data: energy, borderColor: "yellow" }],
          }}
        />
      </div>

      <div style={{ marginTop: 20, width: "80%" }}>
        <h3>ZCR</h3>
        <Line
          data={{
            labels: zcr.map((_, i) => i),
            datasets: [{ label: "ZCR", data: zcr, borderColor: "yellow" }],
          }}
        />
      </div>

      {originalUrl && (
        <div style={{ marginTop: 20 }}>
          <h3>Original Audio</h3>
          <audio controls src={originalUrl} />
        </div>
      )}

      {vadUrl && (
        <div style={{ marginTop: 20 }}>
          <h3>Speech Only (VAD Output)</h3>
          <audio controls src={vadUrl} />
        </div>
      )}

      {summaryAnalysis.length > 0 && (
        <div style={{ marginTop: 20, width: "50%" }}>
          <h3>Harf Bazlı Ortalama RMS ve ZCR</h3>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={{ border: "1px solid white", padding: 5 }}>Harf</th>
                <th style={{ border: "1px solid white", padding: 5 }}>Ortalama RMS</th>
                <th style={{ border: "1px solid white", padding: 5 }}>Ortalama ZCR</th>
              </tr>
            </thead>
            <tbody>
              {summaryAnalysis.map((item, i) => (
                <tr key={i}>
                  <td style={{ border: "1px solid white", padding: 5 }}>{item.letter}</td>
                  <td style={{ border: "1px solid white", padding: 5 }}>{item.avgRMS}</td>
                  <td style={{ border: "1px solid white", padding: 5 }}>{item.avgZCR}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}