export class RowUpdateDto {
  primaryKey!: Record<string, string>;
  changes!: Record<string, string>;
}

export class UpdateDatabaseRowsDto {
  table!: string;
  updates!: RowUpdateDto[];
}
