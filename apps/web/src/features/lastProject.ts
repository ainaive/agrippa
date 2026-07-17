const STORAGE_KEY = "agrippa.lastProject";

export function getLastProjectId(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setLastProjectId(projectId: string) {
  localStorage.setItem(STORAGE_KEY, projectId);
}
