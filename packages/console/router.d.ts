export const PROJECT_ROUTE: RegExp;
export const FILES_ROUTE: RegExp;
export const NEW_ROUTE: RegExp;
export const NEW_PROJECT_ROUTE: RegExp;

export function routeScopeId(): string | null;
export function routeIsNew(): boolean;
export function routeIsNewProject(): boolean;
export function routeIsManageFiles(): boolean;
export function routeProjectFilesName(): string | null;
export function routeProjectName(): string | null;
export function projectHref(name: string): string;

export function projectFilesHref(name: string): string;

export function hashQueryProject(): string | null;
