import { randomUUID } from "node:crypto";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai/oauth";
import type { OAuthProviderApi } from "@colony/db";
import type {
  OAuthBeginInput,
  OAuthCredentialsBlob,
  OAuthDriver,
  OAuthSessionHandle,
} from "./types.js";

type ProviderLogin = (
  callbacks: OAuthLoginCallbacks,
) => Promise<OAuthCredentials>;

interface PendingSession {
  readonly handle: OAuthSessionHandle;
  readonly credentials: Promise<OAuthCredentialsBlob>;
  readonly submit: (code: string) => void;
  readonly reject: (error: Error) => void;
  manualSubmitStarted: boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export interface PiOAuthDriverOptions {
  /**
   * Called when Pi completes via its localhost callback. Manual submit uses
   * the admin route's existing persistence path instead.
   */
  readonly onCredentials?: (input: {
    readonly providerKey: string;
    readonly providerApi: OAuthProviderApi;
    readonly grantedBy: string;
    readonly credentials: OAuthCredentialsBlob;
  }) => Promise<void>;
}

export class PiOAuthDriver implements OAuthDriver {
  private readonly sessions = new Map<string, PendingSession>();

  constructor(private readonly options: PiOAuthDriverOptions = {}) {}

  async begin(input: OAuthBeginInput): Promise<{
    readonly result: {
      readonly authorizeUrl: string;
      readonly instructions?: string;
    };
    readonly handle: OAuthSessionHandle;
  }> {
    const provider = await providerLogin(input);
    const handle: OAuthSessionHandle = {
      id: `pi-oauth-${randomUUID()}`,
      providerKey: input.providerKey,
    };
    const auth = deferred<{ url: string; instructions?: string }>();
    const code = deferred<string>();
    const credentials = provider
      .login({
        onAuth(info) {
          auth.resolve({ url: info.url, instructions: info.instructions });
        },
        onPrompt: () => code.promise,
        onManualCodeInput: () => code.promise,
        onProgress: () => {},
      })
      .then((value) => value as OAuthCredentialsBlob)
      .catch((error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        auth.reject(err);
        throw err;
      });

    const pending: PendingSession = {
      handle,
      credentials,
      submit: code.resolve,
      reject: code.reject,
      manualSubmitStarted: false,
    };
    this.sessions.set(handle.id, pending);
    void credentials.then(
      async (value) => {
        if (pending.manualSubmitStarted) return;
        if (this.sessions.get(handle.id) !== pending) return;
        try {
          await this.options.onCredentials?.({
            providerKey: input.providerKey,
            providerApi: input.providerApi,
            grantedBy: input.initiator,
            credentials: value,
          });
          this.sessions.delete(handle.id);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.error(
            `failed to persist OAuth callback credentials for ${input.providerKey}: ${reason}`,
          );
        }
      },
      () => {},
    );
    void credentials.catch(() => {});

    try {
      const started = await auth.promise;
      return {
        result: {
          authorizeUrl: started.url,
          instructions: started.instructions,
        },
        handle,
      };
    } catch (error) {
      this.sessions.delete(handle.id);
      code.reject(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async submitCode(
    handle: OAuthSessionHandle,
    input: { readonly code: string },
  ): Promise<OAuthCredentialsBlob> {
    const pending = this.requireSession(handle);
    pending.manualSubmitStarted = true;
    pending.submit(input.code);
    try {
      return await pending.credentials;
    } finally {
      this.sessions.delete(handle.id);
    }
  }

  cancel(handle: OAuthSessionHandle): Promise<void> {
    const pending = this.sessions.get(handle.id);
    if (!pending) return Promise.resolve();
    this.sessions.delete(handle.id);
    pending.reject(new Error("OAuth session canceled"));
    return Promise.resolve();
  }

  private requireSession(handle: OAuthSessionHandle): PendingSession {
    const pending = this.sessions.get(handle.id);
    if (!pending || pending.handle.providerKey !== handle.providerKey) {
      throw new Error(`OAuth session ${handle.id} is not active`);
    }
    return pending;
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function providerLogin(input: OAuthBeginInput): Promise<{
  readonly login: ProviderLogin;
}> {
  await settlePiNodeImports();
  if (input.providerApi === "openai-codex-responses") {
    const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");
    return {
      login: (callbacks) =>
        loginOpenAICodex({ ...callbacks, originator: "colony" }),
    };
  }
  if (input.providerApi === "anthropic-messages") {
    const { loginAnthropic } = await import("@mariozechner/pi-ai/oauth");
    return { login: loginAnthropic };
  }
  throw new Error(`OAuth is not wired for provider api ${input.providerApi}`);
}

async function settlePiNodeImports(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
