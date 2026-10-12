/** A bounded byte ring. A slow reader gets an explicit loss count, not hidden truncation. */
export class OutputBuffer {
  private chunks: Buffer[] = [];
  private head = 0;
  private offset = 0;
  private bytes = 0;
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  append(data: Buffer): void {
    if (!data.length) return;
    this.chunks.push(data);
    this.bytes += data.length;
    const overflow = Math.max(0, this.bytes - this.capacity);
    this.dropped += overflow;
    this.consume(overflow);
    // A byte limit may cut the oldest UTF-8 character. Account for its remainder.
    while (this.bytes && (this.chunks[this.head][this.offset] & 0xc0) === 0x80) {
      this.consume(1);
      this.dropped++;
    }
  }

  read(maxBytes: number): { output: string; dropped_bytes: number; unread_bytes: number } {
    const pieces: Buffer[] = [];
    let budget = maxBytes;
    while (this.bytes && budget > 0) {
      const chunk = this.chunks[this.head];
      let end = Math.min(chunk.length, this.offset + budget);
      while (end < chunk.length && end > this.offset && (chunk[end] & 0xc0) === 0x80) end--;
      if (end === this.offset) break;
      const size = end - this.offset;
      pieces.push(chunk.subarray(this.offset, end));
      this.consume(size);
      budget -= size;
    }
    const dropped_bytes = this.dropped;
    this.dropped = 0;
    return { output: Buffer.concat(pieces).toString("utf8"), dropped_bytes, unread_bytes: this.bytes };
  }

  private consume(count: number): void {
    this.bytes -= count;
    while (count > 0) {
      const remaining = this.chunks[this.head].length - this.offset;
      if (count < remaining) {
        this.offset += count;
        count = 0;
      } else {
        count -= remaining;
        // Release buffers immediately instead of retaining already-read output.
        this.chunks[this.head++] = Buffer.alloc(0);
        this.offset = 0;
      }
    }
    if (this.head > 128 || this.bytes === 0) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}
