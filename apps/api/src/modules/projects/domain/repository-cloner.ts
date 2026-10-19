export const REPOSITORY_CLONER = Symbol("REPOSITORY_CLONER");

export interface RepositoryCloner {
  cloneOrUpdate(repoUrl: string, destPath: string, accessToken?: string): Promise<void>;
  // Branch que ficou de fato checada out (o clone sem "-b" já pega a branch
  // padrão real do repositório, seja "main", "master" ou outra). Usado pra
  // pré-preencher a branch monitorada do deploy automático sem o usuário
  // precisar adivinhar/corrigir manualmente depois.
  getCurrentBranch(destPath: string): Promise<string | null>;
  // Commit que ficou checado out depois do cloneOrUpdate, pro histórico de
  // deploy mostrar qual versão do GitHub está rodando de fato.
  getLastCommit(destPath: string): Promise<{ hash: string; message: string } | null>;
  /**
   * Prepara o workspace no COMMIT exato (Wave 2).
   *
   * Sem isso, o deploy usava "git pull" na branch padrão do clone: o
   * `deployBranch` configurado no projeto era ignorado e o commit
   * implantado podia ser outro. Aqui o workspace é colocado no commit
   * registrado no job de deploy e o HEAD é VERIFICADO - se não bater, o
   * deploy falha em vez de subir a versão errada.
   *
   * Premissa: o workspace é EXCLUSIVAMENTE gerenciado pelo Korrelo (ele
   * mesmo já descartava alterações locais antes do pull), então alterações
   * não commitadas são descartadas com segurança.
   */
  prepareCommit(
    repoUrl: string,
    destPath: string,
    accessToken: string | undefined,
    params: { branch?: string | null; commitSha?: string | null },
  ): Promise<{ sha: string; message: string }>;
}
