export class MetricSample {
  constructor(
    public readonly id: string,
    public readonly cpuPercent: number,
    public readonly usedMemPercent: number,
    public readonly usedDiskPercent: number,
    public readonly capturedAt: Date,
  ) {}

  static create(cpuPercent: number, usedMemPercent: number, usedDiskPercent: number): MetricSample {
    return new MetricSample(crypto.randomUUID(), cpuPercent, usedMemPercent, usedDiskPercent, new Date());
  }
}
