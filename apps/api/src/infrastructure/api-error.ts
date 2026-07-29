export interface ApiErrorBody {
  code: string;
  message: string;
}

export function apiError(code: string, message: string): ApiErrorBody {
  return { code, message };
}
