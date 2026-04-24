/** Marker export so workspace consumers can verify the package graph. */
export const COLONY_DOMAIN_PACKAGE = "@colony/domain" as const;

export function domainHello(): string {
  return "colony-domain";
}
