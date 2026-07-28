export class UpdateCronJobDto {
  name?: string;
  command?: string;
  schedule?: string;
  enabled?: boolean;
}
