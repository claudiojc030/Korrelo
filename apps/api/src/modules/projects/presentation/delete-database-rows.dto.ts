export class DeleteDatabaseRowsDto {
  table!: string;
  primaryKeys!: Record<string, string>[];
}
