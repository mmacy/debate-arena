import assert from "node:assert/strict";
import test from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProviderRuntime, hasAnthropicCredentials, parseModelRef } from "./providers.mjs";

test("parseModelRef preserves provider-qualified model ids and legacy Ollama ids", () => {
    assert.deepEqual(parseModelRef("anthropic:claude-opus-4-8"), {
        provider: "anthropic",
        providerLabel: "Anthropic",
        model: "claude-opus-4-8",
        ref: "anthropic:claude-opus-4-8",
        label: "Anthropic / claude-opus-4-8",
    });
    assert.equal(parseModelRef("llama3.2:latest").ref, "ollama:llama3.2:latest");
    assert.equal(
        parseModelRef("foundry:my-deployment").label,
        "Microsoft Foundry / my-deployment"
    );
});

test("listModels groups compatible models and reports provider failures", async () => {
    class Anthropic {
        models = {
            list: async () =>
                asyncValues({ id: "claude-opus-4-8" }, { id: "claude-haiku-4-5" }),
        };
    }
    class Mistral {
        models = {
            list: async () => ({
                data: [
                    { id: "mistral-large-latest" },
                    { id: "mistral-embed" },
                ],
            }),
        };
    }
    class OpenAI {
        models = {
            list: async () => {
                throw new Error("invalid key");
            },
        };
    }
    const runtime = createProviderRuntime({
        Anthropic,
        Mistral,
        OpenAI,
        env: {
            ANTHROPIC_API_KEY: "test",
            MISTRAL_API_KEY: "test",
            OPENAI_API_KEY: "test",
        },
        fetchImpl: async () =>
            Response.json({ models: [{ name: "llama3.2:latest" }] }),
    });

    const result = await runtime.listModels();
    assert.deepEqual(
        result.models.map(({ ref }) => ref),
        [
            "ollama:llama3.2:latest",
            "anthropic:claude-opus-4-8",
            "anthropic:claude-haiku-4-5",
            "mistral:mistral-large-latest",
        ]
    );
    assert.deepEqual(result.configuredProviders, ["ollama", "anthropic", "mistral", "openai"]);
    assert.match(result.warnings.join(" "), /OpenAI: invalid key/);
});

test("streamChat dispatches to provider SDKs and assembles only visible text", async () => {
    let anthropicRequest;
    let mistralRequest;
    let openAiRequest;

    class Anthropic {
        models = {
            retrieve: async (id) => ({ id }),
        };
        messages = {
            stream: (request) => {
                anthropicRequest = request;
                return asyncValues(
                    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hidden" } },
                    { type: "content_block_delta", delta: { type: "text_delta", text: "claude" } }
                );
            },
        };
    }
    class Mistral {
        chat = {
            stream: async (request) => {
                mistralRequest = request;
                return asyncValues({
                    data: { choices: [{ delta: { content: "mistral" } }] },
                });
            },
        };
    }
    class OpenAI {
        chat = {
            completions: {
                create: async (request) => {
                    openAiRequest = request;
                    return asyncValues({ choices: [{ delta: { content: "openai" } }] });
                },
            },
        };
    }
    const runtime = createProviderRuntime({
        Anthropic,
        Mistral,
        OpenAI,
        env: {
            ANTHROPIC_API_KEY: "test",
            MISTRAL_API_KEY: "test",
            OPENAI_API_KEY: "test",
        },
        fetchImpl: async () => Response.json({ models: [] }),
    });
    const messages = [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Debate this." },
    ];
    const chunks = [];

    const anthropic = await runtime.streamChat({
        model: "anthropic:claude-opus-4-8",
        messages,
        signal: new AbortController().signal,
        onDelta: (piece) => chunks.push(piece),
    });
    const mistral = await runtime.streamChat({
        model: "mistral:mistral-large-latest",
        messages,
        signal: new AbortController().signal,
        onDelta: (piece) => chunks.push(piece),
    });
    const openai = await runtime.streamChat({
        model: "openai:gpt-4o",
        messages,
        signal: new AbortController().signal,
        onDelta: (piece) => chunks.push(piece),
    });

    assert.equal(anthropic, "claude");
    assert.equal(mistral, "mistral");
    assert.equal(openai, "openai");
    assert.deepEqual(chunks, ["claude", "mistral", "openai"]);
    assert.equal(anthropicRequest.system, "Be concise.");
    assert.deepEqual(anthropicRequest.messages, [{ role: "user", content: "Debate this." }]);
    assert.deepEqual(anthropicRequest.thinking, { type: "adaptive" });
    assert.deepEqual(anthropicRequest.cache_control, { type: "ephemeral" });
    assert.equal(mistralRequest.model, "mistral-large-latest");
    assert.equal(openAiRequest.temperature, 0.8);
});

