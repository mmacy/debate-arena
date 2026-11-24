import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PROVIDER_LABELS = {
    ollama: "Ollama",
    anthropic: "Anthropic",
    mistral: "Mistral",
    openai: "OpenAI",
    foundry: "Microsoft Foundry",
    google: "Google Gemini",
};

const PROVIDER_ORDER = ["ollama", "anthropic", "mistral", "openai", "foundry", "google"];
const MAX_ERROR_LENGTH = 500;

export function parseModelRef(value) {
    const raw = String(value || "").trim();
    if (!raw) throw new Error("Please choose a model for every participant.");

    for (const provider of PROVIDER_ORDER) {
        const prefix = `${provider}:`;
        if (raw.startsWith(prefix)) {
            const model = raw.slice(prefix.length).trim();
            if (!model) throw new Error(`Invalid ${PROVIDER_LABELS[provider]} model selection.`);
            return createSelection(provider, model);
        }
    }

    // Existing saved/queued configurations only stored an Ollama model name.
    return createSelection("ollama", raw);
}

function createSelection(provider, model) {
    return {
        provider,
        providerLabel: PROVIDER_LABELS[provider],
        model,
        ref: `${provider}:${model}`,
        label: `${PROVIDER_LABELS[provider]} / ${model}`,
    };
}

