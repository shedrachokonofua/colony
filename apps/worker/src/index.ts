import { domainHello } from "@colony/domain";

export function workerBootMessage(): string {
  return `worker:${domainHello()}`;
}