test("Microsoft Foundry uses its v1 deployment endpoint and streams chat", async () => {
    let clientOptions;
    let request;
    class OpenAI {
        constructor(options) {
            clientOptions = options;
            this.models = {
                list: async () => ({ data: [{ id: "my-chat-deployment" }] }),
            };
            this.chat = {
                completions: {
                    create: async (body) => {
                        request = body;
                        return asyncValues({ choices: [{ delta: { content: "foundry" } }] });
                    },
                },
            };
        }
    }
    const runtime = createProviderRuntime({
        OpenAI,
        DefaultAzureCredential: class {},
        env: {
            AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com",
            AZURE_INFERENCE_CREDENTIAL: "test",
            AZURE_FOUNDRY_DEPLOYMENTS: "my-chat-deployment",
        },
        fetchImpl: async () => {
            throw new Error("Ollama unavailable");
        },
    });

    const models = await runtime.listModels();
    const output = await runtime.streamChat({
        model: "foundry:my-chat-deployment",
        messages: [{ role: "user", content: "Debate this." }],
        signal: new AbortController().signal,
        onDelta: () => {},
    });

    assert.equal(clientOptions.baseURL, "https://example.openai.azure.com/openai/v1/");
    assert.equal(models.models[0].ref, "foundry:my-chat-deployment");
    assert.equal(output, "foundry");
    assert.equal(request.model, "my-chat-deployment");
    assert.equal(request.temperature, undefined);
});

test("Google Gemini discovers generateContent models and streams chat", async () => {
    let clientOptions;
    let request;
    class GoogleGenAI {
        constructor(options) {
            clientOptions = options;
            this.models = {
                list: async () =>
                    asyncValues(
                        {
                            name: "models/gemini-4-hydrogen",
                            supportedActions: ["generateContent"],
                            outputTokenLimit: 8192,
                        },
                        {
                            name: "models/gemini-embedding-001",
                            supportedActions: ["embedContent"],
                        },
                        {
                            name: "models/text-embedding-004",
                            supportedActions: ["embedContent"],
                        }
                    ),
                get: async () => ({
                    name: "models/gemini-4-hydrogen",
                    supportedActions: ["generateContent"],
                    outputTokenLimit: 8192,
                }),
                generateContentStream: async (body) => {
                    request = body;
                    return asyncValues({ text: "gemini" }, { text: " response" });
                },
            };
        }
    }
    const runtime = createProviderRuntime({
        GoogleGenAI,
        env: {
            GEMINI_API_KEY: "test",
            DEBATE_MAX_TOKENS: "12000",
        },
        fetchImpl: async () => {
            throw new Error("Ollama unavailable");
        },
    });
    const output = await runtime.streamChat({
        model: "google:gemini-4-hydrogen",
        messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "Debate this." },
            { role: "assistant", content: "A prior response." },
        ],
        signal: new AbortController().signal,
        onDelta: () => {},
    });
    const models = await runtime.listModels();

    assert.equal(output, "gemini response");
    assert.equal(clientOptions.apiKey, "test");
    assert.deepEqual(models.models.map(({ ref }) => ref), ["google:gemini-4-hydrogen"]);
    assert.equal(request.model, "gemini-4-hydrogen");
    assert.equal(request.config.maxOutputTokens, 8192);
    assert.equal(request.config.systemInstruction, "Be concise.");
    assert.equal(request.contents[1].role, "model");
});

test("Google Gemini supports Vertex AI Application Default Credentials", async () => {
    let clientOptions;
    class GoogleGenAI {
        constructor(options) {
            clientOptions = options;
            this.models = {
                list: async () =>
                    asyncValues({
                        name: "publishers/google/models/gemini-4-hydrogen",
                        supportedActions: ["generateContent"],
                    }),
            };
        }
    }
    const runtime = createProviderRuntime({
        GoogleGenAI,
        env: {
            GOOGLE_CLOUD_PROJECT: "my-project",
        },
        fetchImpl: async () => {
            throw new Error("Ollama unavailable");
        },
    });

    const models = await runtime.listModels();

    assert.equal(clientOptions.vertexai, true);
    assert.equal(clientOptions.project, "my-project");
    assert.equal(clientOptions.location, "global");
    assert.equal(models.models[0].ref, "google:gemini-4-hydrogen");
});

