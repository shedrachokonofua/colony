import { createHash } from "node:crypto";
import { createPool, PolicyRepository, TaskGraphRepository } from "@colony/db";
import { env } from "@colony/config";
import type { ActorId, Capability, Role } from "@colony/domain";

const args = process.argv.slice(2);
const command = args[0] ?? "list";
const options = parseOptions(args.slice(1));
const provider = options.PROVIDER ?? "gitlab";
const operator = (options.ACTOR ?? "human:op-1") as ActorId;

const pool = createPool({
  connectionString: env().DATABASE_URL,
  role: "colony_writer",
});
const policyRepo = new PolicyRepository(pool);
const graphRepo = new TaskGraphRepository(pool);

try {
  if (command === "list") {
    const identities = await policyRepo.listProviderIdentities(provider);
    for (const identity of identities) {
      const status = identity.disabled_at ? "disabled" : "active";
      const scopes =
        identity.allowed_namespaces.length > 0
          ? identity.allowed_namespaces.join(",")
          : "*";
      console.log(
        [
          identity.actor,
          identity.role,
          identity.provider_username ?? identity.provider_user_id,
          identity.token_fingerprint ?? "no-token-fingerprint",
          scopes,
          status,
        ].join("\t"),
      );
    }
  } else if (command === "scope") {
    const role = requireOption(options, "ROLE");
    const namespaces = (options.NAMESPACES ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const identity = await policyRepo.setProviderIdentityAllowedNamespaces({
      actor: botActor(role),
      provider,
      allowed_namespaces: namespaces,
    });
    if (!identity) throw new Error(`bot not found: ${role}`);
    await audit("provider.bot.scope", identity.actor, {
      role,
      provider,
      allowed_namespaces: namespaces,
    });
    console.log(`${identity.actor}\t${identity.allowed_namespaces.join(",")}`);
  } else if (command === "add" || command === "rotate") {
    const roleKey = requireOption(options, "ROLE");
    const token = requireOption(options, "TOKEN");
    const role = botRole(roleKey);
    const username = options.USERNAME ?? `colony-${roleKey}`;
    const providerUserId = options.PROVIDER_USER_ID ?? username;
    const identity = await policyRepo.upsertProviderIdentity({
      actor: botActor(roleKey),
      provider,
      provider_user_id: providerUserId,
      provider_username: username,
      role,
      is_bot: true,
      token_fingerprint: fingerprint(token),
      allowed_namespaces: (options.NAMESPACES ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    });
    await policyRepo.grantCapabilitiesForActor({
      actor: identity.actor,
      role,
      capabilities: botCapabilities(roleKey),
      granted_by: operator,
    });
    await audit(
      command === "add" ? "provider.bot.add" : "provider.bot.rotate",
      identity.actor,
      {
        role: roleKey,
        provider,
        token_fingerprint: identity.token_fingerprint,
      },
    );
    console.log(
      `${identity.actor}\t${identity.provider_username ?? identity.provider_user_id}\t${identity.token_fingerprint}`,
    );
  } else if (command === "remove") {
    const role = requireOption(options, "ROLE");
    const identity = await policyRepo.disableProviderIdentity({
      actor: botActor(role),
      provider,
    });
    if (!identity) throw new Error(`bot not found: ${role}`);
    await audit("provider.bot.remove", identity.actor, { role, provider });
    console.log(`${identity.actor}\tdisabled`);
  } else {
    throw new Error(
      "usage: bots.ts list | add ROLE=x TOKEN=y | rotate ROLE=x TOKEN=y | scope ROLE=x NAMESPACES=a,b | remove ROLE=x",
    );
  }
} finally {
  await pool.end();
}

async function audit(
  action: string,
  target_id: string,
  evidence: Readonly<Record<string, unknown>>,
): Promise<void> {
  await graphRepo.writeAudit({
    actor: operator,
    action,
    capability: "provider.admin.bootstrap",
    target_kind: "provider_identity",
    target_id,
    reason: "operator_cli",
    evidence,
  });
}

function parseOptions(items: string[]): Record<string, string> {
  return Object.fromEntries(
    items.map((item) => {
      const i = item.indexOf("=");
      if (i === -1) return [item, "true"];
      return [item.slice(0, i), item.slice(i + 1)];
    }),
  );
}

function requireOption(options: Record<string, string>, key: string): string {
  const value = options[key];
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

function botActor(role: string): ActorId {
  return `bot:${role}` as ActorId;
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function botRole(botKey: string): Role {
  if (botKey === "engine") return "developer";
  if (botKey === "reviewer") return "reviewer";
  if (botKey === "architect") return "architect";
  if (botKey === "integrator") return "integrator";
  if (botKey === "memory_consolidator") return "memory_consolidator";
  if (botKey === "supervisor") return "supervisor";
  return "developer";
}

function botCapabilities(botKey: string): Capability[] {
  switch (botKey) {
    case "engine":
      return [
        "provider.issues.create",
        "provider.issues.update",
        "provider.issues.comment",
        "provider.mr.open",
        "provider.branches.push",
        "provider.commits.read",
      ];
    case "reviewer":
      return [
        "provider.issues.comment",
        "provider.mr.approve",
        "provider.mr.comment",
        "provider.mr.review_thread",
      ];
    case "architect":
      return [
        "graph.write",
        "provider.issues.create",
        "provider.epics.create",
        "provider.epics.update",
        "provider.epics.close",
      ];
    case "integrator":
      return [
        "provider.mr.merge",
        "provider.branches.protect",
        "provider.pipelines.read",
        "provider.pipelines.trigger",
      ];
    case "memory_consolidator":
      return [
        "provider.issues.update",
        "provider.issues.addLabel",
        "provider.issues.removeLabel",
      ];
    case "supervisor":
      return ["graph.write", "audit.write"];
    default:
      return [];
  }
}
