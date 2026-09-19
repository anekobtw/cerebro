export class PcmChunker {
  private pending: Int16Array;
  private pendingLength = 0;

  constructor(readonly samplesPerChunk: number) {
    if (!Number.isInteger(samplesPerChunk) || samplesPerChunk <= 0) {
      throw new Error("samplesPerChunk must be a positive integer");
    }

    this.pending = new Int16Array(samplesPerChunk);
  }

  get pendingSamples(): number {
    return this.pendingLength;
  }

  push(samples: Int16Array): Int16Array[] {
    const chunks: Int16Array[] = [];
    let offset = 0;

    while (offset < samples.length) {
      const room = this.samplesPerChunk - this.pendingLength;
      const take = Math.min(room, samples.length - offset);

      this.pending.set(samples.subarray(offset, offset + take), this.pendingLength);
      this.pendingLength += take;
      offset += take;

      if (this.pendingLength === this.samplesPerChunk) {
        chunks.push(this.pending.slice());
        this.pendingLength = 0;
      }
    }

    return chunks;
  }

  reset(): void {
    this.pendingLength = 0;
  }
}