test("Microsoft Foundry uses DefaultAzureCredential when no API key is set", async () => {
    let tokenProvider;
    let credentialScope;
    let clientOptions;
    class OpenAI {
        constructor(options) {
            clientOptions = options;
            this.chat = {
                completions: {
                    create: async () =>
                        asyncValues({ choices: [{ delta: { content: "foundry" } }] }),
                },
            };
        }
    }
    class DefaultAzureCredential {
        async getToken(scope) {
            assert.equal(scope, "https://management.azure.com/.default");
            return { token: "management-token" };
        }
    }
    const getBearerTokenProvider = (credential, scope) => {
        assert.ok(credential instanceof DefaultAzureCredential);
        credentialScope = scope;
        tokenProvider = async () => "token";
        return tokenProvider;
    };
    const runtime = createProviderRuntime({
        OpenAI,
        DefaultAzureCredential,
        getBearerTokenProvider,
        env: {
            AZURE_FOUNDRY_ENDPOINT: "https://example.services.ai.azure.com",
        },
        fetchImpl: async (url) => foundryDiscoveryResponse(String(url)),
    });

    const models = await runtime.listModels();
    const output = await runtime.streamChat({
        model: "foundry:chat-deployment",
        messages: [{ role: "user", content: "Debate this." }],
        signal: new AbortController().signal,
        onDelta: () => {},
    });

    assert.equal(credentialScope, "https://ai.azure.com/.default");
    assert.equal(clientOptions.apiKey, tokenProvider);
    assert.equal(models.models[0].ref, "foundry:chat-deployment");
    assert.equal(models.models.length, 1);
    assert.equal(output, "foundry");
});

test("Anthropic uses Models API capabilities for newer model families", async () => {
    let request;
    class Anthropic {
        models = {
            list: async () =>
                asyncValues({
                    id: "claude-sonnet-5-5",
                    max_tokens: 8192,
                    capabilities: {
                        thinking: {
                            types: {
                                adaptive: { supported: true },
                            },
                        },
                    },
                }),
        };
        messages = {
            stream: (body) => {
                request = body;
                return asyncValues({
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: "capability-aware" },
                });
            },
        };
    }
    const runtime = createProviderRuntime({
        Anthropic,
        env: {
            ANTHROPIC_API_KEY: "test",
            DEBATE_MAX_TOKENS: "12000",
        },
        fetchImpl: async () => {
            throw new Error("Ollama unavailable");
        },
    });

    await runtime.listModels();
    const output = await runtime.streamChat({
        model: "anthropic:claude-sonnet-5-5",
        messages: [{ role: "user", content: "Debate this." }],
        signal: new AbortController().signal,
        onDelta: () => {},
    });

    assert.equal(output, "capability-aware");
    assert.deepEqual(request.thinking, { type: "adaptive" });
    assert.equal(request.temperature, undefined);
    assert.equal(request.max_tokens, 8192);
});

function asyncValues(...values) {
    return {
        async *[Symbol.asyncIterator]() {
            yield* values;
        },
    };
}

function foundryDiscoveryResponse(url) {
    if (url.endsWith("/subscriptions?api-version=2022-12-01")) {
        return Response.json({ value: [{ subscriptionId: "subscription-id" }] });
    }
    if (url.includes("/providers/Microsoft.CognitiveServices/accounts?")) {
        return Response.json({
            value: [{
                id: "/subscriptions/subscription-id/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/example",
                name: "example",
                properties: {
                    endpoint: "https://example.services.ai.azure.com/",
                },
            }],
        });
    }
    if (url.endsWith("/deployments?api-version=2025-06-01")) {
        return Response.json({
            value: [
                {
                    name: "chat-deployment",
                    properties: { provisioningState: "Succeeded" },
                },
                {
                    name: "failed-deployment",
                    properties: { provisioningState: "Failed" },
                },
            ],
        });
    }
    throw new Error(`Unexpected request: ${url}`);
}

test("hasAnthropicCredentials detects env credentials and ant auth login profiles", () => {
    assert.equal(hasAnthropicCredentials({}), false);
    assert.equal(hasAnthropicCredentials({ ANTHROPIC_API_KEY: "k" }), true);
    assert.equal(hasAnthropicCredentials({ ANTHROPIC_AUTH_TOKEN: "t" }), true);

    const dir = mkdtempSync(path.join(tmpdir(), "anthropic-config-"));
    try {
        const env = { ANTHROPIC_CONFIG_DIR: dir };
        assert.equal(hasAnthropicCredentials(env), false);
        mkdirSync(path.join(dir, "configs"));
        writeFileSync(path.join(dir, "configs", "work.json"), "{}");
        assert.equal(hasAnthropicCredentials(env), false);
        writeFileSync(path.join(dir, "active_config"), "work\n");
        assert.equal(hasAnthropicCredentials(env), true);
        assert.equal(hasAnthropicCredentials({ ...env, ANTHROPIC_PROFILE: "missing" }), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
