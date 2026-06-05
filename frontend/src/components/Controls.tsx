import { VOICES } from "../voices";

interface Props {
  isPlaying: boolean;
  loading: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  currentChunk: number;
  numChunks: number;
  voice: string;
  onToggle: () => void;
  onSkip: (delta: number) => void;
  onSeek: (time: number) => void;
  onRate: (rate: number) => void;
  onChunk: (index: number) => void;
  onVoice: (voice: string) => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function Controls(props: Props) {
  const {
    isPlaying,
    loading,
    currentTime,
    duration,
    rate,
    currentChunk,
    numChunks,
    voice,
    onToggle,
    onSkip,
    onSeek,
    onRate,
    onChunk,
    onVoice,
  } = props;

  return (
    <div className="controls">
      <div className="controls__progress">
        <span className="controls__time">{fmt(currentTime)}</span>
        <input
          className="controls__bar"
          type="range"
          min={0}
          max={duration || 0}
          step={0.01}
          value={Math.min(currentTime, duration || 0)}
          onChange={(e) => onSeek(parseFloat(e.target.value))}
          aria-label="Seek"
        />
        <span className="controls__time">{fmt(duration)}</span>
      </div>

      <div className="controls__row">
        <button
          className="btn"
          onClick={() => onChunk(currentChunk - 1)}
          disabled={currentChunk <= 0}
          title="Previous section"
        >
          |&lt;
        </button>
        <button className="btn" onClick={() => onSkip(-10)} title="Back 10s">
          &laquo; 10
        </button>
        <button className="btn btn--primary" onClick={onToggle} title="Play / Pause">
          {loading ? "..." : isPlaying ? "Pause" : "Play"}
        </button>
        <button className="btn" onClick={() => onSkip(10)} title="Forward 10s">
          10 &raquo;
        </button>
        <button
          className="btn"
          onClick={() => onChunk(currentChunk + 1)}
          disabled={currentChunk >= numChunks - 1}
          title="Next section"
        >
          &gt;|
        </button>

        <div className="controls__rate">
          <span>Speed</span>
          <select value={rate} onChange={(e) => onRate(parseFloat(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}x
              </option>
            ))}
          </select>
        </div>

        <div className="controls__rate">
          <span>Voice</span>
          <select value={voice} onChange={(e) => onVoice(e.target.value)}>
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="controls__counter">
          Section {currentChunk + 1} / {numChunks}
        </div>
      </div>
    </div>
  );
}
