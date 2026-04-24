import { domainHello } from "@colony/domain";

export function apiBootMessage(): string {
  return `api:${domainHello()}`;
}
