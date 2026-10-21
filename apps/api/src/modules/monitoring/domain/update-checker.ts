export const UPDATE_CHECKER = Symbol("UPDATE_CHECKER");

export interface UpdateStatus {
  checked: boolean;
  currentCommit: string | null;
  remoteCommit: string | null;
  commitsBehind: number;
  updateAvailable: boolean;
}

export interface UpdateChecker {
  check(): Promise<UpdateStatus>;
  /**
   * Commit LOCAL do checkout, sem rede (null se não der para ler).
   *
   * Serve para invalidar o cache da checagem: quando o self-update muda o
   * HEAD, o "quantos commits estou atrás" muda junto - e o valor em cache
   * viraria um "atualização disponível" FALSO.
   */
  localCommit?(): Promise<string | null>;
}
