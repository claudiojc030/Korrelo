export class EnvVarDto {
  key!: string;
  value!: string;
}

export class SetEnvVarsDto {
  vars!: EnvVarDto[];
}
