import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Divider,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCheck,
  IconInfoCircle,
  IconPlugConnected,
  IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  discoverAiModels,
  getAiConfig,
  testAiProvider,
  updateAiProviderSettings,
} from "@/ee/ai/services/ai-provider-service.ts";
import { useHasFeature } from "@/ee/hooks/use-feature";
import { Feature } from "@/ee/features";
import {
  AiProviderConfig,
  AiSettingsDto,
  AiTestResult,
} from "@/ee/ai/types/ai.types.ts";

const DRIVERS = [
  { value: "openai", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "gemini", label: "Gemini" },
  { value: "ollama", label: "Ollama" },
];

const BASE_URL_PLACEHOLDERS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  "openai-compatible": "http://localhost:1234/v1",
  ollama: "http://localhost:11434",
};

export default function AiProviderSettings() {
  const { t } = useTranslation();
  const hasAccess = useHasFeature(Feature.AI);
  const queryClient = useQueryClient();

  const { data: config } = useQuery({
    queryKey: ["ai-config"],
    queryFn: getAiConfig,
  });

  const [driver, setDriver] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [completionModel, setCompletionModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [embeddingDimension, setEmbeddingDimension] = useState<
    number | string
  >("");
  const [hasApiKey, setHasApiKey] = useState(false);
  // discovery + test state
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [suggestedBaseUrl, setSuggestedBaseUrl] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<AiTestResult[] | null>(null);

  const seed = (p?: AiProviderConfig) => {
    setDriver(p?.driver || null);
    setBaseUrl(p?.baseUrl || "");
    // Server echoes the resolved value; showing it when it equals baseUrl would
    // make an unset field look configured, so only seed a genuine override.
    setEmbeddingBaseUrl(
      p?.embeddingBaseUrl && p.embeddingBaseUrl !== p.baseUrl
        ? p.embeddingBaseUrl
        : "",
    );
    setCompletionModel(p?.completionModel || "");
    setEmbeddingModel(p?.embeddingModel || "");
    setEmbeddingDimension(p?.embeddingDimension || "");
    setHasApiKey(Boolean(p?.hasApiKey));
    setApiKey("");
    setClearKey(false);
  };

  useEffect(() => {
    if (config?.provider) seed(config.provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.provider]);

  // Draft of the current form values — shared by save / test / discover so
  // "test then save" exercises exactly what will be stored.
  const draft = (): AiSettingsDto => ({
    driver: driver || undefined,
    baseUrl: baseUrl.trim(),
    embeddingBaseUrl: embeddingBaseUrl.trim(),
    // only send a key when the admin typed one; blank keeps the stored key
    apiKey: apiKey ? apiKey : undefined,
    clearApiKey: clearKey || undefined,
    completionModel: completionModel.trim(),
    embeddingModel: embeddingModel.trim(),
    embeddingDimension:
      typeof embeddingDimension === "number" ? embeddingDimension : 0,
  });

  const saveMutation = useMutation({
    mutationFn: updateAiProviderSettings,
    onSuccess: (res) => {
      seed(res.provider);
      queryClient.invalidateQueries({ queryKey: ["ai-config"] });
      notifications.show({ message: t("AI provider settings saved") });
    },
    onError: (err: any) => {
      notifications.show({
        message: err?.response?.data?.message || t("Failed to save settings"),
        color: "red",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: testAiProvider,
    onSuccess: (res) => setTestResults(res.results),
    onError: (err: any) => {
      setTestResults(null);
      notifications.show({
        message:
          err?.response?.data?.message || t("Connection test failed"),
        color: "red",
      });
    },
  });

  const modelsMutation = useMutation({
    mutationFn: discoverAiModels,
    onSuccess: (res) => {
      setModelOptions(res.models);
      setSuggestedBaseUrl(res.normalizedBaseUrl || null);
      notifications.show({
        message: t("Found {{count}} models", { count: res.models.length }),
      });
    },
    onError: (err: any) => {
      notifications.show({
        message:
          err?.response?.data?.message || t("Could not list models"),
        color: "red",
      });
    },
  });

  const handleSave = () => {
    setTestResults(null);
    saveMutation.mutate(draft());
  };

  const handleTest = () => {
    setTestResults(null);
    testMutation.mutate(draft());
  };

  const handleFetchModels = () => {
    setSuggestedBaseUrl(null);
    modelsMutation.mutate(draft());
  };

  const applySuggestedBaseUrl = () => {
    if (suggestedBaseUrl) {
      setBaseUrl(suggestedBaseUrl);
      setSuggestedBaseUrl(null);
    }
  };

  const providerReady = Boolean(
    config?.provider?.driver && config?.provider?.completionModel,
  );
  const showBaseUrlHint =
    driver === "openai-compatible" && baseUrl && !/\/v\d+$/.test(baseUrl.trim().replace(/\/+$/, ""));

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <div>
          <Text size="md" fw={500}>
            {t("AI provider")}
          </Text>
          <Text size="sm" c="dimmed">
            {t(
              "Configure the AI provider here to enable AI without editing server env or restarting. Overrides server env per field.",
            )}
          </Text>
        </div>
        <Badge color={providerReady ? "green" : "gray"} variant="light">
          {providerReady ? t("Connected") : t("Not configured")}
        </Badge>
      </Group>

      <Select
        label={t("Provider")}
        data={DRIVERS}
        value={driver}
        onChange={setDriver}
        disabled={!hasAccess}
        allowDeselect={false}
      />

      <TextInput
        label={t("Base URL")}
        placeholder={BASE_URL_PLACEHOLDERS[driver || "openai"] || ""}
        description={
          showBaseUrlHint ? t("OpenAI-compatible base URLs usually end with /v1") : undefined
        }
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.currentTarget.value)}
        disabled={!hasAccess || driver === "gemini"}
      />

      {suggestedBaseUrl && (
        <Alert
          icon={<IconInfoCircle size={16} />}
          color="yellow"
          variant="light"
          p="xs"
        >
          {t("Models were found at {{url}} instead.", {
            url: suggestedBaseUrl,
          })}{" "}
          <Anchor component="button" type="button" onClick={applySuggestedBaseUrl}>
            {t("Use this URL")}
          </Anchor>
        </Alert>
      )}

      <PasswordInput
        label={t("API key")}
        placeholder={
          hasApiKey && !clearKey
            ? t("•••• (saved — leave blank to keep)")
            : ""
        }
        description={
          clearKey
            ? t("The stored key will be removed when you save.")
            : undefined
        }
        value={apiKey}
        onChange={(e) => {
          setApiKey(e.currentTarget.value);
          if (e.currentTarget.value) setClearKey(false);
        }}
        disabled={!hasAccess || driver === "ollama"}
      />
      {hasApiKey && !clearKey && (
        <Anchor
          component="button"
          type="button"
          size="xs"
          c="red"
          onClick={() => {
            setClearKey(true);
            setApiKey("");
          }}
          disabled={!hasAccess}
        >
          {t("Remove stored key")}
        </Anchor>
      )}

      <Group grow align="flex-end">
        <Autocomplete
          label={t("Completion model")}
          placeholder="gpt-4o-mini"
          data={modelOptions}
          value={completionModel}
          onChange={setCompletionModel}
          disabled={!hasAccess}
          limit={50}
        />
        <Button
          variant="default"
          onClick={handleFetchModels}
          loading={modelsMutation.isPending}
          disabled={!hasAccess}
          style={{ flexGrow: 0 }}
        >
          {t("Fetch models")}
        </Button>
      </Group>

      <Divider my="xs" label={t("Embeddings (optional, for AI Search & Chat tools)")} />

      <TextInput
        label={t("Embedding base URL")}
        placeholder={t("Same as the base URL above")}
        description={t(
          "Only needed when the embedding model is served by a different endpoint than the completion model.",
        )}
        value={embeddingBaseUrl}
        onChange={(e) => setEmbeddingBaseUrl(e.currentTarget.value)}
        disabled={!hasAccess || driver === "gemini"}
      />

      <Group grow>
        <Autocomplete
          label={t("Embedding model")}
          placeholder="text-embedding-3-small"
          data={modelOptions}
          value={embeddingModel}
          onChange={setEmbeddingModel}
          disabled={!hasAccess}
          limit={50}
        />
        <NumberInput
          label={t("Embedding dimension")}
          placeholder="1536"
          value={embeddingDimension}
          onChange={setEmbeddingDimension}
          disabled={!hasAccess}
          allowNegative={false}
        />
      </Group>

      {testResults && (
        <Stack gap={4}>
          {testResults.map((r) => (
            <Group key={r.target} gap="xs" wrap="nowrap">
              {r.success ? (
                <IconCheck size={16} color="var(--mantine-color-green-6)" />
              ) : (
                <IconX size={16} color="var(--mantine-color-red-6)" />
              )}
              <Text size="sm" fw={500} tt="capitalize">
                {t(r.target)}
              </Text>
              <Text size="sm" c={r.success ? "dimmed" : "red"}>
                {r.message}
                {r.latencyMs > 0 && ` (${r.latencyMs}ms)`}
              </Text>
            </Group>
          ))}
        </Stack>
      )}

      <Group justify="flex-end">
        <Button
          variant="default"
          leftSection={<IconPlugConnected size={16} />}
          onClick={handleTest}
          loading={testMutation.isPending}
          disabled={!hasAccess}
        >
          {t("Test connection")}
        </Button>
        <Button
          onClick={handleSave}
          loading={saveMutation.isPending}
          disabled={!hasAccess}
        >
          {t("Save")}
        </Button>
      </Group>
    </Stack>
  );
}
