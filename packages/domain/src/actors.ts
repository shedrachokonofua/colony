export const ROLES = ["human", "architect", "implementer", "service"] as const;

export type Role = (typeof ROLES)[number];