export function createProviderRuntime({
    Anthropic,
    OpenAI,
    Mistral,
    GoogleGenAI,
    DefaultAzureCredential,
    getBearerTokenProvider,
    env = process.env,
    fetchImpl = globalThis.fetch,
} = {}) {
    const ollamaHost = env.OLLAMA_HOST?.replace(/\/+$/, "") || "http://127.0.0.1:11434";
    const maxTokens = Math.min(
        Math.max(Number.parseInt(env.DEBATE_MAX_TOKENS, 10) || 4096, 256),
        16384
    );
    const foundryEndpoint =
        env.AZURE_FOUNDRY_ENDPOINT ||
        env.AZURE_OPENAI_ENDPOINT ||
        env.AZURE_INFERENCE_ENDPOINT;
    const foundryCredential =
        env.AZURE_INFERENCE_CREDENTIAL ||
        env.AZURE_OPENAI_API_KEY;
    const foundryDeployments = parseCsv(env.AZURE_FOUNDRY_DEPLOYMENTS);
    const googleApiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
    const googleVertex = isTruthy(
        env.GOOGLE_GENAI_USE_VERTEXAI || env.GOOGLE_GENAI_USE_ENTERPRISE
    ) || Boolean(env.GOOGLE_CLOUD_PROJECT && !googleApiKey);
    const googleProject = env.GOOGLE_CLOUD_PROJECT;
    const googleLocation = env.GOOGLE_CLOUD_LOCATION || "global";
    const anthropicOptions = (extra) => ({
        // Omitting apiKey lets the SDK resolve credentials itself: ANTHROPIC_API_KEY,
        // ANTHROPIC_AUTH_TOKEN, an `ant auth login` profile, or federation env vars.
        ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
        maxRetries: 0,
        ...extra,
    });

    const clients = {};
    const modelMetadata = new Map();
    const client = (provider, factory) => {
        if (!clients[provider]) clients[provider] = factory();
        return clients[provider];
    };

    const definitions = [
        {
            id: "ollama",
            enabled: true,
            list: () => listOllamaModels({ fetchImpl, host: ollamaHost }),
            stream: (selection, args) =>
                streamOllamaChat({ ...args, host: ollamaHost, fetchImpl, selection, maxTokens }),
        },
        {
            id: "anthropic",
            enabled: hasAnthropicCredentials(env),
            list: () => {
                if (!Anthropic) throw new Error("Anthropic SDK is not installed.");
                const anthropic = client(
                    "anthropic-list",
                    () => new Anthropic(anthropicOptions({ timeout: 8000 }))
                );
                return listSdkModels(anthropic.models.list(undefined, {
                    signal: AbortSignal.timeout(8000),
                }), (id) => id.startsWith("claude-"), "anthropic");
            },
            stream: (selection, args) => {
                if (!Anthropic) throw new Error("Anthropic SDK is not installed.");
                const anthropic = client("anthropic", () => new Anthropic(anthropicOptions()));
                return streamAnthropicChat({ ...args, client: anthropic, selection, maxTokens });
            },
            inspect: async (selection) => {
                if (!Anthropic) throw new Error("Anthropic SDK is not installed.");
                const anthropic = client("anthropic", () => new Anthropic(anthropicOptions()));
                return anthropic.models.retrieve(selection.model, undefined, {
                    signal: AbortSignal.timeout(8000),
                });
            },
        },
        {
            id: "mistral",
            enabled: Boolean(env.MISTRAL_API_KEY),
            list: () => {
                if (!Mistral) throw new Error("Mistral SDK is not installed.");
                const mistral = client(
                    "mistral",
                    () => new Mistral({
                        apiKey: env.MISTRAL_API_KEY,
                        ...(env.MISTRAL_BASE_URL ? { serverURL: env.MISTRAL_BASE_URL } : {}),
                    })
                );
                return listSdkModels(
                    mistral.models.list(undefined, requestOptions(argsTimeoutSignal())),
                    isMistralChatModel,
                    "mistral"
                );
            },
            stream: (selection, args) => {
                if (!Mistral) throw new Error("Mistral SDK is not installed.");
                const mistral = client(
                    "mistral",
                    () => new Mistral({
                        apiKey: env.MISTRAL_API_KEY,
                        ...(env.MISTRAL_BASE_URL ? { serverURL: env.MISTRAL_BASE_URL } : {}),
                    })
                );
                return streamMistralChat({ ...args, client: mistral, selection, maxTokens });
            },
        },
        {
            id: "openai",
            enabled: Boolean(env.OPENAI_API_KEY),
            list: () => {
                if (!OpenAI) throw new Error("OpenAI SDK is not installed.");
                const openai = client(
                    "openai",
                    () => new OpenAI({
                        apiKey: env.OPENAI_API_KEY,
                        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
                        timeout: 8000,
                        maxRetries: 0,
                    })
                );
                return listSdkModels(
                    openai.models.list({}, { signal: AbortSignal.timeout(8000) }),
                    isOpenAiChatModel,
                    "openai"
                );
            },
            stream: (selection, args) => {
                if (!OpenAI) throw new Error("OpenAI SDK is not installed.");
                const openai = client(
                    "openai",
                    () => new OpenAI({
                        apiKey: env.OPENAI_API_KEY,
                        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
                        maxRetries: 0,
                    })
                );
                return streamOpenAiChat({ ...args, client: openai, selection, maxTokens });
            },
        },
        {
            id: "foundry",
            enabled: Boolean(foundryEndpoint),
            list: () => listFoundryModels(),
            stream: (selection, args) => {
                const foundry = getFoundryClient();
                return streamOpenAiChat({ ...args, client: foundry, selection, maxTokens });
            },
        },
        {
            id: "google",
            enabled: Boolean(googleApiKey || (googleVertex && googleProject)),
            list: () => {
                const google = getGoogleClient();
                return listGoogleModels(google);
            },
            stream: (selection, args) => {
                const google = getGoogleClient();
                return streamGoogleChat({
                    ...args,
                    client: google,
                    selection,
                    maxTokens,
                });
            },
            inspect: async (selection) => {
                const google = getGoogleClient();
                return google.models.get({
                    model: selection.model,
                    config: { abortSignal: AbortSignal.timeout(8000) },
                });
            },
        },
    ];

    function getGoogleClient() {
        if (!GoogleGenAI) throw new Error("Google Gen AI SDK is not installed.");
        return client("google", () => {
            if (googleVertex) {
                if (!googleProject) {
                    throw new Error(
                        "Google Vertex AI requires GOOGLE_CLOUD_PROJECT."
                    );
                }
                return new GoogleGenAI({
                    vertexai: true,
                    project: googleProject,
                    location: googleLocation,
                    ...(googleApiKey ? { apiKey: googleApiKey } : {}),
                });
            }
            if (!googleApiKey) {
                throw new Error("Google Gemini requires GEMINI_API_KEY or GOOGLE_API_KEY.");
            }
            return new GoogleGenAI({ apiKey: googleApiKey });
        });
    }

    function getFoundryClient() {
        if (!OpenAI) throw new Error("OpenAI SDK is not installed.");
        if (!foundryEndpoint) {
            throw new Error(
                "set AZURE_FOUNDRY_ENDPOINT (or AZURE_OPENAI_ENDPOINT) to the Microsoft Foundry endpoint."
            );
        }
        const apiKey = foundryCredential || getFoundryTokenProvider();
        return client(
            "foundry",
            () => new OpenAI({
                apiKey,
                baseURL: normalizeFoundryBaseUrl(foundryEndpoint),
                maxRetries: 0,
            })
        );
    }

    function getFoundryTokenProvider() {
        if (!DefaultAzureCredential || !getBearerTokenProvider) {
            throw new Error("@azure/identity is not installed.");
        }
        return client(
            "foundry-token",
            () => getBearerTokenProvider(
                getDefaultAzureCredential(),
                "https://ai.azure.com/.default"
            )
        );
    }

    function getDefaultAzureCredential() {
        if (!DefaultAzureCredential) throw new Error("@azure/identity is not installed.");
        return client("azure-credential", () => new DefaultAzureCredential());
    }

    async function listFoundryModels() {
        if (foundryDeployments.length) {
            return foundryDeployments.map((id) => ({ id, metadata: { id } }));
        }
        try {
            return await listFoundryDeployments({
                credential: getDefaultAzureCredential(),
                endpoint: foundryEndpoint,
                resourceId: env.AZURE_FOUNDRY_RESOURCE_ID,
                subscriptionId:
                    env.AZURE_FOUNDRY_SUBSCRIPTION_ID || env.AZURE_SUBSCRIPTION_ID,
                fetchImpl,
            });
        } catch (error) {
            throw new Error(
                `could not list deployments for ${foundryEndpoint}: ${shortError(error)}. ` +
                "Set AZURE_FOUNDRY_DEPLOYMENTS to a comma-separated deployment list, " +
                "or AZURE_FOUNDRY_RESOURCE_ID to the account's ARM resource ID."
            );
        }
    }

    async function listModels() {
        const enabled = definitions.filter((provider) => provider.enabled);
        const discovered = await Promise.allSettled(
            enabled.map(async (provider) => ({
                provider: provider.id,
                models: await provider.list(),
            }))
        );

        const models = [];
        const warnings = [];
        for (const [index, result] of discovered.entries()) {
            if (result.status === "rejected") {
                const provider = enabled[index];
                warnings.push(`${PROVIDER_LABELS[provider.id]}: ${shortError(result.reason)}`);
                continue;
            }
            const { provider, models: ids } = result.value;
            if (!ids.length) {
                warnings.push(`${PROVIDER_LABELS[provider]}: no compatible models were returned.`);
                continue;
            }
            for (const item of ids) {
                const id = typeof item === "string" ? item : item.id;
                const selection = createSelection(provider, id);
                if (typeof item !== "string") modelMetadata.set(selection.ref, item.metadata);
                models.push(selection);
            }
        }

        models.sort(
            (a, b) =>
                PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) ||
                modelPreference(a) - modelPreference(b) ||
                a.model.localeCompare(b.model)
        );

        if (!models.length) {
            const unconfigured = definitions
                .filter((provider) => !provider.enabled && provider.id !== "ollama")
                .map(providerEnvironmentHint)
                .join(", ");
            const hint = unconfigured
                ? ` Start Ollama or configure one of: ${unconfigured}.`
                : " Check the configured provider credentials.";
            throw new Error(`No models are available. ${warnings.join(" ")}${hint}`.trim());
        }

        return {
            models,
            warnings,
            configuredProviders: enabled.map((provider) => provider.id),
        };
    }

    async function streamChat({ model, messages, signal, onDelta }) {
        const selection = parseModelRef(model);
        const provider = definitions.find((candidate) => candidate.id === selection.provider);
        if (!provider || !provider.enabled) {
            throw new Error(
                `${selection.providerLabel} is not configured. Set ${providerEnvironmentHint(
                    provider || { id: selection.provider }
                )} and restart Debate Arena.`
            );
        }
        try {
            let metadata = modelMetadata.get(selection.ref);
            if (!metadata && provider.inspect) {
                metadata = await provider.inspect(selection);
                modelMetadata.set(selection.ref, metadata);
            }
            return await provider.stream(selection, { messages, signal, onDelta, metadata });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new Error(`${selection.providerLabel} request failed: ${shortError(error)}`);
        }
    }

    return {
        listModels,
        streamChat,
        resolveModel: parseModelRef,
        ollamaHost,
    };
}

