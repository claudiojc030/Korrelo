export const REPOSITORY_CLONER = Symbol("REPOSITORY_CLONER");

export interface RepositoryCloner {
  cloneOrUpdate(repoUrl: string, destPath: string, accessToken?: string): Promise<void>;
}
