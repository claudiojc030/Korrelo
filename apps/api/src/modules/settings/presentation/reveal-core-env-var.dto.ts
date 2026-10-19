export class RevealCoreEnvVarDto {
  /** Chave da variável de ambiente a ser revelada. */
  key!: string;
  /** Senha do administrador - exigida pra revelar o valor real. */
  password!: string;
}
