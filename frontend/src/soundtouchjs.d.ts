declare module "soundtouchjs" {
  export interface PitchShifterPlayDetail {
    timePlayed: number;
    formattedTimePlayed: string;
    percentagePlayed: number;
  }

  /** Plays an AudioBuffer through a node that supports pitch-preserving tempo
   * changes (time-stretching). See https://github.com/cutterbl/SoundTouchJS */
  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize?: number);
    /** Playback speed with pitch preserved (1 = normal). */
    tempo: number;
    /** Pitch multiplier (1 = unchanged). */
    pitch: number;
    /** Playback rate (changes speed *and* pitch, like playbackRate). */
    rate: number;
    /** Read: percent (0-100). Write: fraction (0-1) to seek. */
    percentagePlayed: number;
    /** Current source position in seconds. */
    timePlayed: number;
    readonly duration: number;
    readonly node: AudioNode;
    connect(toNode: AudioNode): void;
    disconnect(): void;
    on(event: "play", cb: (detail: PitchShifterPlayDetail) => void): void;
    off(event?: string): void;
  }
}