async function listOllamaModels({ host, fetchImpl }) {
    const res = await fetchImpl(`${host}/api/tags`, {
        signal: AbortSignal.timeout(8000),
    }).catch((error) => {
        throw new Error(`could not reach ${host} (${shortError(error)})`);
    });
    if (!res.ok) throw new Error(`responded ${res.status} ${res.statusText}`);
    const data = await res.json();
    return (data.models || [])
        .map((model) => String(model.name || "").trim())
        .filter(Boolean);
}

async function listFoundryDeployments({
    credential,
    endpoint,
    resourceId,
    subscriptionId,
    fetchImpl,
}) {
    const token = await credential.getToken("https://management.azure.com/.default");
    if (!token?.token) throw new Error("DefaultAzureCredential returned no management token.");
    const get = (url) => armJsonGet(fetchImpl, url, token.token);

    let accountId = resourceId;
    if (!accountId) {
        const account = await findFoundryAccount({
            endpoint,
            subscriptionId,
            get,
        });
        accountId = account.id;
    }

    const deployments = await armCollection(
        `${stripTrailingSlash(accountId)}/deployments?api-version=2025-06-01`,
        get
    );
    return deployments
        .filter((deployment) =>
            !deployment.properties?.provisioningState ||
            deployment.properties.provisioningState.toLowerCase() === "succeeded"
        )
        .map((deployment) => ({
            id: String(deployment.name || "").trim(),
            metadata: deployment,
        }))
        .filter((deployment) => deployment.id)
        .sort((a, b) => a.id.localeCompare(b.id));
}

