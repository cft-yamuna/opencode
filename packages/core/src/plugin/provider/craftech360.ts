import { Effect, Schema } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Credential } from "../../credential.js"
import { Integration } from "../../integration.js"
import { IntegrationConnection } from "../../integration/connection.js"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"
import { ProviderRefresh } from "./refresh.js"

const origin = "https://ai.craftech360.com"
const integrationID = Integration.ID.make("craftech360")
const providerID = Provider.ID.make("craftech360")
const methodID = Integration.MethodID.make("google")
const Device = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri_complete: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
})
const Token = Schema.Union([
  Schema.Struct({ access_token: Schema.String }),
  Schema.Struct({ error: Schema.String }),
])
const Models = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) })

class InvalidKeyError extends Error {}

function post(path: string, body: object) {
  return Effect.tryPromise(async () => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Craftech360 sign-in failed (HTTP ${response.status})`)
    return response.json() as Promise<unknown>
  })
}

export const Craftech360Plugin = define({
  id: "opencode.provider.craftech360",
  effect: Effect.fn(function* (ctx) {
    const active = { connection: yield* ctx.integration.connection.active(integrationID), key: "", models: [] as string[] }

    yield* ctx.integration.transform((editor) => {
      editor.update(integrationID, (integration) => (integration.name = "Craftech360 AI"))
      editor.method.update({
        integrationID,
        method: { id: methodID, type: "oauth", label: "Sign in with Google" },
        authorize: () =>
          Effect.gen(function* () {
            const device = yield* post("/api/auth/device/start", {}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Device)))
            const expires = Date.now() + device.expires_in * 1000
            const poll = (): Effect.Effect<Credential.OAuth, unknown> =>
              Effect.gen(function* () {
                yield* Effect.sleep(device.interval * 1000)
                if (Date.now() >= expires) return yield* Effect.fail(new Error("Craftech360 sign-in expired"))
                const token = yield* post("/api/auth/device/token", { device_code: device.device_code }).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Token)),
                )
                if ("access_token" in token)
                  return { type: "oauth" as const, methodID, access: token.access_token, refresh: "", expires: 0 }
                if (token.error === "authorization_pending") return yield* poll()
                return yield* Effect.fail(new Error(`Craftech360 sign-in failed: ${token.error}`))
              })
            return {
              mode: "auto" as const,
              url: device.verification_uri_complete,
              instructions: `Approve code ${device.user_code} in your browser`,
              callback: poll(),
            }
          }),
      })
    })

    const refresh = Effect.fn("Craftech360.refresh")(function* () {
      const connection = yield* ctx.integration.connection.active(integrationID)
      const credential = connection && (yield* ctx.integration.connection.resolve(connection))
      const key = credential?.type === "oauth" ? credential.access : ""
      const discovery = key
        ? yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(`${origin}/v1/models`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.timeout(10_000),
              })
              if (response.status === 401) throw new InvalidKeyError("Craftech360 key is no longer valid")
              if (!response.ok) throw new Error(`Craftech360 models failed (HTTP ${response.status})`)
              return response.json() as Promise<unknown>
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Models)),
            Effect.map((result) => ({
              state: "ok" as const,
              models: [...new Set(result.data.map((model) => model.id))].filter(
                (id) =>
                  /^[a-zA-Z0-9._/:-]+$/.test(id) &&
                  !/(?:^|[/._-])(?:seedance|kling|happyhorse|minimax[/_-]h3)(?=$|[/._-])/i.test(id),
              ),
            })),
            Effect.catch((cause) =>
              Effect.succeed({
                state: cause instanceof InvalidKeyError ? ("unauthorized" as const) : ("retry" as const),
                models: key === active.key ? active.models : [],
              }),
            ),
          )
        : { state: "ok" as const, models: [] }
      if (connection && discovery.state !== "retry")
        yield* ctx.integration.connection.status({
          integrationID,
          connection,
          status:
            discovery.state === "unauthorized"
              ? { status: "needs_auth", message: "Sign in to Craftech360 AI again" }
              : undefined,
        })
      const models = discovery.state === "unauthorized" ? [] : discovery.models
      const availableKey = discovery.state === "unauthorized" ? "" : key
      if (
        availableKey === active.key &&
        IntegrationConnection.key(connection) === IntegrationConnection.key(active.connection) &&
        JSON.stringify(models) === JSON.stringify(active.models)
      ) return
      active.connection = connection
      active.key = availableKey
      active.models = models
      yield* ctx.provider.reload()
    })

    yield* ctx.provider.transform((providers) => {
      if (!active.key) return
      providers.add({
        info: {
          id: providerID,
          integrationID,
          name: "Craftech360 AI",
          activation: "auto",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${origin}/v1`, apiKey: active.key },
        },
        models: active.models.map((id) => Model.Info.default(providerID, Model.ID.make(id))),
        sourceConnection: active.connection,
      })
    })
    const checked = refresh().pipe(
      Effect.catch((cause) => Effect.logWarning("failed to load Craftech360 models", { cause })),
    )
    yield* checked
    yield* ProviderRefresh.onSwitch(integrationID, checked)
    yield* Effect.sleep("1 minute").pipe(Effect.andThen(checked), Effect.forever, Effect.forkScoped)
  }),
})
