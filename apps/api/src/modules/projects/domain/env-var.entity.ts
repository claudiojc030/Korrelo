export class EnvVar {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly key: string,
    public readonly value: string,
    public readonly createdAt: Date,
  ) {}
}