async function findFoundryAccount({ endpoint, subscriptionId, get }) {
    const endpointHost = new URL(endpoint).hostname.toLowerCase();
    const endpointAccount = endpointHost.split(".")[0];
    const subscriptionIds = subscriptionId
        ? [subscriptionId]
        : (
            await armCollection(
                "https://management.azure.com/subscriptions?api-version=2022-12-01",
                get
            )
        ).map((subscription) => subscription.subscriptionId);

    for (const id of subscriptionIds) {
        const accounts = await armCollection(
            `https://management.azure.com/subscriptions/${encodeURIComponent(id)}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-06-01`,
            get
        );
        const account = accounts.find((candidate) => {
            const accountHost = String(candidate.properties?.endpoint || "");
            const candidateHost = accountHost ? new URL(accountHost).hostname.toLowerCase() : "";
            return (
                candidate.name?.toLowerCase() === endpointAccount ||
                candidateHost === endpointHost
            );
        });
        if (account) return account;
    }

    throw new Error(`no Cognitive Services account matched host "${endpointHost}".`);
}

async function armCollection(url, get) {
    const values = [];
    let next = url;
    while (next) {
        const page = await get(next.startsWith("/") ? `https://management.azure.com${next}` : next);
        if (Array.isArray(page.value)) values.push(...page.value);
        next = page.nextLink || null;
    }
    return values;
}

async function armJsonGet(fetchImpl, url, token) {
    const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`ARM request failed (${response.status}). ${detail}`.trim());
    }
    return response.json();
}

