export const REPOSITORY_CLONER = Symbol("REPOSITORY_CLONER");

export interface RepositoryCloner {
  cloneOrUpdate(repoUrl: string, destPath: string, accessToken?: string): Promise<void>;
  // Branch que ficou de fato checada out (o clone sem "-b" já pega a branch
  // padrão real do repositório, seja "main", "master" ou outra). Usado pra
  // pré-preencher a branch monitorada do deploy automático sem o usuário
  // precisar adivinhar/corrigir manualmente depois.
  getCurrentBranch(destPath: string): Promise<string | null>;
}
