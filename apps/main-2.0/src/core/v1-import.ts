export interface V1ImportResult {
  sourcePath: string;
  importedSessions: number;
  skippedSessions: number;
  failedSessions: number;
  importedEnvironments: number;
  importedSyncBindings: number;
  importedSettings: number;
}