async function listSdkModels(awaitable, filter, provider) {
    const result = await awaitable;
    const models = new Map();
    const add = (item) => {
        const id = String(item?.id || "").trim();
        if (id && filter(id) && !models.has(id)) {
            models.set(id, { id, metadata: item });
        }
    };

    if (result?.[Symbol.asyncIterator]) {
        for await (const item of result) {
            if (Array.isArray(item?.data)) {
                for (const nested of item.data) add(nested);
            } else {
                add(item);
            }
        }
    } else if (Array.isArray(result?.data)) {
        for (const item of result.data) add(item);
    } else {
        throw new Error(`${PROVIDER_LABELS[provider]} returned an unexpected model-list response.`);
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function listGoogleModels(client) {
    const pager = await client.models.list({
        config: {
            abortSignal: AbortSignal.timeout(8000),
            pageSize: 100,
            queryBase: true,
        },
    });
    const models = new Map();
    for await (const model of pager) {
        const id = googleModelId(model.name);
        const actions = Array.isArray(model.supportedActions) ? model.supportedActions : [];
        if (!id || !id.startsWith("gemini-")) continue;
        if (actions.length && !actions.includes("generateContent")) continue;
        if (/(?:embedding|image|audio|speech|tts|live|video)/i.test(id)) continue;
        models.set(id, { id, metadata: model });
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function streamOllamaChat({
    host,
    fetchImpl,
    selection,
    messages,
    signal,
    onDelta,
    maxTokens,
}) {
    const res = await fetchImpl(`${host}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: selection.model,
            messages,
            stream: true,
            think: false,
            options: { temperature: 0.8, num_predict: maxTokens },
        }),
        signal,
    });
    if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`/api/chat failed for "${selection.model}" (${res.status}). ${detail}`.trim());
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    const handleLine = async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
            event = JSON.parse(trimmed);
        } catch (error) {
            throw new Error(`received malformed streaming JSON (${shortError(error)})`);
        }
        if (event.error) throw new Error(event.error);
        const piece = event.message?.content || "";
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    };

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
            await handleLine(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
        }
    }
    buffer += decoder.decode();
    if (buffer) await handleLine(buffer);
    return full.trim();
}

async function streamAnthropicChat({
    client,
    selection,
    messages,
    signal,
    onDelta,
    maxTokens,
    metadata,
}) {
    const system = messages
        .filter((message) => message.role === "system")
        .map((message) => textContent(message.content))
        .filter(Boolean)
        .join("\n\n");
    const request = {
        model: selection.model,
        max_tokens: Math.min(
            maxTokens,
            Number.isInteger(metadata?.max_tokens) && metadata.max_tokens > 0
                ? metadata.max_tokens
                : maxTokens
        ),
        cache_control: { type: "ephemeral" },
        messages: messages
            .filter((message) => message.role !== "system")
            .map(({ role, content }) => ({ role, content: textContent(content) })),
    };
    if (system) request.system = system;
    if (supportsAdaptiveThinking(selection.model, metadata)) {
        request.thinking = { type: "adaptive" };
    }

    const stream = client.messages.stream(request, { signal });
    let full = "";
    for await (const event of stream) {
        if (event.type !== "content_block_delta" || event.delta?.type !== "text_delta") continue;
        const piece = event.delta.text || "";
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    }
    return full.trim();
}

async function streamOpenAiChat({ client, selection, messages, signal, onDelta, maxTokens }) {
    const request = {
        model: selection.model,
        messages,
        stream: true,
        max_completion_tokens: maxTokens,
    };
    if (
        selection.provider !== "foundry" &&
        !/^(?:ft:)?(?:gpt-5|o[1-9])/.test(selection.model)
    ) {
        request.temperature = 0.8;
    }
    const stream = await client.chat.completions.create(request, { signal });
    let full = "";
    for await (const chunk of stream) {
        const piece = textContent(chunk.choices?.[0]?.delta?.content);
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    }
    return full.trim();
}

async function streamMistralChat({ client, selection, messages, signal, onDelta, maxTokens }) {
    const stream = await client.chat.stream(
        {
            model: selection.model,
            messages,
            stream: true,
            maxTokens,
            temperature: 0.8,
            responseFormat: { type: "text" },
        },
        { fetchOptions: { signal } }
    );
    let full = "";
    for await (const event of stream) {
        const piece = textContent(event?.data?.choices?.[0]?.delta?.content);
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    }
    return full.trim();
}

async function streamGoogleChat({
    client,
    selection,
    messages,
    signal,
    onDelta,
    maxTokens,
    metadata,
}) {
    const systemInstruction = messages
        .filter((message) => message.role === "system")
        .map((message) => textContent(message.content))
        .filter(Boolean)
        .join("\n\n");
    const contents = messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: textContent(message.content) }],
        }));
    const outputLimit =
        Number.isInteger(metadata?.outputTokenLimit) && metadata.outputTokenLimit > 0
            ? metadata.outputTokenLimit
            : maxTokens;
    const config = {
        abortSignal: signal,
        maxOutputTokens: Math.min(maxTokens, outputLimit),
    };
    if (systemInstruction) config.systemInstruction = systemInstruction;

    const response = await client.models.generateContentStream({
        model: selection.model,
        contents,
        config,
    });
    let full = "";
    for await (const chunk of response) {
        const piece = chunk.text || "";
        if (piece) {
            full += piece;
            await onDelta(piece);
        }
    }
    return full.trim();
}

function isOpenAiChatModel(id) {
    if (/(?:embed|whisper|tts|realtime|audio|image|moderation|transcri|search|batch)/i.test(id)) {
        return false;
    }
    return /^(?:ft:)?(?:gpt-|chatgpt-|o[1-9])/i.test(id);
}

function normalizeFoundryBaseUrl(endpoint) {
    const url = String(endpoint).trim().replace(/\/+$/, "");
    if (url.endsWith("/openai/v1")) return `${url}/`;
    if (url.endsWith("/openai")) return `${url}/v1/`;
    return `${url}/openai/v1/`;
}

function googleModelId(name) {
    const parts = String(name || "").split("/").filter(Boolean);
    return parts.at(-1) || "";
}

function parseCsv(value) {
    return [...new Set(
        String(value || "")
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
    )];
}

function stripTrailingSlash(value) {
    return String(value || "").replace(/\/+$/, "");
}

function isMistralChatModel(id) {
    const model = id.replace(/^ft:/, "");
    if (/(?:^|[-_])(embed|embeddings|ocr|moderation)(?:$|[-_])/.test(model)) return false;
    return /^(?:mistral|codestral|ministral|pixtral|magistral|devstral|open-mistral|open-mixtral|mixtral)/.test(
        model
    );
}

function modelPreference(selection) {
    if (selection.provider !== "anthropic") return 0;
    if (selection.model === "claude-opus-4-8") return 0;
    if (selection.model.startsWith("claude-opus-")) return 1;
    return 2;
}

function supportsAdaptiveThinking(model, metadata) {
    if (metadata?.capabilities?.thinking?.types?.adaptive?.supported !== undefined) {
        return metadata.capabilities.thinking.types.adaptive.supported;
    }
    return (
        /^claude-opus-4-(?:6|7|8)(?:-|$)/.test(model) ||
        /^claude-sonnet-4-6(?:-|$)/.test(model)
    );
}

function textContent(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === "string") return part;
                return part?.text || part?.content || "";
            })
            .join("");
    }
    return String(content?.text || content?.content || "");
}

function argsTimeoutSignal() {
    return AbortSignal.timeout(8000);
}

function requestOptions(signal) {
    return { fetchOptions: { signal } };
}

/**
 * Reports whether the Anthropic SDK can likely resolve credentials, without
 * reading any secret. Mirrors the SDK's credential chain: explicit env
 * credentials, Workload Identity Federation env vars, or an `ant auth login`
 * profile config under the Anthropic config directory.
 */
export function hasAnthropicCredentials(env = process.env) {
    if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
    if (
        env.ANTHROPIC_FEDERATION_RULE_ID &&
        env.ANTHROPIC_ORGANIZATION_ID &&
        (env.ANTHROPIC_IDENTITY_TOKEN_FILE || env.ANTHROPIC_IDENTITY_TOKEN)
    ) {
        return true;
    }
    const configDir = anthropicConfigDir(env);
    if (!configDir) return false;
    let profile = env.ANTHROPIC_PROFILE;
    if (!profile) {
        try {
            profile = readFileSync(path.join(configDir, "active_config"), "utf8").trim();
        } catch {
            // No active_config file: the SDK falls back to the "default" profile.
        }
    }
    if (!profile || !/^[\w.-]+$/.test(profile)) profile = "default";
    return existsSync(path.join(configDir, "configs", `${profile}.json`));
}

function anthropicConfigDir(env) {
    if (env.ANTHROPIC_CONFIG_DIR) return env.ANTHROPIC_CONFIG_DIR;
    if (process.platform === "win32") {
        if (env.APPDATA) return path.join(env.APPDATA, "Anthropic");
        if (env.USERPROFILE) return path.join(env.USERPROFILE, "AppData", "Roaming", "Anthropic");
        return null;
    }
    if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "anthropic");
    if (env.HOME) return path.join(env.HOME, ".config", "anthropic");
    return null;
}

function providerEnvironmentHint(provider) {
    if (provider.id === "foundry") {
        return "AZURE_FOUNDRY_ENDPOINT (optionally with AZURE_INFERENCE_CREDENTIAL)";
    }
    if (provider.id === "anthropic") {
        return "ANTHROPIC_API_KEY (or run `ant auth login`)";
    }
    if (provider.id === "google") {
        return "GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT with Vertex AI ADC";
    }
    return provider.id === "ollama"
        ? "a running Ollama server"
        : `${provider.id.toUpperCase()}_API_KEY`;
}

function isTruthy(value) {
    return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function shortError(error) {
    const message =
        error?.error?.message ||
        error?.data?.message ||
        error?.message ||
        String(error || "Unknown provider error");
    return String(message).replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}
