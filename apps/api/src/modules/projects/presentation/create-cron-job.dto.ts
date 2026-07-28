export class CreateCronJobDto {
  name!: string;
  command!: string;
  schedule!: string;
}
