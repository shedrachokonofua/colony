export function pageFromHash(hash: string): number;

export function hrefForPage(base: string, page: number): string;

export function outOfRange(page: number, total: number, limit: number): boolean;

export function pageCount(total: number, limit: number): number;
