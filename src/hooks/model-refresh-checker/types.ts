export interface ModelRefreshCheckerOptions {
  enabled?: boolean;
  intervalHours?: number;
  showToast?: boolean;
}

export interface ModelRefreshState {
  lastSuccessAt?: string;
}
