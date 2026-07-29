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
}
